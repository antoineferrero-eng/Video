import { PAGE_ENCODINGS, nodeRequest } from './node-http';

/**
 * Transport HTTP vers la source.
 *
 * Beaucoup d'index de fichiers sont servis derrière Cloudflare, qui refuse (403) les clients
 * qui ne ressemblent pas à un navigateur. Trois transports sont donc disponibles :
 *   - « standard » : requête HTTP(S) de Node.js avec les en-têtes d'une navigation Chrome ;
 *   - « browser » : la bibliothèque `impit`, qui imite aussi l'empreinte réseau de Chrome
 *     (poignée de main TLS, HTTP/2, ordre des en-têtes), invisible au niveau des en-têtes ;
 *   - « real-browser » : le navigateur de l'utilisateur passe la vérification Cloudflare
 *     (« Just a moment… »), puis Lumière réutilise ce passage (voir browser/).
 * En mode automatique, le client de la source passe au suivant quand l'un est bloqué.
 */

export type TransportName = 'standard' | 'browser' | 'real-browser';

export interface SourceRequest {
  /** Page de listing (navigation) ou fichier (téléchargement, lecture). */
  kind: 'document' | 'file';
  method?: 'GET' | 'HEAD';
  range?: string;
  signal?: AbortSignal;
}

/** Sous-ensemble de `Response` commun à `fetch` et à `impit`. */
export interface SourceResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Transport {
  readonly name: TransportName;
  fetch(url: string, request: SourceRequest): Promise<SourceResponse>;
  /** Oublie l'état propre à la source (changement d'adresse ou de mode). */
  reset?(): void;
}

/** Bocal à cookies minimal (par hôte) : Cloudflare dépose des cookies qu'un navigateur renvoie. */
export class CookieJar {
  private readonly hosts = new Map<string, Map<string, string>>();

  store(url: string, setCookie: string): void {
    const pair = setCookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) return;
    const host = new URL(url).hostname;
    const cookies = this.hosts.get(host) ?? new Map<string, string>();
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = /max-age=0\b/i.test(setCookie) || /expires=thu, 01 jan 1970/i.test(setCookie);
    if (expired) cookies.delete(name);
    else cookies.set(name, value);
    this.hosts.set(host, cookies);
  }

  header(url: string): string {
    const cookies = this.hosts.get(new URL(url).hostname);
    return cookies ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : '';
  }

  clear(): void {
    this.hosts.clear();
  }
}

const CHROME_VERSION = /\bChrome\/(\d+)/;

/**
 * En-têtes d'une requête de navigateur cohérents avec l'identité (User-Agent) choisie :
 * indices clients `sec-ch-ua` pour Chrome/Edge, métadonnées `sec-fetch-*`, langues.
 * (`fetch` de Node.js, lui, envoie `sec-fetch-mode: cors` et `accept-language: *`, une
 * signature de robot que les pare-feu applicatifs repèrent facilement.)
 */
export function browserHeaders(
  userAgent: string,
  request: Pick<SourceRequest, 'kind' | 'range'>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const chrome = CHROME_VERSION.exec(userAgent)?.[1];
  if (chrome && !/\bFirefox\//.test(userAgent)) {
    const edge = /\bEdg\//.test(userAgent);
    const mobile = /\bMobile\b/.test(userAgent);
    const platform = /Windows/.test(userAgent)
      ? 'Windows'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : 'Linux';
    headers['sec-ch-ua'] = edge
      ? `"Microsoft Edge";v="${chrome}", "Not?A_Brand";v="8", "Chromium";v="${chrome}"`
      : `"Google Chrome";v="${chrome}", "Not?A_Brand";v="8", "Chromium";v="${chrome}"`;
    headers['sec-ch-ua-mobile'] = mobile ? '?1' : '?0';
    headers['sec-ch-ua-platform'] = `"${platform}"`;
  }
  headers['upgrade-insecure-requests'] = '1';
  headers['user-agent'] = userAgent;
  headers.accept =
    request.kind === 'document'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
      : '*/*';
  headers['sec-fetch-site'] = 'none';
  headers['sec-fetch-mode'] = 'navigate';
  headers['sec-fetch-user'] = '?1';
  headers['sec-fetch-dest'] = 'document';
  // Un fichier est demandé tel quel : la compression fausserait les plages d'octets.
  headers['accept-encoding'] = request.kind === 'document' ? PAGE_ENCODINGS : 'identity';
  headers['accept-language'] = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';
  headers.priority = 'u=0, i';
  if (request.range) headers.range = request.range;
  return headers;
}

/**
 * Requête HTTP(S) de Node.js avec des en-têtes de navigateur et un bocal à cookies.
 * (Pas `fetch` : il remplacerait `sec-fetch-mode: navigate` par `cors`.)
 */
export class StandardTransport implements Transport {
  readonly name = 'standard' as const;

