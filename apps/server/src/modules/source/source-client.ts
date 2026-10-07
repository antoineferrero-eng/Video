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
import { joinRemote, normalizeDirPath, normalizeRemotePath } from './remote-path';

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

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {
    settings.onChange((next, previous) => {
      if (next.sourceBaseUrl !== previous.sourceBaseUrl || next.userAgent !== previous.userAgent) {
        this.listings.clear();
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

  private async fetchListing(dirPath: string): Promise<DirectoryListing> {
    const url = this.urlFor(dirPath);
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`Source injoignable (${url}) : ${errorMessage(error)}`);
    }
    if (response.status === 404) {
      throw new NotFoundError(`Dossier introuvable sur la source : ${dirPath}`);
    }
    if (!response.ok) {
      throw new UpstreamError(
        `La source a répondu « ${response.status} ${response.statusText} » pour ${dirPath}`,
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
        ms: Date.now() - started,
      },
      'Listing distant récupéré',
    );
    return {
      path: dirPath,
      url,
      format: parsed.format,
      fetchedAt: Date.now(),
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
  ): Promise<Response> {
    const url = this.urlFor(remotePath);
    const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: '*/*' };
    if (options.range) {
      headers.range = options.range;
    } else if (options.start !== undefined || options.end !== undefined) {
      headers.range = `bytes=${options.start ?? 0}-${options.end ?? ''}`;
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
      return await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        signal,
        redirect: 'follow',
      });
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
