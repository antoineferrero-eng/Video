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
import { CdnTransport, DEFAULT_CDN, type CdnOptions } from './cdn-transport';
import { parseListing, type ListingFormat } from './listing-parser';
import { joinRemote, normalizeDirPath, normalizeRemotePath } from './remote-path';
import {
  BrowserTransport,
  CookieJar,
  StandardTransport,
  describeRefusal,
  looksBlocked,
  servedByCloudflare,
  type SourceRequest,
  type SourceResponse,
  type Transport,
  type TransportName,
} from './transport';
import type { ZenRowsTransport } from './zenrows-transport';

export interface SourceClientOptions {
  /** Transport d'imitation de Chrome (impit), chargé à la première utilisation. */
  loadImpersonation?: (cookies: CookieJar) => Promise<Transport | null>;
  /** Transport « navigateur réel » (vérification Cloudflare dans le navigateur). */
  realBrowser?: ((cookies: CookieJar) => Transport) | null;
  /** Pages de listing via ZenRows (service en ligne), si une clé est configurée. */
  zenrows?: ZenRowsTransport | null;
  /** Point d'accès de lecture de 111477, en secours pour les fichiers (null : jamais). */
  cdn?: CdnOptions | null;
}

const ESCALATION_MESSAGES: Partial<Record<TransportName, string>> = {
  browser:
    'La source filtre les clients qui ne sont pas des navigateurs : imitation de Chrome activée',
  'real-browser':
    'Cloudflare exige une vérification de navigateur : passage par le navigateur de l’utilisateur activé',
  zenrows: 'Cloudflare bloque les pages de listing : elles passent désormais par ZenRows',
  cdn: 'Lien direct refusé : les fichiers passent par le point d’accès de lecture p.111477.xyz',
};

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
/** Pages payées (ZenRows) : conservées plus longtemps pour économiser des crédits. */
const PAID_LISTING_TTL_MS = 6 * 60 * 60_000;
/** Inclut le temps de passer une vérification Cloudflare dans le navigateur (≤ 3 min). */
const LISTING_TIMEOUT_MS = 240_000;
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
  private readonly realBrowser: Transport | null;
  private readonly zenrows: ZenRowsTransport | null;
  private readonly cdn: CdnTransport | null;
  /** Transport retenu par origine et type de requête, après une bascule réussie. */
  private readonly preferred = new Map<string, TransportName>();
  private impersonationMissingWarned = false;

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    options: SourceClientOptions = {},
  ) {
    this.standard = new StandardTransport(() => this.userAgent, this.cookies);
    const load = options.loadImpersonation ?? BrowserTransport.load;
    this.loadImpersonation = () => load(this.cookies);
    this.realBrowser = options.realBrowser?.(this.cookies) ?? null;
    this.zenrows = options.zenrows ?? null;
    const cdn = options.cdn === undefined ? DEFAULT_CDN : options.cdn;
    this.cdn = cdn
      ? new CdnTransport(cdn, async () => (await this.impersonationTransport()) ?? this.standard)
      : null;
    settings.onChange((next, previous) => {
      if (
        next.sourceBaseUrl !== previous.sourceBaseUrl ||
        next.userAgent !== previous.userAgent ||
        next.sourceConnection !== previous.sourceConnection
      ) {
        this.listings.clear();
        this.preferred.clear();
        this.cookies.clear();
        this.realBrowser?.reset?.();
        this.zenrows?.reset();
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
    const cacheKey = `${this.baseUrl}${dirPath}`;
    if (!options.force) {
      const cached = this.listings.get(cacheKey);
      const maxAge = options.maxAgeMs ?? this.ttlFor(cached?.transport);
      if (cached && Date.now() - cached.fetchedAt <= maxAge) {
        return cached;
      }
    }
    return this.inflight.run(cacheKey, async () => {
      const listing = await this.fetchListing(dirPath);
      this.listings.set(cacheKey, listing, this.ttlFor(listing.transport));
      return listing;
    });
  }

  private ttlFor(transport: TransportName | undefined): number {
    return transport === 'zenrows' ? PAID_LISTING_TTL_MS : LISTING_TTL_MS;
  }

  invalidate(remotePath: string): void {
    this.listings.delete(`${this.baseUrl}${normalizeDirPath(remotePath)}`);
  }

  /** Imitation de Chrome (chargée une seule fois, à la première utilisation). */
  private impersonationTransport(): Promise<Transport | null> {
    this.impersonation ??= this.loadImpersonation();
    return this.impersonation;
  }

  /**
   * Transports à essayer, dans l'ordre, selon le mode de connexion et le type de requête.
   *   - pages : standard → imitation → ZenRows (si clé) ou, à défaut, navigateur réel ;
   *   - fichiers : standard → imitation → p.111477.xyz (111477 seulement) → navigateur réel
   *     (sauf si ZenRows est configuré : le navigateur n'est alors jamais ouvert).
   */
  private async transportsFor(url: string, kind: SourceRequest['kind']): Promise<Transport[]> {
    const mode = this.settings.get().sourceConnection;
    if (mode === 'standard') return [this.standard];
    if (mode === 'real-browser') return [this.realBrowser ?? this.standard];
    const impersonation = await this.impersonationTransport();
    if (!impersonation && !this.impersonationMissingWarned) {
      this.impersonationMissingWarned = true;
      this.logger.warn(
        "Module d'imitation de navigateur (impit) indisponible sur cette plateforme",
      );
    }
    if (mode === 'browser') return [impersonation ?? this.standard];
    const zenrows = mode === 'zenrows' || this.zenrows?.configured ? this.zenrows : null;
    const chain: Array<Transport | null> = [this.standard, impersonation];
    if (kind === 'document') chain.push(zenrows ?? this.realBrowser);
    else chain.push(this.cdn?.appliesTo(url) ? this.cdn : null, zenrows ? null : this.realBrowser);
    const transports = chain.filter((transport): transport is Transport => transport !== null);
    const preferred = this.preferred.get(this.preferenceKey(url, kind));
    const start = transports.findIndex((transport) => transport.name === preferred);
    return start > 0 ? transports.slice(start) : transports;
  }

  private preferenceKey(url: string, kind: SourceRequest['kind']): string {
    return `${new URL(url).origin}|${kind}`;
  }

  /**
   * Envoie une requête à la source. Une réponse de filtrage anti-robot (403, défi
   * Cloudflare) déclenche un nouvel essai avec le transport suivant ; le navigateur réel
   * n'est sollicité que si la source est servie par Cloudflare. Le transport qui passe est
   * retenu pour la suite.
   */
  async request(
    url: string,
    request: SourceRequest,
  ): Promise<{ response: SourceResponse; transport: TransportName }> {
    const key = this.preferenceKey(url, request.kind);
    const transports = await this.transportsFor(url, request.kind);
    let cloudflare = false;
    for (const [index, transport] of transports.entries()) {
      const next = transports[index + 1];
      const response = await transport.fetch(url, request);
      cloudflare ||= servedByCloudflare(response);
      // Le point d'accès de lecture échoue autrement que par un 403 (limite, page d'erreur…).
      const blocked = transport.name === 'cdn' ? !response.ok : looksBlocked(response);
      if (next && blocked && (next.name !== 'real-browser' || cloudflare)) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (index > 0 && !blocked && this.preferred.get(key) !== transport.name) {
        this.preferred.set(key, transport.name);
        this.logger.info(
          { origin: new URL(url).origin, kind: request.kind },
          ESCALATION_MESSAGES[transport.name] ?? 'Transport changé',
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