  constructor(
    private readonly userAgent: () => string,
    private readonly cookies: CookieJar,
  ) {}

  fetch(url: string, request: SourceRequest): Promise<SourceResponse> {
    return nodeRequest(url, {
      method: request.method ?? 'GET',
      headers: browserHeaders(this.userAgent(), request),
      signal: request.signal,
      decompress: request.kind === 'document',
      cookieFor: (target) => this.cookies.header(target),
      onSetCookie: (target, cookie) => this.cookies.store(target, cookie),
    });
  }
}

interface ImpitClient {
  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<SourceResponse>;
}

/**
 * Imitation complète de Chrome via `impit` (binaire natif précompilé pour Windows, macOS et
 * Linux). Chargé à la demande : si le module est absent ou incompatible, ce transport est
 * simplement indisponible.
 */
export class BrowserTransport implements Transport {
  readonly name = 'browser' as const;

  private constructor(private readonly client: ImpitClient) {}

  static async load(cookies: CookieJar): Promise<BrowserTransport | null> {
    try {
      const { Impit } = await import('impit');
      const client = new Impit({
        browser: 'chrome',
        followRedirects: true,
        cookieJar: {
          setCookie: (cookie: string, url: string) => cookies.store(url, cookie),
          getCookieString: (url: string) => cookies.header(url),
        },
      });
      return new BrowserTransport(client as unknown as ImpitClient);
    } catch {
      return null;
    }
  }

  fetch(url: string, request: SourceRequest): Promise<SourceResponse> {
    const headers: Record<string, string> = {};
    if (request.kind === 'file') {
      headers.accept = '*/*';
      headers['accept-encoding'] = 'identity';
    }
    if (request.range) headers.range = request.range;
    return this.client.fetch(url, {
      method: request.method ?? 'GET',
      headers,
      signal: request.signal,
    });
  }
}

/** Réponse typique d'un filtrage anti-robot (à retenter avec l'imitation de navigateur). */
export function looksBlocked(response: Pick<SourceResponse, 'status' | 'headers'>): boolean {
  if (response.status === 403) return true;
  // 503 : ancienne forme du défi Cloudflare (« Just a moment… »).
  if (response.status !== 503) return false;
  return (
    response.headers.has('cf-mitigated') || /cloudflare/i.test(response.headers.get('server') ?? '')
  );
}

/** Réponse servie par Cloudflare (seul cas où passer par le vrai navigateur peut aider). */
export function servedByCloudflare(response: Pick<SourceResponse, 'headers'>): boolean {
  const { headers } = response;
  return (
    headers.has('cf-ray') ||
    headers.has('cf-mitigated') ||
    /cloudflare/i.test(headers.get('server') ?? '')
  );
}

export interface BlockDiagnosis {
  /** Message en français destiné à l'utilisateur. */
  message: string;
  details: Record<string, string | number | null>;
}

/**
 * Explique un refus de la source à partir du statut, des en-têtes et du début du corps :
 * défi Cloudflare, règle de pare-feu (codes 10xx), refus de l'origine…
 */
export function describeRefusal(
  status: number,
  statusText: string,
  headers: Headers,
  bodyStart: string,
): BlockDiagnosis {
  const server = headers.get('server');
  const cloudflare = /cloudflare/i.test(server ?? '') || headers.has('cf-ray');
  const title = /<title[^>]*>([^<]{0,160})<\/title>/i.exec(bodyStart)?.[1]?.trim() ?? null;
  const code = /error(?:\s+code)?[:\s]+(10\d\d)\b/i.exec(bodyStart)?.[1] ?? null;
  const details = {
    status,
    server,
    cfRay: headers.get('cf-ray'),
    cfMitigated: headers.get('cf-mitigated'),
    title,
    cloudflareCode: code,
  };
  const base = `« ${status} ${statusText} »`;
  let message: string;
  if (
    headers.get('cf-mitigated') === 'challenge' ||
    /just a moment|cf-chl|challenge-platform|cf_chl_opt/i.test(bodyStart)
  ) {
    message = `${base} : Cloudflare exige une vérification anti-robot (« Just a moment… ») que seul un vrai navigateur peut passer`;
  } else if (code === '1020') {
    message = `${base} : Cloudflare a bloqué la requête (erreur 1020, règle de pare-feu du site)`;
  } else if (code === '1010') {
    message = `${base} : Cloudflare a refusé la signature du client (erreur 1010)`;
  } else if (code) {
    message = `${base} : Cloudflare a bloqué la requête (erreur ${code})`;
  } else if (cloudflare && status === 403) {
    message = `${base} renvoyé via Cloudflare (filtrage des robots ou refus du site)`;
  } else {
    message = `${base}${server ? ` (serveur ${server})` : ''}`;
  }
  return { message, details };
}
