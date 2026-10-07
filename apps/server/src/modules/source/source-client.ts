import { InFlight, TtlCache } from '../../core/async';
import {
  AppError,
  NotFoundError,
  UpstreamError,
  errorMessage,
  isAbortError,
} from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { SettingsService } from '../settings/settings.service';
import { parseListing, type ListingFormat } from './listing-parser';
import { nodeRequest } from './node-http';
import { joinRemote, normalizeDirPath, normalizeRemotePath } from './remote-path';
import {
  BrowserTransport,
  CookieJar,
  StandardTransport,
  describeRefusal,
  looksBlocked,
  type SourceRequest,
  type SourceResponse,
  type Transport,
  type TransportName,
} from './transport';
import type { AddonLink, StremioAddon } from './stremio/stremio-addon';
import { isVirtualPath } from './stremio/virtual-path';

export interface SourceClientOptions {
  /** Transport d'imitation de Chrome (impit), chargé à la première utilisation. */
  loadImpersonation?: (cookies: CookieJar) => Promise<Transport | null>;
  /** Extension Stremio qui fournit les fichiers désignés par un chemin virtuel. */
  addon?: StremioAddon | null;
}

export interface RemoteEntry {
  name: string;
  /** Chemin décodé relatif à la racine de la source (slash final pour les dossiers). */
  path: string;
  isDirectory: boolean;
  size: number | null;
  modifiedAt: string | null;
}

export interface DirectoryListing {
  path: string;
  url: string;
  format: ListingFormat;
  entries: RemoteEntry[];
  fetchedAt: number;
  /** Transport qui a obtenu la page (diagnostic). */
  transport: TransportName;
}

const LISTING_TTL_MS = 10 * 60_000;
const LISTING_TIMEOUT_MS = 90_000;
const HEADERS_TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Client HTTP de la source (index de fichiers). Toutes les URL sont construites à partir
 * de l'URL de base configurée : le serveur n'agit jamais comme un proxy ouvert.
 */
