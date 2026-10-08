import { UpstreamError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { normalizeLanguageCode } from '../../domain/media-files';

/**
 * Client de l'API REST d'OpenSubtitles.com (v1). Une clé d'API (gratuite, créée depuis son
 * compte : « API consumers ») est obligatoire ; un compte (identifiant et mot de passe)
 * relève le nombre de téléchargements autorisés par jour.
 *
 *   GET  /subtitles?imdb_id=…&languages=fr,en&moviehash=…   recherche (gratuite)
 *   POST /download { file_id }                              lien de téléchargement (compté)
 *   POST /login { username, password }                      jeton de session
 */

export interface OpenSubtitlesQuery {
  kind: 'movie' | 'series';
  /** Identifiant IMDb du film, ou de la série pour un épisode (« tt… »). */
  imdbId: string | null;
  tmdbId: number | null;
  season: number | null;
  episode: number | null;
  /** Codes ISO 639-1. */
  languages: string[];
  hash: string | null;
  /** Recherche par nom quand le titre n'est pas identifié. */
  query: string | null;
}

export interface OpenSubtitlesHit {
  fileId: number;
  language: string | null;
  release: string | null;
  fileName: string | null;
  downloads: number;
  hashMatch: boolean;
  hearingImpaired: boolean;
  foreignPartsOnly: boolean;
  machineTranslated: boolean;
}

interface RawSubtitle {
  attributes?: {
    language?: string;
    release?: string;
    download_count?: number;
    moviehash_match?: boolean;
    hearing_impaired?: boolean;
    foreign_parts_only?: boolean;
    machine_translated?: boolean;
    ai_translated?: boolean;
    files?: Array<{ file_id?: number; file_name?: string }>;
  };
}

interface LoginInfo {
  token: string;
  baseUrl: string;
  remaining: number | null;
  expiresAt: number;
}

export interface OpenSubtitlesOptions {
  baseUrl: string;
  apiKey: () => string | null;
  credentials: () => { username: string; password: string } | null;
  /** Nom et version de l'application, exigés par OpenSubtitles (« Lumiere v1.0.0 »). */
  userAgent: string;
  logger: Logger;
}

const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_TTL_MS = 12 * 3600_000;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const OFFICIAL_HOST = 'api.opensubtitles.com';

/** Identifiant IMDb sous la forme attendue par l'API : nombre sans « tt » ni zéros initiaux. */
export function numericImdbId(imdbId: string | null): string | null {
  const digits = /^tt0*(\d+)$/i.exec(imdbId?.trim() ?? '')?.[1];
  return digits ?? null;
}

/**
 * Paramètres de recherche, triés et en minuscules : OpenSubtitles redirige les requêtes dont
 * les paramètres ne le sont pas.
 */
export function searchParams(query: OpenSubtitlesQuery): URLSearchParams {
  const params: Record<string, string> = {
    languages: [...new Set(query.languages)].sort().join(','),
    type: query.kind === 'series' ? 'episode' : 'movie',
  };
  const imdb = numericImdbId(query.imdbId);
  const isEpisode = query.kind === 'series' && query.season !== null && query.episode !== null;
  // Épisode sans numéros connus : l'identifiant de la série désignerait tous ses épisodes.
  const byId = query.kind === 'movie' || isEpisode;
  if (isEpisode) {
    params.season_number = String(query.season);
    params.episode_number = String(query.episode);
  }
  if (byId && imdb) params[isEpisode ? 'parent_imdb_id' : 'imdb_id'] = imdb;
  else if (byId && query.tmdbId !== null)
    params[isEpisode ? 'parent_tmdb_id' : 'tmdb_id'] = String(query.tmdbId);
  else if (query.query) params.query = query.query.toLowerCase();
  if (query.hash) params.moviehash = query.hash;
  const sorted = new URLSearchParams();
  for (const key of Object.keys(params).sort()) sorted.set(key, params[key] as string);
  return sorted;
}

export class OpenSubtitlesClient {
  private login: LoginInfo | null = null;
  private loginKey = '';

  constructor(private readonly options: OpenSubtitlesOptions) {}

  get enabled(): boolean {
    return this.options.apiKey() !== null;
  }

  async search(query: OpenSubtitlesQuery): Promise<OpenSubtitlesHit[]> {
    const response = await this.request(`/subtitles?${searchParams(query).toString()}`, {
      method: 'GET',
    });
    const data = (await response.json()) as { data?: RawSubtitle[] };
    const hits: OpenSubtitlesHit[] = [];
    for (const entry of data.data ?? []) {
      const attributes = entry.attributes ?? {};
      const file = attributes.files?.[0];
      if (typeof file?.file_id !== 'number') continue;
      hits.push({
        fileId: file.file_id,
        language: normalizeLanguageCode(attributes.language),
        release: attributes.release?.trim() || null,
        fileName: file.file_name ?? null,
        downloads: attributes.download_count ?? 0,
        hashMatch: attributes.moviehash_match === true,
        hearingImpaired: attributes.hearing_impaired === true,
        foreignPartsOnly: attributes.foreign_parts_only === true,
        machineTranslated:
          attributes.machine_translated === true || attributes.ai_translated === true,
      });
    }
    return hits;
  }

  /** Télécharge un fichier de sous-titres (compte dans le quota quotidien d'OpenSubtitles). */
  async download(fileId: number): Promise<{ data: Buffer; fileName: string | null }> {
    const response = await this.request(
      '/download',
      { method: 'POST', body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }) },
      { authenticated: true },
    ).catch((error: unknown) => {
      const status = error instanceof UpstreamError ? error.upstreamStatus : null;
      if ((status === 401 || status === 403) && !this.options.credentials()) {
        throw new UpstreamError(
          'OpenSubtitles demande un compte pour télécharger : renseignez identifiant et mot de passe (Paramètres → Sous-titres en ligne).',
          status,
        );
      }
      throw error;
    });
    const info = (await response.json()) as {
      link?: string;
      file_name?: string;
      remaining?: number;
    };
    if (!info.link)
      throw new UpstreamError('OpenSubtitles n’a pas fourni de lien de téléchargement.');
    if (this.login && typeof info.remaining === 'number') this.login.remaining = info.remaining;
    const file = await fetch(info.link, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!file.ok) throw new UpstreamError(`Téléchargement OpenSubtitles refusé (${file.status}).`);
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length > MAX_SUBTITLE_BYTES)
      throw new UpstreamError('Fichier de sous-titres trop volumineux.');
    return { data, fileName: info.file_name ?? null };
  }

  /** Vérifie la clé (et le compte s'il est renseigné) ; message à afficher. */
  async test(): Promise<string> {
    if (this.options.credentials()) {
      const login = await this.ensureLogin(true);
      return login?.remaining !== null && login?.remaining !== undefined
        ? `Clé et compte valides · ${login.remaining} téléchargement(s) restant(s) aujourd’hui.`
        : 'Clé et compte valides.';
    }
    await this.search({
      kind: 'movie',
      imdbId: 'tt1254207',
      tmdbId: null,
      season: null,
      episode: null,
      languages: ['en'],
      hash: null,
      query: null,
    });
    return 'Clé valide (sans compte, OpenSubtitles limite les téléchargements quotidiens).';
  }

  private async ensureLogin(force = false): Promise<LoginInfo | null> {
    const credentials = this.options.credentials();
    if (!credentials) {
      this.login = null;
      return null;
    }
    const key = `${this.options.apiKey() ?? ''}\n${credentials.username}\n${credentials.password}`;
    if (!force && this.login && this.loginKey === key && this.login.expiresAt > Date.now())
      return this.login;
    const response = await this.request('/login', {
      method: 'POST',
      body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    });
    const data = (await response.json()) as {
      token?: string;
      base_url?: string;
      user?: { remaining_downloads?: number };
    };
    if (!data.token) throw new UpstreamError('Connexion à OpenSubtitles refusée.');
    // Les comptes VIP reçoivent leur propre serveur ; une adresse personnalisée (tests) est gardée.
    const official = new URL(this.options.baseUrl).host === OFFICIAL_HOST;
    const host = data.base_url?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.login = {
      token: data.token,
      baseUrl: official && host ? `https://${host}/api/v1` : this.options.baseUrl,
      remaining: data.user?.remaining_downloads ?? null,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    };
    this.loginKey = key;
    return this.login;
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
    options: { authenticated?: boolean; retried?: boolean } = {},
  ): Promise<Response> {
    const apiKey = this.options.apiKey();
    if (!apiKey) throw new UpstreamError('Aucune clé d’API OpenSubtitles configurée.');
    const login = options.authenticated ? await this.ensureLogin() : null;
    const headers: Record<string, string> = {
      'api-key': apiKey,
      'user-agent': this.options.userAgent,
      accept: 'application/json',
    };
    if (init.body) headers['content-type'] = 'application/json';
    if (login) headers.authorization = `Bearer ${login.token}`;
    let response: Response;
    try {
      response = await fetch(`${login?.baseUrl ?? this.options.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`OpenSubtitles injoignable : ${errorMessage(error)}`);
    }
    if (response.ok) return response;
    const message = await response
      .json()
      .then((body: unknown) => (body as { message?: string } | null)?.message ?? null)
      .catch(() => null);
    // Jeton expiré : une nouvelle connexion, une seule fois.
    if (response.status === 401 && login && !options.retried) {
      this.login = null;
      return this.request(path, init, { ...options, retried: true });
    }
    this.options.logger.debug({ path, status: response.status, message }, 'Refus d’OpenSubtitles');
    throw new UpstreamError(describeFailure(response.status, message), response.status);
  }
}

function describeFailure(status: number, message: string | null): string {
  if (status === 401 || status === 403) {
    return message && /token|login|credentials|password|username/i.test(message)
      ? `Compte OpenSubtitles refusé (${message}).`
      : 'Clé d’API OpenSubtitles refusée.';
  }
  if (status === 406 || status === 407)
    return `Quota quotidien de téléchargements OpenSubtitles atteint${message ? ` (${message})` : ''} : renseignez un compte ou réessayez demain.`;
  if (status === 429)
    return 'OpenSubtitles limite le nombre de requêtes : réessayez dans un instant.';
  return `OpenSubtitles a répondu ${status}${message ? ` (${message})` : ''}.`;
}
