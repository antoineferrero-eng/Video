import { createHash } from 'node:crypto';
import { InFlight } from '../../../core/async';
import { BadRequestError, NotFoundError, UpstreamError, errorMessage } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { KeyValueCache } from '../../../infra/database/database';
import type { SettingsService } from '../../settings/settings.service';
import { BrowserTransport, CookieJar, type Transport } from '../transport';
import { parseVirtualPath, safeFileName, virtualFilePath, type AddonKind } from './virtual-path';

/**
 * Client d'une extension Stremio (protocole « addon ») : l'extension reçoit l'identifiant
 * d'un film ou d'un épisode et renvoie des liens de lecture directs. C'est le canal que
 * 111477 propose pour ses fichiers (st.111477.xyz) : ses liens sont faits pour des lecteurs
 * vidéo ordinaires, là où les pages du site exigent une vérification de navigateur.
 *
 *   GET <base>/manifest.json                      description de l'extension
 *   GET <base>/stream/movie/tt1677720.json        liens d'un film
 *   GET <base>/stream/series/tt0903747:1:3.json   liens d'un épisode (saison 1, épisode 3)
 *
 * Les liens sont limités (chez 111477, chaque lien généré consomme un jeton d'une réserve
 * propre à l'adresse IP) : ils ne sont demandés qu'au moment d'une action (ouverture d'un
 * film, lecture ou téléchargement d'un épisode) et les réponses sont gardées en base, pour
 * être réutilisées jusqu'à ce qu'un lien soit refusé.
 */

export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  types: string[];
  resources: Array<string | { name: string; types?: string[]; idPrefixes?: string[] }>;
  idPrefixes?: string[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean };
}

