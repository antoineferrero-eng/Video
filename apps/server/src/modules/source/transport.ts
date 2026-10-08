/**
 * Transport HTTP vers les hôtes des liens fournis par les extensions Stremio.
 *
 * Certains hôtes sont servis derrière Cloudflare, qui refuse (403) les clients qui ne
 * ressemblent pas à un navigateur. Les liens sont donc d'abord demandés par une requête
 * Node.js ordinaire (node-http.ts), puis, en cas de refus, avec la bibliothèque `impit`, qui
 * imite l'empreinte réseau de Chrome (poignée de main TLS, HTTP/2, ordre des en-têtes).
 */

/** Identité présentée aux hôtes des liens (et par ffmpeg). */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export type TransportName = 'standard' | 'browser';

export interface SourceRequest {
  /** Document (manifeste, réponse JSON) ou fichier (téléchargement, lecture). */
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
