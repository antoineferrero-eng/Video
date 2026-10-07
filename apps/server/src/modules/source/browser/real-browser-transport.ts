import { isAbortError } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { CookieJar, SourceRequest, SourceResponse, Transport } from '../transport';
import { domainMatches, type BrowserSession, type Clearance } from './browser-session';

interface ImpitClient {
  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<SourceResponse>;
}

export type ImpitFactory = (options: {
  browser: string;
  cookieJar: {
    setCookie: (cookie: string, url: string) => void;
    getCookieString: (url: string) => string;
  };
}) => ImpitClient;

/** Empreintes Chrome disponibles dans impit (version de Chrome reproduite). */
const IMPIT_CHROME_VERSIONS = [100, 101, 104, 107, 110, 116, 124, 125, 131, 136, 142, 151];

/** Empreinte TLS/HTTP2 d'impit la plus proche de la version du navigateur réel. */
export function fingerprintFor(userAgent: string): string {
  const major = Number(/\bChrome\/(\d+)/.exec(userAgent)?.[1] ?? Number.NaN);
  if (!Number.isFinite(major)) return 'chrome';
  const candidates = IMPIT_CHROME_VERSIONS.filter((version) => version <= major);
  return `chrome${candidates.at(-1) ?? IMPIT_CHROME_VERSIONS[0]}`;
}

/** Une vérification Cloudflare en cours (et non un simple refus du serveur). */
export function isChallenge(response: Pick<SourceResponse, 'headers'>): boolean {
  return response.headers.get('cf-mitigated') === 'challenge';
}

async function loadImpit(): Promise<ImpitFactory | null> {
  try {
    const { Impit } = await import('impit');
    return (options) =>
      new Impit({
        browser: options.browser as 'chrome',
        followRedirects: true,
        cookieJar: options.cookieJar,
      }) as unknown as ImpitClient;
  } catch {
    return null;
  }
}

/** Délai minimal entre deux vérifications d'une même origine (évite les boucles). */
const RENEW_COOLDOWN_MS = 60_000;

/**
 * Transport « navigateur réel » : la vérification Cloudflare est passée dans le navigateur
 * de l'utilisateur, puis réutilisée.
 *   1. Requêtes impit avec les cookies, le User-Agent et les indices clients du navigateur
 *      (et l'empreinte TLS de sa version de Chrome) : rapide, le navigateur peut être fermé.
 *   2. Si Cloudflare refuse ce passage hors du navigateur, les requêtes sont faites depuis
 *      la page elle-même (fenêtre réduite), fichiers compris.
 */
export class RealBrowserTransport implements Transport {
  readonly name = 'real-browser' as const;
  private readonly clearances = new Map<string, Clearance>();
  /** Origines où seules les requêtes faites par la page passent. */
  private readonly pageOnly = new Set<string>();
  private readonly renewedAt = new Map<string, number>();
  private impit: Promise<ImpitFactory | null> | null = null;
  private readonly clients = new Map<string, ImpitClient>();
  private readonly impitLoader: () => Promise<ImpitFactory | null>;
  private readonly renewCooldownMs: number;

  constructor(
    private readonly session: BrowserSession,
    private readonly cookies: CookieJar,
    private readonly logger: Logger,
    options: { impitLoader?: () => Promise<ImpitFactory | null>; renewCooldownMs?: number } = {},
  ) {
    this.impitLoader = options.impitLoader ?? loadImpit;
    this.renewCooldownMs = options.renewCooldownMs ?? RENEW_COOLDOWN_MS;
  }

  /** Oublie les passages obtenus (changement de source). */
  reset(): void {
    this.clearances.clear();
    this.pageOnly.clear();
    this.renewedAt.clear();
  }

  async fetch(url: string, request: SourceRequest): Promise<SourceResponse> {
    const origin = new URL(url).origin;
    let clearance = await this.clearanceFor(origin);

    if (!this.pageOnly.has(origin)) {
      let response = await this.fetchWithClearance(url, request, clearance);
      if (response && isChallenge(response) && this.canRenew(origin)) {
        // Le passage a peut-être expiré : nouvelle vérification, puis nouvel essai.
        await response.body?.cancel().catch(() => undefined);
        clearance = await this.renew(origin);
        response = await this.fetchWithClearance(url, request, clearance);
      }
      if (response && !isChallenge(response)) {
        // Un 403 juste après la vérification peut venir du filtrage de l'empreinte : la page
        // le dira. Plus tard (navigateur fermé), c'est simplement la réponse du site.
        if (response.status !== 403 || !this.session.isOpen) {
          if (this.pageOnly.size === 0) this.session.closeSoon();
          return response;
        }
      }
      // Refus hors du navigateur : la page, elle, passe-t-elle ?
      const viaPage = await this.fromPage(origin, url, request);
      if (!response) {
        this.enterPageMode(origin, 'imitation de navigateur indisponible');
        return viaPage;
      }
      if (viaPage.ok || isChallenge(response)) {
        await response.body?.cancel().catch(() => undefined);
        this.enterPageMode(origin, 'Cloudflare refuse le passage hors du navigateur');
        return viaPage;
      }
      // Même refus depuis la page : c'est la réponse du site.
      await viaPage.body?.cancel().catch(() => undefined);
      return response;
    }
    return this.fromPage(origin, url, request);
  }

