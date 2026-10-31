import { createHash } from 'node:crypto';
import { InFlight } from '../../../core/async';
import { BadRequestError, NotFoundError, UpstreamError, errorMessage } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { KeyValueCache } from '../../../infra/database/database';
import type { SettingsService } from '../../settings/settings.service';
import { BrowserTransport, CookieJar, type Transport } from '../transport';
import { parseVirtualPath, safeFileName, virtualFilePath, type AddonKind } from './virtual-path';

/**
 * Client des extensions Stremio (protocole « addon ») qui fournissent les fichiers : une
 * extension reçoit l'identifiant d'un film ou d'un épisode et renvoie des liens de lecture
 * directs. Plusieurs extensions peuvent être configurées, par ordre de préférence : elles
 * sont interrogées ensemble et leurs fichiers réunis (un fichier proposé par plusieurs
 * extensions garde un seul chemin, avec un lien chez chacune pour se relayer).
 *
 *   GET <base>/manifest.json                      description de l'extension
 *   GET <base>/stream/movie/tt1677720.json        liens d'un film
 *   GET <base>/stream/series/tt0903747:1:3.json   liens d'un épisode (saison 1, épisode 3)
 *
 * Les liens peuvent être limités (chez 111477, chaque lien généré consomme un jeton d'une
 * réserve propre à l'adresse IP) : ils ne sont demandés qu'au moment d'une action (ouverture
 * d'un film, lecture ou téléchargement d'un épisode) et la réponse de chaque extension est
 * gardée en base, pour être réutilisée jusqu'à ce qu'un lien soit refusé.
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

/** Fichier tel que le propose une extension. */
interface StoredFile {
  /** Chemin virtuel stable (voir virtual-path.ts). */
  path: string;
  fileName: string;
  size: number | null;
  /** Description donnée par l'extension (serveur, qualité, taille…). */
  label: string | null;
}

export interface AddonFile extends StoredFile {
  /** Extension qui propose ce fichier (la première, s'il est proposé par plusieurs). */
  addon: string;
}

export interface AddonLink {
  url: string;
  /** En-têtes que l'extension demande d'envoyer avec le lien. */
  headers: Record<string, string>;
  /** Extension qui a fourni le lien. */
  addon?: string;
}

export interface AddonQuery {
  kind: AddonKind;
  /**
   * Identifiant du titre, celui de ses chemins virtuels : IMDb (« tt… », la convention de
   * Stremio) s'il est connu, sinon « tmdb:… ».
   */
  id: string;
  /** Identifiant TMDB, pour une extension qui l'accepte mais pas l'identifiant IMDb. */
  tmdb?: number | null;
  season?: number | null;
  episode?: number | null;
}

export interface AddonResult {
  files: AddonFile[];
  /** Messages des extensions (limite atteinte, extension injoignable…), sinon null. */
  notice: string | null;
  /**
   * Une extension a atteint sa limite de liens ou n'a pas répondu : une liste vide ne veut
   * alors pas dire que le titre est absent.
   */
  limited: boolean;
}

/** Réponse d'une extension gardée en base : fichiers, et lien actuel de chacun. */
interface StoredResult {
  files: StoredFile[];
  notice: string | null;
  limited: boolean;
  links: Record<string, AddonLink>;
}

/** Extension configurée, et identifiant sous lequel elle connaît le titre demandé. */
interface Provider {
  manifestUrl: string;
  manifest: AddonManifest;
  /** Identifiant envoyé à cette extension (« tt… » ou « tmdb:… »). */
  id: string;
}

const MANIFEST_TTL_MS = 60 * 60_000;
/** Manifeste injoignable : nouvel essai après ce délai. */
const MANIFEST_ERROR_TTL_MS = 60_000;
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
 * `stremio://…`, adresse de configuration, ou manifeste complet. Chaîne vide : ignorée.
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

/** Adresses d'extensions normalisées, dans l'ordre et sans doublon (vides ignorées). */
export function normalizeAddonUrls(inputs: string[]): string[] {
  return [...new Set(inputs.map(normalizeAddonUrl).filter(Boolean))];
}

export function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/manifest\.json$/, '');
}

/** Nom court d'une extension dont le manifeste est illisible : son hôte. */
export function addonHost(manifestUrl: string): string {
  try {
    return new URL(manifestUrl).host;
  } catch {
    return manifestUrl;
  }
}

function requestId(id: string, query: AddonQuery): string {
  return query.kind === 'series' && query.season !== null && query.season !== undefined
    ? `${id}:${query.season}:${query.episode ?? 1}`
    : id;
}