interface StreamEntry {
  url?: string;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: {
    filename?: string;
    videoSize?: number;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

export interface AddonFile {
  /** Chemin virtuel stable (voir virtual-path.ts). */
  path: string;
  fileName: string;
  size: number | null;
  /** Description donnée par l'extension (serveur, qualité, taille…). */
  label: string | null;
}

export interface AddonLink {
  url: string;
  /** En-têtes que l'extension demande d'envoyer avec le lien. */
  headers: Record<string, string>;
}

export interface AddonQuery {
  kind: AddonKind;
  /** Identifiant compris par l'extension (« tt… » ou « tmdb:… »). */
  id: string;
  season?: number | null;
  episode?: number | null;
}

export interface AddonResult {
  files: AddonFile[];
  /** Message de l'extension (limite atteinte…), sinon null. */
  notice: string | null;
  /** L'extension signale que sa limite de liens est atteinte (ou presque). */
  limited: boolean;
}

/** Réponse gardée en base : fichiers, et lien actuel de chacun. */
interface StoredResult extends AddonResult {
  links: Record<string, AddonLink>;
}

const MANIFEST_TTL_MS = 60 * 60_000;
/** Réponse complète : gardée longtemps, un lien refusé déclenche une nouvelle demande. */
const RESULT_TTL_MS = 12 * 3600_000;
/** Réponse vide ou limitée : redemandée rapidement. */
const SHORT_TTL_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Messages d'une extension qui signalent une limite plutôt qu'un fichier. */
const LIMIT_NOTICE =
  /rate.?limit|slow down|too many requests|limite de (requêtes|liens)|quota (atteint|exceeded|reached)/i;

/**
 * Adresse du manifeste à partir de ce que l'utilisateur colle : lien d'installation
 * `stremio://…`, adresse de configuration, ou manifeste complet. Chaîne vide : désactivé.
 */
export function normalizeAddonUrl(input: string): string {
  let value = input.trim();
  if (!value) return '';
  value = value.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError(`Adresse d’extension invalide : ${input}`);
  }
  if (!url.pathname.endsWith('/manifest.json')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/manifest.json`;
  }
  url.hash = '';
  return url.toString();
}

function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/manifest\.json$/, '');
}

function requestId(query: AddonQuery): string {
  return query.kind === 'series' && query.season !== null && query.season !== undefined
    ? `${query.id}:${query.season}:${query.episode ?? 1}`
    : query.id;
}

/**
 * Identifiant à envoyer à l'extension, selon les préfixes qu'elle accepte : IMDb (« tt… »,
 * la convention de Stremio), ou « tmdb:… » si elle le déclare. Null si elle ne peut pas
 * chercher ce titre (mieux vaut ne rien demander que gaspiller un lien).
 */
export function contentIdFor(
  manifest: AddonManifest,
  ids: { imdb: string | null; tmdb: number | null },
): string | null {
  const stream = manifest.resources.find(
    (resource) => (typeof resource === 'string' ? resource : resource.name) === 'stream',
  );
  if (!stream) return null;
  const prefixes =
    (typeof stream === 'object' ? stream.idPrefixes : undefined) ?? manifest.idPrefixes ?? [];
  if (
    ids.imdb &&
    (prefixes.length === 0 || prefixes.some((prefix) => ids.imdb?.startsWith(prefix)))
  )
    return ids.imdb;
  if (ids.tmdb !== null && prefixes.some((prefix) => prefix.startsWith('tmdb')))
    return `tmdb:${ids.tmdb}`;
  return null;
}

function validateManifest(data: unknown): AddonManifest {
  const value = data as Partial<AddonManifest> | null;
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.types)
  ) {
    throw new UpstreamError(
      'Cette adresse ne décrit pas une extension Stremio (manifest.json invalide).',
    );
  }
  return { version: '?', ...value } as AddonManifest;
}

/** Taille annoncée dans le texte d'un lien (« 💾 2.1 GB », « 1,4 Go »). */
export function parseSize(text: string): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(T[BoiB]*|G[BoiB]*|M[BoiB]*|K[BoiB]*)\b/i.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1].replace(',', '.'));
  const unit = match[2][0]?.toUpperCase();
  const factor =
    unit === 'T' ? 1024 ** 4 : unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : 1024;
  return Number.isFinite(value) ? Math.round(value * factor) : null;
}

function lastSegment(value: string): string | null {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Pas une URL : on garde la valeur telle quelle.
  }
  const segment = pathname.split('/').filter(Boolean).pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Nom du fichier d'un lien : paramètre `u=` (lien relayé) ou dernier segment de l'adresse. */
export function fileNameFromUrl(link: string): string | null {
  try {
    const url = new URL(link);
    for (const key of ['u', 'url', 'file', 'path']) {
      const inner = url.searchParams.get(key);
      const name = inner ? lastSegment(inner) : null;
      if (name && /\.[a-z0-9]{2,4}$/i.test(name)) return name;
    }
    const name = lastSegment(url.pathname);
    return name && /\.[a-z0-9]{2,4}$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

export class StremioAddon {
  private manifestCache: { url: string; at: number; manifest: AddonManifest } | null = null;
  private readonly inflight = new InFlight<string, StoredResult>();
  private impersonation: Promise<Transport | null> | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly cache: KeyValueCache,
    private readonly logger: Logger,
    private readonly loadImpersonation: (
      cookies: CookieJar,
    ) => Promise<Transport | null> = BrowserTransport.load,
  ) {
    settings.onChange((next, previous) => {
      if (next.stremioAddonUrl !== previous.stremioAddonUrl) this.manifestCache = null;
    });
  }

  get manifestUrl(): string {
    return this.settings.get().stremioAddonUrl;
  }

  get enabled(): boolean {
    return this.manifestUrl !== '';
  }

  async manifest(options: { force?: boolean } = {}): Promise<AddonManifest> {
    const url = this.manifestUrl;
    if (!url)
      throw new UpstreamError(
        'Aucune extension Stremio configurée (Paramètres → Extension Stremio).',
      );
    const cached = this.manifestCache;
    if (!options.force && cached?.url === url && Date.now() - cached.at < MANIFEST_TTL_MS) {
      return cached.manifest;
    }
    const manifest = validateManifest(await this.getJson(url));
    this.manifestCache = { url, at: Date.now(), manifest };
    return manifest;
  }

  /** Manifeste d'une adresse quelconque (test depuis les paramètres, sans l'enregistrer). */
  async inspect(input: string): Promise<{ manifestUrl: string; manifest: AddonManifest }> {
    const manifestUrl = normalizeAddonUrl(input);
    if (!manifestUrl) throw new BadRequestError('Adresse d’extension vide.');
    return { manifestUrl, manifest: validateManifest(await this.getJson(manifestUrl)) };
  }

  /** Identifiant d'un titre pour l'extension (null si elle ne gère pas ce type de titre). */
  async contentId(
    kind: AddonKind,
    ids: { imdb: string | null; tmdb: number | null },
  ): Promise<string | null> {
    const manifest = await this.manifest();
    if (!manifest.types.includes(kind)) return null;
    return contentIdFor(manifest, ids);
  }

  /** Clé en base d'une demande (l'adresse du manifeste porte la configuration de l'extension). */
  private cacheKey(query: AddonQuery): string {
    const config = createHash('sha1').update(this.manifestUrl).digest('hex').slice(0, 12);
    return `stremio:${config}:${query.kind}:${requestId(query)}`;
  }

  private load(query: AddonQuery, force: boolean): Promise<StoredResult> {
    const key = this.cacheKey(query);
    if (!force) {
      const stored = this.cache.get<StoredResult>(key);
      if (stored) return Promise.resolve(stored);
    }
    return this.inflight.run(key, () => this.fetchFiles(query, key));
  }

  /** Fichiers proposés pour un film ou un épisode (réponse gardée en base). */
  async files(query: AddonQuery, options: { force?: boolean } = {}): Promise<AddonResult> {
    const { files, notice, limited } = await this.load(query, options.force ?? false);
    return { files, notice, limited };
  }

  /** Lien actuel d'un fichier désigné par son chemin virtuel (nouvelle demande si besoin). */
  async resolve(path: string, options: { refresh?: boolean } = {}): Promise<AddonLink> {
    const ref = parseVirtualPath(path);
    if (!ref?.fileName) throw new NotFoundError(`Chemin d’extension invalide : ${path}`);
    const query = { kind: ref.kind, id: ref.id, season: ref.season, episode: ref.episode };
    let stored = await this.load(query, options.refresh ?? false);
    if (!stored.links[path] && !options.refresh) stored = await this.load(query, true);
    const link = stored.links[path];
    if (!link) {
      throw new NotFoundError(
        (stored.limited && stored.notice) ||
          'L’extension ne propose plus ce fichier (version retirée ?).',
      );
    }
    return link;
  }

  private async fetchFiles(query: AddonQuery, key: string): Promise<StoredResult> {
    const id = requestId(query);
    const url = `${addonBase(this.manifestUrl)}stream/${query.kind}/${encodeURIComponent(id)}.json`;
    const data = (await this.getJson(url)) as { streams?: StreamEntry[] } | null;
    const entries = Array.isArray(data?.streams) ? data.streams : [];
    const files: AddonFile[] = [];
    const links: Record<string, AddonLink> = {};
    const notices: string[] = [];
    const seen = new Set<string>();
    let limited = false;
    for (const entry of entries) {
      const text = [entry.name, entry.title, entry.description]
        .filter(Boolean)
        .join(' · ')
        .replace(/\s+/g, ' ')
        .trim();
      const hinted =
        entry.behaviorHints?.filename ?? (entry.url ? fileNameFromUrl(entry.url) : null);
      if (LIMIT_NOTICE.test(text)) {
        limited = true;
        notices.push(text);
        // Avertissement seul (pas un fichier) : rien à proposer.
        if (!hinted) continue;
      }
      if (!entry.url || !/^https?:\/\//i.test(entry.url)) {
        if (text) notices.push(text);
        continue;
      }
      const firstLine = (entry.title ?? entry.description ?? '').split('\n')[0]?.trim();
      const fileName = safeFileName(hinted ?? (firstLine || 'video.mkv'));
      // Description sans le nom du fichier (déjà affiché à côté).
      const label = [entry.name, entry.title, entry.description]
        .flatMap((field) => (field ?? '').split('\n'))
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line && !line.toLowerCase().includes(fileName.toLowerCase()))
        .join(' · ');
      // Le même fichier peut être proposé sur plusieurs serveurs : un seul suffit.
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      const path = virtualFilePath({
        kind: query.kind,
        id: query.id,
        season: query.season ?? null,
        episode: query.episode ?? null,
        fileName,
      });
      files.push({
        path,
        fileName,
        size: entry.behaviorHints?.videoSize ?? parseSize(text),
        label: label || null,
      });
      links[path] = {
        url: entry.url,
        headers: entry.behaviorHints?.proxyHeaders?.request ?? {},
      };
    }
    const raw = notices.length > 0 ? [...new Set(notices)].join(' · ').slice(0, 300) : null;
    const result: StoredResult = {
      files,
      notice: limited
        ? `L’extension a atteint sa limite de liens : réessayez dans quelques minutes (« ${raw} »).`
        : raw,
      limited,
      links,
    };
    this.cache.set(key, result, files.length > 0 && !limited ? RESULT_TTL_MS : SHORT_TTL_MS);
    this.logger.info(
      { id, files: files.length, notice: result.notice },
      'Liens obtenus de l’extension Stremio',
    );
    return result;
  }

  private impersonationTransport(): Promise<Transport | null> {
    this.impersonation ??= this.loadImpersonation(new CookieJar());
    return this.impersonation;
  }

  /** Requête JSON vers l'extension ; imitation de Chrome si l'extension refuse la première. */
  private async getJson(url: string): Promise<unknown> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let status: number;
    let text: string;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
      status = response.status;
      text = await response.text();
      if (status === 403 || status === 503) {
        const impit = await this.impersonationTransport();
        if (impit) {
          const retry = await impit.fetch(url, { kind: 'document', signal });
          status = retry.status;
          text = await retry.text();
        }
      }
    } catch (error) {
      throw new UpstreamError(`Extension Stremio injoignable : ${errorMessage(error)}`);
    }
    if (status === 429) {
      throw new UpstreamError(
        'L’extension Stremio limite le nombre de requêtes : réessayez dans quelques minutes.',
        429,
      );
    }
    if (status < 200 || status >= 300) {
      throw new UpstreamError(`L’extension Stremio a répondu ${status}.`, status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      const title = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(text)?.[1]?.trim();
      throw new UpstreamError(
        `L’extension Stremio n’a pas renvoyé de données${title ? ` (page « ${title} »)` : ''}.`,
      );
    }
  }
}