  private enterPageMode(origin: string, reason: string): void {
    if (this.pageOnly.has(origin)) return;
    this.pageOnly.add(origin);
    this.logger.warn({ origin, reason }, 'Les requêtes vers la source passent par le navigateur');
    void this.session.keepForPages(origin);
  }

  /** Requête faite par la page ; une vérification expirée est repassée une fois. */
  private async fromPage(
    origin: string,
    url: string,
    request: SourceRequest,
  ): Promise<SourceResponse> {
    let response: SourceResponse | null = null;
    try {
      response = await this.session.pageFetch(origin, url, request);
      if (!isChallenge(response)) return response;
    } catch (error) {
      if (request.signal?.aborted && isAbortError(error)) throw error;
      // Fenêtre fermée ou onglet perdu : une nouvelle vérification rouvre la source.
      if (!this.canRenew(origin)) throw error;
    }
    if (response && !this.canRenew(origin)) return response;
    await response?.body?.cancel().catch(() => undefined);
    await this.renew(origin);
    if (this.pageOnly.has(origin)) void this.session.keepForPages(origin);
    return this.session.pageFetch(origin, url, request);
  }

  private canRenew(origin: string): boolean {
    return Date.now() - (this.renewedAt.get(origin) ?? 0) > this.renewCooldownMs;
  }

  private async clearanceFor(origin: string): Promise<Clearance> {
    const known = this.clearances.get(origin);
    if (known && (known.expiresAt === null || known.expiresAt > Date.now() + 5_000)) return known;
    return this.renew(origin);
  }

  private async renew(origin: string): Promise<Clearance> {
    this.renewedAt.set(origin, Date.now());
    const clearance = await this.session.verify(origin);
    this.clearances.set(origin, clearance);
    return clearance;
  }

  /**
   * Requête impit présentée comme le navigateur qui a passé la vérification (null si impit
   * est indisponible). Utilisée aussi par le diagnostic.
   */
  async fetchWithClearance(
    url: string,
    request: SourceRequest,
    clearance: Clearance,
  ): Promise<SourceResponse | null> {
    this.clearances.set(clearance.origin, clearance);
    const client = await this.clientFor(clearance.userAgent);
    if (!client) return null;
    const headers: Record<string, string> = {
      'user-agent': clearance.userAgent,
      'accept-language': clearance.acceptLanguage,
      ...clearance.clientHints,
    };
    if (request.kind === 'file') {
      headers.accept = '*/*';
      headers['accept-encoding'] = 'identity';
    }
    if (request.range) headers.range = request.range;
    return client.fetch(url, { method: request.method ?? 'GET', headers, signal: request.signal });
  }

  private async clientFor(userAgent: string): Promise<ImpitClient | null> {
    const browser = fingerprintFor(userAgent);
    const existing = this.clients.get(browser);
    if (existing) return existing;
    this.impit ??= this.impitLoader();
    const factory = await this.impit;
    if (!factory) return null;
    const client = factory({
      browser,
      cookieJar: {
        setCookie: (cookie, target) => this.cookies.store(target, cookie),
        getCookieString: (target) => this.cookieHeader(target),
      },
    });
    this.clients.set(browser, client);
    return client;
  }

  /** Cookies du navigateur applicables à l'URL, complétés par ceux reçus depuis. */
  cookieHeader(target: string): string {
    const url = new URL(target);
    const merged = new Map<string, string>();
    for (const clearance of this.clearances.values()) {
      for (const cookie of clearance.cookies) {
        if (!domainMatches(url.hostname, cookie.domain)) continue;
        if (!url.pathname.startsWith(cookie.path || '/')) continue;
        if (cookie.secure && url.protocol !== 'https:') continue;
        merged.set(cookie.name, cookie.value);
      }
    }
    for (const pair of this.cookies.header(target).split('; ')) {
      const separator = pair.indexOf('=');
      if (separator > 0) merged.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}
