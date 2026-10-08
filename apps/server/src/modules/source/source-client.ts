import {
  AppError,
  NotFoundError,
  UpstreamError,
  errorMessage,
  isAbortError,
} from '../../core/errors';
import type { Logger } from '../../core/logger';
import { nodeRequest } from './node-http';
import {
  BrowserTransport,
  CookieJar,
  USER_AGENT,
  looksBlocked,
  type SourceResponse,
  type Transport,
} from './transport';
import type { AddonLink, StremioAddons } from './stremio/stremio-addon';
import { isVirtualPath } from './stremio/virtual-path';

export interface SourceClientOptions {
  /** Transport d'imitation de Chrome (impit), chargé à la première utilisation. */
  loadImpersonation?: (cookies: CookieJar) => Promise<Transport | null>;
}

export interface OpenFileOptions {
  start?: number;
  end?: number;
  /** En-tête Range brut transmis tel quel (proxy de lecture). */
  range?: string;
  signal?: AbortSignal;
  method?: 'GET' | 'HEAD';
}

const HEADERS_TIMEOUT_MS = 30_000;
/** Réponses d'un hôte qui refuse un lien (expiré, retiré, jeton épuisé…). */
const REFUSED = [401, 403, 404, 410];
/**
 * Délai minimal entre deux renouvellements des liens d'un même fichier. Chaque demande
 * consomme des jetons de la réserve de l'extension : un refus passager de l'hôte (connexions
 * simultanées pendant un positionnement…) ne doit pas la vider.
 */
const LINK_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Lecture des fichiers distants, désignés par leur chemin virtuel : leurs liens sont demandés
 * aux extensions Stremio, puis lus comme le ferait un lecteur vidéo (plages d'octets).
 */
export class SourceClient {
  private readonly cookies = new CookieJar();
  private impersonation: Promise<Transport | null> | null = null;
  private readonly loadImpersonation: () => Promise<Transport | null>;
  /** Dernier renouvellement des liens de chaque fichier. */
  private readonly linkRefreshes = new Map<string, number>();

  constructor(
    private readonly addons: StremioAddons,
    private readonly logger: Logger,
    options: SourceClientOptions = {},
  ) {
    const load = options.loadImpersonation ?? BrowserTransport.load;
    this.loadImpersonation = () => load(this.cookies);
  }

  /** Identité HTTP présentée aux hôtes des liens (et par ffmpeg). */
  get userAgent(): string {
    return USER_AGENT;
  }

  /** Imitation de Chrome (chargée une seule fois, à la première utilisation). */
  private impersonationTransport(): Promise<Transport | null> {
    this.impersonation ??= this.loadImpersonation();
    return this.impersonation;
  }

  /**
   * Ouvre une requête sur un fichier distant. Les liens proposés par les extensions sont
   * essayés dans l'ordre ; s'ils sont tous refusés (expirés), ils sont redemandés une fois.
   * Le délai d'attente ne couvre que la réception des en-têtes : le corps peut ensuite être
   * lu aussi longtemps que nécessaire.
   */
  async openFile(remotePath: string, options: OpenFileOptions = {}): Promise<SourceResponse> {
    if (!isVirtualPath(remotePath)) {
      throw new NotFoundError(
        `Fichier de l’ancienne source, plus accessible : ${remotePath}. Cherchez le titre dans le catalogue pour l’obtenir par une extension Stremio.`,
      );
    }
    if (!this.addons.enabled) {
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
    const request = { method: options.method ?? 'GET', range, signal } as const;
    try {
      const links = await this.addons.links(remotePath);
      const response = await this.tryLinks(links, request, options.signal);
      if (!REFUSED.includes(response.status) || !this.mayRefreshLink(remotePath)) return response;
      // Liens expirés ou refusés : on en demande de nouveaux aux extensions.
      await response.body?.cancel().catch(() => undefined);
      const fresh = await this.addons.links(remotePath, { refresh: true });
      return await this.tryLinks(fresh, request, options.signal);
    } catch (error) {
      if (options.signal?.aborted && isAbortError(error)) throw error;
      if (error instanceof AppError) throw error;
      throw new UpstreamError(`Lien de l’extension injoignable : ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Premier lien que son hôte accepte ; sinon la réponse (ou l'erreur) du dernier essayé.
   */
  private async tryLinks(
    links: AddonLink[],
    request: { method: 'GET' | 'HEAD'; range?: string; signal: AbortSignal },
    callerSignal: AbortSignal | undefined,
  ): Promise<SourceResponse> {
    let last: SourceResponse | null = null;
    let failure: unknown = null;
    for (const [index, link] of links.entries()) {
      if (last) await last.body?.cancel().catch(() => undefined);
      last = null;
      try {
        const response = await this.fetchLink(link, request);
        if (!REFUSED.includes(response.status)) return response;
        last = response;
      } catch (error) {
        if (callerSignal?.aborted || request.signal.aborted) throw error;
        failure = error;
      }
      if (index < links.length - 1) {
        this.logger.debug(
          { addon: link.addon, status: last?.status, err: failure && errorMessage(failure) },
          'Lien refusé : essai de l’extension suivante',
        );
      }
    }
    if (last) return last;
    throw failure ?? new UpstreamError('Aucun lien disponible pour ce fichier.');
  }

  private mayRefreshLink(remotePath: string): boolean {
    const now = Date.now();
    if (now - (this.linkRefreshes.get(remotePath) ?? 0) < LINK_REFRESH_COOLDOWN_MS) return false;
    for (const [path, at] of this.linkRefreshes) {
      if (now - at >= LINK_REFRESH_COOLDOWN_MS) this.linkRefreshes.delete(path);
    }
    this.linkRefreshes.set(remotePath, now);
    return true;
  }

  private async fetchLink(
    link: AddonLink,
    request: { method: 'GET' | 'HEAD'; range?: string; signal: AbortSignal },
  ): Promise<SourceResponse> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
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
}