export class SourceClient {
  private readonly listings = new TtlCache<string, DirectoryListing>(500, LISTING_TTL_MS);
  private readonly inflight = new InFlight<string, DirectoryListing>();
  private readonly cookies = new CookieJar();
  private readonly standard: StandardTransport;
  private impersonation: Promise<Transport | null> | null = null;
  private readonly loadImpersonation: () => Promise<Transport | null>;
  /** Origines pour lesquelles l'imitation de Chrome s'est révélée nécessaire. */
  private readonly preferred = new Map<string, TransportName>();
  private impersonationMissingWarned = false;
  private readonly addon: StremioAddon | null;

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    options: SourceClientOptions = {},
  ) {
    this.standard = new StandardTransport(() => this.userAgent, this.cookies);
    const load = options.loadImpersonation ?? BrowserTransport.load;
    this.loadImpersonation = () => load(this.cookies);
    this.addon = options.addon ?? null;
    settings.onChange((next, previous) => {
      if (
        next.sourceBaseUrl !== previous.sourceBaseUrl ||
        next.userAgent !== previous.userAgent ||
        next.sourceConnection !== previous.sourceConnection
      ) {
        this.listings.clear();
        this.preferred.clear();
        this.cookies.clear();
      }
    });
  }

  get baseUrl(): string {
    return this.settings.get().sourceBaseUrl;
  }

  get userAgent(): string {
    return this.settings.get().userAgent;
  }

  /** URL absolue (encodée) d'un chemin distant. */
  urlFor(remotePath: string): string {
    const normalized = normalizeRemotePath(remotePath);
    const base = new URL(`${this.baseUrl}/`);
    const prefix = base.pathname.replace(/\/+$/, '');
    const encoded = normalized
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return new URL(prefix + encoded, base.origin).toString();
  }

  /** Liste un dossier distant (avec cache mémoire et mutualisation des requêtes concurrentes). */
  async list(
    remotePath: string,
    options: { maxAgeMs?: number; force?: boolean } = {},
  ): Promise<DirectoryListing> {
    const dirPath = normalizeDirPath(remotePath);
    // Dossier virtuel (extension Stremio) : rien à lister, les fichiers viennent de l'extension.
    if (isVirtualPath(dirPath)) {
      return {
        path: dirPath,
        url: '',
        format: 'generic',
        entries: [],
        fetchedAt: Date.now(),
        transport: 'standard',
      };
    }
    const cacheKey = `${this.baseUrl}${dirPath}`;
    if (!options.force) {
      const cached = this.listings.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt <= (options.maxAgeMs ?? LISTING_TTL_MS)) {
        return cached;
      }
    }
    return this.inflight.run(cacheKey, async () => {
      const listing = await this.fetchListing(dirPath);
      this.listings.set(cacheKey, listing);
      return listing;
    });
  }

  invalidate(remotePath: string): void {
    this.listings.delete(`${this.baseUrl}${normalizeDirPath(remotePath)}`);
  }

  /** Imitation de Chrome (chargée une seule fois, à la première utilisation). */
  private impersonationTransport(): Promise<Transport | null> {
    this.impersonation ??= this.loadImpersonation();
    return this.impersonation;
  }

  /** Transports à essayer, dans l'ordre, selon le mode de connexion choisi. */
  private async transportsFor(origin: string): Promise<Transport[]> {
    const mode = this.settings.get().sourceConnection;
    if (mode === 'standard') return [this.standard];
    const impersonation = await this.impersonationTransport();
    if (!impersonation) {
      if (!this.impersonationMissingWarned) {
        this.impersonationMissingWarned = true;
        this.logger.warn(
          "Module d'imitation de navigateur (impit) indisponible sur cette plateforme",
        );
      }
      return [this.standard];
    }
    if (mode === 'browser' || this.preferred.get(origin) === 'browser') return [impersonation];
    return [this.standard, impersonation];
  }

  /**
   * Envoie une requête à la source. En mode automatique, une réponse de filtrage anti-robot
   * (403, défi Cloudflare) déclenche un nouvel essai en imitant Chrome ; s'il passe, il est
   * retenu pour la suite.
   */
  async request(
    url: string,
    request: SourceRequest,
  ): Promise<{ response: SourceResponse; transport: TransportName }> {
    const origin = new URL(url).origin;
    const transports = await this.transportsFor(origin);
    for (const [index, transport] of transports.entries()) {
      const last = index === transports.length - 1;
      const response = await transport.fetch(url, request);
      if (!last && looksBlocked(response)) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (index > 0 && !looksBlocked(response) && this.preferred.get(origin) !== transport.name) {
        this.preferred.set(origin, transport.name);
        this.logger.info(
          { origin },
          'La source filtre les clients qui ne sont pas des navigateurs : imitation de Chrome activée',
        );
      }
      return { response, transport: transport.name };
    }
    throw new UpstreamError('Aucun transport disponible pour joindre la source.');
  }

  private async fetchListing(dirPath: string): Promise<DirectoryListing> {
    const url = this.urlFor(dirPath);
    const started = Date.now();
    let result: { response: SourceResponse; transport: TransportName };
    try {
      result = await this.request(url, {
        kind: 'document',
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`Source injoignable (${url}) : ${errorMessage(error)}`);
    }
    const { response, transport } = result;
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new NotFoundError(`Dossier introuvable sur la source : ${dirPath}`);
    }
    if (!response.ok) {
      const bodyStart = (await response.text().catch(() => '')).slice(0, 4000);
      const diagnosis = describeRefusal(
        response.status,
        response.statusText,
        response.headers,
        bodyStart,
      );
      this.logger.warn(
        { url, transport, ...diagnosis.details },
        'Refus de la source (détails pour le diagnostic)',
      );
      throw new UpstreamError(
        `La source a répondu ${diagnosis.message} pour ${dirPath}`,
        response.status,
      );
    }
    const body = await response.text();
    const parsed = parseListing(
      body,
      new URL(response.url || url),
      response.headers.get('content-type'),
    );
    this.logger.debug(
      {
        path: dirPath,
        entries: parsed.items.length,
        format: parsed.format,
        transport,
        ms: Date.now() - started,
      },
      'Listing distant récupéré',
    );
    return {
      path: dirPath,
      url,
      format: parsed.format,
      fetchedAt: Date.now(),
      transport,
      entries: parsed.items.map((item) => ({
        ...item,
        path: joinRemote(dirPath, item.name, item.isDirectory),
      })),
    };
  }

  /**
   * Ouvre une requête sur un fichier distant. Le délai d'attente ne couvre que la réception
   * des en-têtes : le corps peut ensuite être lu aussi longtemps que nécessaire.
   */
  async openFile(
    remotePath: string,
    options: {
      start?: number;
      end?: number;
      /** En-tête Range brut transmis tel quel (proxy de lecture). */
      range?: string;
      signal?: AbortSignal;
      method?: 'GET' | 'HEAD';
    } = {},
  ): Promise<SourceResponse> {
    if (isVirtualPath(remotePath)) return this.openAddonFile(remotePath, options);
    const url = this.urlFor(remotePath);
    let range = options.range;
    if (!range && (options.start !== undefined || options.end !== undefined)) {
      range = `bytes=${options.start ?? 0}-${options.end ?? ''}`;
    }
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('délai de connexion dépassé')),
      HEADERS_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    try {
      const { response } = await this.request(url, {
        kind: 'file',
        method: options.method ?? 'GET',
        range,
        signal,
      });
      return response;
    } catch (error) {
      if (options.signal?.aborted && isAbortError(error)) throw error;
      throw new UpstreamError(`Source injoignable : ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fichier fourni par l'extension Stremio : le lien est demandé à l'extension, puis lu
   * comme le ferait un lecteur vidéo. Un lien refusé ou expiré est redemandé une fois.
   */
  private async openAddonFile(
    remotePath: string,
    options: {
      start?: number;
      end?: number;
      range?: string;
      signal?: AbortSignal;
      method?: 'GET' | 'HEAD';
    },
  ): Promise<SourceResponse> {
    const addon = this.addon;
    if (!addon?.enabled) {
      throw new UpstreamError('Aucune extension Stremio configurée pour lire ce fichier.');
    }
    let range = options.range;
    if (!range && (options.start !== undefined || options.end !== undefined)) {
      range = `bytes=${options.start ?? 0}-${options.end ?? ''}`;
    }
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('délai de connexion dépassé')),
      HEADERS_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    const method = options.method ?? 'GET';
    try {
      const link = await addon.resolve(remotePath);
      const response = await this.fetchLink(link, { method, range, signal });
      if (![401, 403, 404, 410].includes(response.status)) return response;
      // Lien expiré ou refusé : on en demande un nouveau à l'extension.
      await response.body?.cancel().catch(() => undefined);
      const fresh = await addon.resolve(remotePath, { refresh: true });
      return await this.fetchLink(fresh, { method, range, signal });
    } catch (error) {
      if (options.signal?.aborted && isAbortError(error)) throw error;
      if (error instanceof AppError) throw error;
      throw new UpstreamError(`Lien de l’extension injoignable : ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchLink(
    link: AddonLink,
    request: { method: 'GET' | 'HEAD'; range?: string; signal: AbortSignal },
  ): Promise<SourceResponse> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...link.headers,
    };
    if (request.range) headers.range = request.range;
    const response = await nodeRequest(link.url, {
      method: request.method,
      headers,
      signal: request.signal,
    });
    if (!looksBlocked(response)) return response;
    const impersonation = await this.impersonationTransport();
    if (!impersonation) return response;
    await response.body?.cancel().catch(() => undefined);
    return impersonation.fetch(link.url, {
      kind: 'file',
      method: request.method,
      range: request.range,
      signal: request.signal,
    });
  }

  /** Télécharge un petit fichier (sous-titres…) en mémoire. */
  async fetchBuffer(remotePath: string): Promise<Buffer> {
    const response = await this.openFile(remotePath);
    if (response.status === 404) throw new NotFoundError(`Fichier introuvable : ${remotePath}`);
    if (!response.ok)
      throw new UpstreamError(`La source a répondu ${response.status}`, response.status);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_TEXT_BYTES) {
      await response.body?.cancel();
      throw new AppError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux.');
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