/**
 * Identifiant à envoyer à une extension, selon le type de titre et les préfixes qu'elle
 * accepte : IMDb (« tt… », la convention de Stremio), ou « tmdb:… » si elle le déclare.
 * Null si elle ne peut pas chercher ce titre (mieux vaut ne rien demander que gaspiller un
 * lien).
 */
export function contentIdFor(
  manifest: AddonManifest,
  kind: AddonKind,
  ids: { imdb: string | null; tmdb: number | null },
): string | null {
  const stream = manifest.resources.find(
    (resource) => (typeof resource === 'string' ? resource : resource.name) === 'stream',
  );
  if (!stream) return null;
  const types = (typeof stream === 'object' ? stream.types : undefined) ?? manifest.types;
  if (!types.includes(kind)) return null;
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

export function validateManifest(data: unknown): AddonManifest {
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

/** Deux propositions du même nom désignent le même fichier, sauf tailles différentes. */
function sameFile(a: StoredFile, b: StoredFile): boolean {
  return a.size === null || b.size === null || a.size === b.size;
}

export interface StremioAddonsOptions {
  /** Transport d'imitation de Chrome (impit), chargé à la première utilisation. */
  loadImpersonation?: (cookies: CookieJar) => Promise<Transport | null>;
  /**
   * Identifiant TMDB d'un titre d'après l'identifiant de ses chemins virtuels : pour
   * interroger une extension qui n'accepte que « tmdb:… » quand la demande part d'un chemin.
   */
  tmdbIdOf?: (kind: AddonKind, id: string) => number | null;
}

export class StremioAddons {
  private readonly manifests = new Map<
    string,
    { at: number; manifest: AddonManifest | null; error: unknown }
  >();
  private readonly manifestRequests = new InFlight<string, AddonManifest>();
  private readonly inflight = new InFlight<string, StoredResult>();
  private impersonation: Promise<Transport | null> | null = null;
  private readonly loadImpersonation: (cookies: CookieJar) => Promise<Transport | null>;
  private readonly tmdbIdOf: (kind: AddonKind, id: string) => number | null;

  constructor(
    private readonly settings: SettingsService,
    private readonly cache: KeyValueCache,
    private readonly logger: Logger,
    options: StremioAddonsOptions = {},
  ) {
    this.loadImpersonation = options.loadImpersonation ?? BrowserTransport.load;
    this.tmdbIdOf = options.tmdbIdOf ?? (() => null);
    settings.onChange((next, previous) => {
      if (next.stremioAddonUrls.join('\n') !== previous.stremioAddonUrls.join('\n'))
        this.manifests.clear();
    });
  }

  /** Manifestes des extensions configurées, par ordre de préférence. */
  get manifestUrls(): string[] {
    return this.settings.get().stremioAddonUrls;
  }

  get enabled(): boolean {
    return this.manifestUrls.length > 0;
  }

  /** Manifeste d'une extension (gardé une heure ; un échec est gardé une minute). */
  async manifest(url: string, options: { force?: boolean } = {}): Promise<AddonManifest> {
    const cached = this.manifests.get(url);
    if (!options.force && cached) {
      const age = Date.now() - cached.at;
      if (cached.manifest && age < MANIFEST_TTL_MS) return cached.manifest;
      if (!cached.manifest && age < MANIFEST_ERROR_TTL_MS) throw cached.error;
    }
    return this.manifestRequests.run(url, async () => {
      try {
        const manifest = validateManifest(await this.getJson(url));
        this.manifests.set(url, { at: Date.now(), manifest, error: null });
        return manifest;
      } catch (error) {
        this.manifests.set(url, { at: Date.now(), manifest: null, error });
        throw error;
      }
    });
  }

  /** Manifeste d'une adresse quelconque (test depuis les paramètres, sans l'enregistrer). */
  async inspect(input: string): Promise<{ manifestUrl: string; manifest: AddonManifest }> {
    const manifestUrl = normalizeAddonUrl(input);
    if (!manifestUrl) throw new BadRequestError('Adresse d’extension vide.');
    return { manifestUrl, manifest: validateManifest(await this.getJson(manifestUrl)) };
  }

  /** Message préfixé du nom de l'extension, quand il y en a plusieurs. */
  private describe(name: string, message: string): string {
    return this.manifestUrls.length > 1 ? `${name} : ${message}` : message;
  }

  /**
   * Extensions capables de chercher ce titre, avec l'identifiant à envoyer à chacune ; les
   * extensions dont le manifeste est illisible sont signalées à part.
   */
  private async providers(
    query: AddonQuery,
  ): Promise<{ providers: Provider[]; failures: string[] }> {
    if (!this.enabled) {
      throw new UpstreamError('Aucune extension Stremio configurée (Paramètres → Sources).');
    }
    const urls = this.manifestUrls;
    const tmdb = /^tmdb:(\d+)$/.exec(query.id);
    const ids = {
      imdb: tmdb ? null : query.id,
      tmdb: tmdb ? Number(tmdb[1]) : (query.tmdb ?? null),
    };
    const outcomes = await Promise.allSettled(urls.map((url) => this.manifest(url)));
    const providers: Provider[] = [];
    const failures: string[] = [];
    outcomes.forEach((outcome, index) => {
      const manifestUrl = urls[index] as string;
      if (outcome.status === 'rejected') {
        failures.push(this.describe(addonHost(manifestUrl), errorMessage(outcome.reason)));
        return;
      }
      // Identifiant TMDB cherché seulement si une extension en a besoin.
      if (
        ids.imdb &&
        ids.tmdb === null &&
        !contentIdFor(outcome.value, query.kind, ids) &&
        contentIdFor(outcome.value, query.kind, { imdb: null, tmdb: 0 })
      ) {
        ids.tmdb = this.tmdbIdOf(query.kind, query.id);
      }
      const id = contentIdFor(outcome.value, query.kind, ids);
      if (id) providers.push({ manifestUrl, manifest: outcome.value, id });
    });
    return { providers, failures };
  }

  /**
   * Identifiant des chemins virtuels d'un titre (IMDb s'il est connu, sinon « tmdb:… »), ou
   * null si aucune extension ne peut le chercher.
   */
  async contentId(
    kind: AddonKind,
    ids: { imdb: string | null; tmdb: number | null },
  ): Promise<string | null> {
    const id = ids.imdb ?? (ids.tmdb !== null ? `tmdb:${ids.tmdb}` : null);
    if (!id) return null;
    const { providers, failures } = await this.providers({ kind, id, tmdb: ids.tmdb });
    // Extension injoignable : on ne peut pas exclure qu'elle connaisse ce titre.
    return providers.length > 0 || failures.length > 0 ? id : null;
  }

  /** Clé en base d'une demande (l'adresse du manifeste porte la configuration de l'extension). */
  private cacheKey(provider: Provider, query: AddonQuery): string {
    const config = createHash('sha1').update(provider.manifestUrl).digest('hex').slice(0, 12);
    return `stremio:${config}:${query.kind}:${requestId(provider.id, query)}`;
  }

  private load(provider: Provider, query: AddonQuery, force: boolean): Promise<StoredResult> {
    const key = this.cacheKey(provider, query);
    if (!force) {
      const stored = this.cache.get<StoredResult>(key);
      if (stored) return Promise.resolve(stored);
    }
    return this.inflight.run(key, () => this.fetchFiles(provider, query, key));
  }

  /** Fichiers proposés pour un film ou un épisode, toutes extensions réunies. */
  async files(query: AddonQuery, options: { force?: boolean } = {}): Promise<AddonResult> {
    const { providers, failures } = await this.providers(query);
    if (providers.length === 0 && failures.length === 0) {
      return {
        files: [],
        notice:
          this.manifestUrls.length > 1
            ? 'Aucune des extensions configurées ne peut chercher ce titre.'
            : 'L’extension configurée ne peut pas chercher ce titre.',
        limited: false,
      };
    }
    const outcomes = await Promise.allSettled(
      providers.map((provider) => this.load(provider, query, options.force ?? false)),
    );
    const errors = outcomes.map((outcome, index) =>
      outcome.status === 'rejected'
        ? this.describe((providers[index] as Provider).manifest.name, errorMessage(outcome.reason))
        : null,
    );
    if (outcomes.every((outcome) => outcome.status === 'rejected')) {
      // Aucune extension n'a répondu : l'erreur remonte (limite de requêtes, refus…).
      const [only] = outcomes;
      if (failures.length === 0 && outcomes.length === 1 && only?.status === 'rejected')
        throw only.reason;
      throw new UpstreamError([...failures, ...errors.filter(Boolean)].join(' · '));
    }
    const files: AddonFile[] = [];
    const notices = [...failures];
    let limited = failures.length > 0;
    outcomes.forEach((outcome, index) => {
      const name = (providers[index] as Provider).manifest.name;
      if (outcome.status === 'rejected') {
        limited = true;
        notices.push(errors[index] as string);
        return;
      }
      const stored = outcome.value;
      if (stored.notice) notices.push(this.describe(name, stored.notice));
      if (stored.limited) limited = true;
      for (const file of stored.files) {
        const existing = files.find((item) => item.path === file.path);
        if (existing) {
          existing.size ??= file.size;
          continue;
        }
        // Plusieurs extensions : leur nom distingue les fichiers (sauf s'il y figure déjà).
        const named =
          this.manifestUrls.length > 1 &&
          !(file.label ?? '').toLowerCase().includes(name.toLowerCase());
        const label = (named ? [name, file.label] : [file.label]).filter(Boolean).join(' · ');
        files.push({ ...file, label: label || null, addon: name });
      }
    });
    return {
      files,
      notice: notices.length > 0 ? notices.join(' · ').slice(0, 600) : null,
      limited,
    };
  }

  /**
   * Liens d'un fichier désigné par son chemin virtuel, par ordre de préférence des
   * extensions (nouvelle demande si aucune réponse gardée ne le contient). `refresh` : les
   * liens précédents ont été refusés, ils sont redemandés aux extensions qui les avaient
   * fournis.
   */
  async links(path: string, options: { refresh?: boolean } = {}): Promise<AddonLink[]> {
    const ref = parseVirtualPath(path);
    if (!ref?.fileName) throw new NotFoundError(`Chemin d’extension invalide : ${path}`);
    const query: AddonQuery = {
      kind: ref.kind,
      id: ref.id,
      season: ref.season,
      episode: ref.episode,
    };
    const { providers, failures } = await this.providers(query);
    if (providers.length === 0) {
      if (failures.length > 0) throw new UpstreamError(failures.join(' · '));
      throw new NotFoundError('Aucune extension configurée ne propose ce fichier.');
    }
    const collect = async (targets: Provider[], force: boolean) => {
      const outcomes = await Promise.allSettled(
        targets.map((provider) => this.load(provider, query, force)),
      );
      return outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : null));
    };
    let stored = await collect(providers, false);
    const holders = providers.filter((_, index) => stored[index]?.links[path]);
    if (options.refresh || holders.length === 0) {
      // Seules les extensions concernées sont redemandées : chaque demande peut coûter un jeton.
      const targets = holders.length > 0 ? holders : providers;
      const fresh = await collect(targets, true);
      stored = providers.map((provider, index) => {
        const position = targets.indexOf(provider);
        return (position >= 0 ? fresh[position] : null) ?? stored[index] ?? null;
      });
    }
    // Un fichier du même nom mais d'une autre taille chez une autre extension n'est pas le
    // même : ses octets ne peuvent pas prendre le relais.
    const reference = stored
      .flatMap((result) => result?.files ?? [])
      .find((file) => file.path === path);
    const links: AddonLink[] = [];
    stored.forEach((result, index) => {
      const link = result?.links[path];
      const file = result?.files.find((item) => item.path === path);
      if (!link || (reference && file && !sameFile(reference, file))) return;
      links.push({ ...link, addon: (providers[index] as Provider).manifest.name });
    });
    if (links.length === 0) {
      const limitedNotice = stored.find((result) => result?.limited && result.notice)?.notice;
      throw new NotFoundError(
        limitedNotice ||
          (this.manifestUrls.length > 1
            ? 'Aucune extension ne propose plus ce fichier (version retirée ?).'
            : 'L’extension ne propose plus ce fichier (version retirée ?).'),
      );
    }
    return links;
  }

  private async fetchFiles(
    provider: Provider,
    query: AddonQuery,
    key: string,
  ): Promise<StoredResult> {
    const id = requestId(provider.id, query);
    const url = `${addonBase(provider.manifestUrl)}stream/${query.kind}/${encodeURIComponent(id)}.json`;
    const data = (await this.getJson(url)) as { streams?: StreamEntry[] } | null;
    const entries = Array.isArray(data?.streams) ? data.streams : [];
    const files: StoredFile[] = [];
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
      // Le chemin porte l'identifiant du titre, pas celui propre à l'extension : il est le
      // même quelle que soit l'extension qui propose le fichier.
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
    if (limited) {
      // Réserve de jetons vide : les liens déjà obtenus restent utilisables tant que l'hôte
      // les accepte, plutôt que de rendre illisible un fichier en cours de lecture.
      const previous = this.cache.get<StoredResult>(key);
      for (const file of previous?.files ?? []) {
        const link = previous?.links[file.path];
        if (!link || links[file.path]) continue;
        files.push(file);
        links[file.path] = link;
      }
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
      { addon: provider.manifest.name, id, files: files.length, notice: result.notice },
      'Liens obtenus de l’extension Stremio',
    );
    return result;
  }

  private impersonationTransport(): Promise<Transport | null> {
    this.impersonation ??= this.loadImpersonation(new CookieJar());
    return this.impersonation;
  }

  /** Requête JSON vers une extension ; imitation de Chrome si l'extension refuse la première. */
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
