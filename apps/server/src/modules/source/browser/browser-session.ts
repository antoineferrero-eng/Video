import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { SourceRequest, SourceResponse } from '../transport';
import { CdpConnection } from './cdp';
import type { BrowserExecutable } from './locate-browser';

/**
 * Vrai navigateur (Chrome, Edge, Brave…) piloté par le protocole DevTools, pour les sources
 * dont Cloudflare exige une vérification que seul un navigateur peut passer
 * (page « Just a moment… »).
 *
 * Le navigateur est lancé normalement, dans un profil dédié et sans aucun mode
 * « automatisation » : pendant la vérification, Lumière ne fait qu'observer le titre de
 * l'onglet et les cookies, sans s'attacher à la page. Une fois la vérification passée, il
 * récupère de quoi la réutiliser (cookies, User-Agent, indices clients) ou, si Cloudflare
 * refuse ce passage hors du navigateur, fait les requêtes depuis la page elle-même.
 */

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Secondes depuis l'époque Unix, -1 pour un cookie de session. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

/** Ce qu'il faut pour se présenter comme le navigateur qui a passé la vérification. */
export interface Clearance {
  origin: string;
  browser: string;
  userAgent: string;
  /** `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` tels que le navigateur les envoie. */
  clientHints: Record<string, string>;
  acceptLanguage: string;
  cookies: BrowserCookie[];
  obtainedAt: number;
  /** Expiration du cookie `cf_clearance` (ms), null s'il n'y en a pas. */
  expiresAt: number | null;
}

export type VerificationState = 'opening' | 'waiting' | 'passed' | 'failed';

export interface VerificationEvent {
  state: VerificationState;
  browser: string | null;
  message: string;
}

export class BrowserUnavailableError extends Error {}

export interface BrowserSessionOptions {
  /** Profil dédié du navigateur (cookies conservés d'un lancement à l'autre). */
  profileDir: string;
  locate: () => BrowserExecutable | null;
  logger: Logger;
  onEvent?: (event: VerificationEvent) => void;
  /** Sans fenêtre (tests uniquement : Cloudflare repère les navigateurs sans fenêtre). */
  headless?: boolean;
  /** Durée maximale d'une vérification (l'utilisateur peut devoir cocher une case). */
  challengeTimeoutMs?: number;
  /** Taille maximale d'un morceau de fichier transmis par la page. */
  readChunkBytes?: number;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface PageInfo {
  userAgent: string;
  brands: Array<{ brand: string; version: string }> | null;
  mobile: boolean;
  platform: string | null;
  languages: string[];
  challenge: boolean;
}

interface PageHandle {
  targetId: string;
  sessionId: string;
}

interface FetchResult {
  status: number;
  statusText: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
/** Délai après lequel une vérification qui n'avance pas attend sans doute un clic. */
const INTERACTIVE_AFTER_MS = 8_000;
const CHALLENGE_TITLE =
  /just a moment|un instant|einen moment|un momento|um momento|attention required|checking your browser|vérification|verifying/i;

/** Indique si un en-tête Set-Cookie ou un cookie du navigateur s'applique à cet hôte. */
export function domainMatches(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, '').toLowerCase();
  const target = host.toLowerCase();
  return target === bare || target.endsWith(`.${bare}`);
}

/** En-tête Accept-Language tel que Chrome le construit à partir de ses langues. */
export function acceptLanguageFrom(languages: string[]): string {
  const list = languages.length > 0 ? languages : ['fr-FR', 'fr'];
  return list
    .slice(0, 9)
    .map((language, index) =>
      index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`,
    )
    .join(',');
}

const PAGE_INFO = `(() => {
  const data = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    brands: data ? data.brands.map((b) => ({ brand: b.brand, version: b.version })) : null,
    mobile: data ? data.mobile : false,
    platform: data ? data.platform : null,
    languages: Array.from(navigator.languages || []),
    challenge: typeof window._cf_chl_opt !== 'undefined' ||
      Boolean(document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #challenge-body-text')),
  };
})()`;

/** Encode un Uint8Array en base64 dans la page (par tranches, pour les gros morceaux). */
const PAGE_BASE64 = `const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};`;

function isChallengeTitle(title: string): boolean {
  return CHALLENGE_TITLE.test(title);
}

/** Pendant un chargement, Chrome affiche l'adresse en guise de titre. */
function isAddressTitle(title: string, url: string): boolean {
  const bare = url.replace(/^https?:\/\//, '');
  return [url, bare, bare.replace(/\/$/, '')].includes(title);
}

export class BrowserSession {
  private cdp: CdpConnection | null = null;
  private connecting: Promise<CdpConnection> | null = null;
  private child: ChildProcess | null = null;
  private readonly verifications = new Map<string, Promise<Clearance>>();
  private readonly pages = new Map<string, Promise<PageHandle>>();
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: BrowserSessionOptions) {}

  /** Navigateur utilisable sur cette machine (null si aucun n'est installé). */
  get executable(): BrowserExecutable | null {
    return this.options.locate();
  }

  /** Passe la vérification de l'origine dans le navigateur (une seule à la fois par origine). */
  verify(origin: string): Promise<Clearance> {
    this.cancelClose();
    let running = this.verifications.get(origin);
    if (!running) {
      running = this.runVerification(origin).finally(() => this.verifications.delete(origin));
      this.verifications.set(origin, running);
    }
    return running;
  }

  /** Le navigateur est-il ouvert et piloté par Lumière ? */
  get isOpen(): boolean {
    return this.cdp !== null && !this.cdp.closed;
  }

  /** Ferme le navigateur après un délai, sauf s'il sert à nouveau entre-temps. */
  closeSoon(delayMs = 15_000): void {
    if (this.closeTimer || !this.isOpen) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.verifications.size === 0) void this.close();
    }, delayMs);
    this.closeTimer.unref();
  }

  /** Garde le navigateur ouvert, fenêtre réduite, pour faire les requêtes depuis la page. */
  async keepForPages(origin: string): Promise<void> {
    this.cancelClose();
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    try {
      const { targetId } = await this.page(origin);
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', {
        targetId,
      });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch {
      // Réduire la fenêtre n'est qu'un confort.
    }
  }

  async close(): Promise<void> {
    this.cancelClose();
    const cdp = this.cdp;
    this.cdp = null;
    this.pages.clear();
    if (cdp && !cdp.closed) {
      await cdp.send('Browser.close', {}, { timeoutMs: 5_000 }).catch(() => undefined);
      cdp.close();
    }
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }

  /**
   * Requête faite par la page elle-même (cookies, empreinte et vérification du vrai
   * navigateur). Les fichiers sont lus en flux, morceau par morceau.
   */
  async pageFetch(origin: string, url: string, request: SourceRequest): Promise<SourceResponse> {
    this.cancelClose();
    const page = await this.page(origin);
    const method = request.method ?? 'GET';
    if (request.kind === 'document' || method === 'HEAD') {
      const result = await this.evaluate<FetchResult>(
        page,
        `(async () => {
          const response = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            credentials: 'include',
            cache: 'no-store',
            headers: ${JSON.stringify(request.range ? { Range: request.range } : {})},
          });
          return {
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers: [...response.headers],
            body: ${JSON.stringify(method)} === 'HEAD' ? '' : await response.text(),
          };
        })()`,
        90_000,
      );
      return toResponse(result, method === 'HEAD' ? null : (result.body ?? ''));
    }
    return this.pageStream(page, url, request);
  }

  private async pageStream(
    page: PageHandle,
    url: string,
    request: SourceRequest,
  ): Promise<SourceResponse> {
    const id = randomUUID();
    const head = await this.evaluate<FetchResult>(
      page,
      `(async () => {
        const response = await fetch(${JSON.stringify(url)}, {
          credentials: 'include',
          cache: 'no-store',
          headers: ${JSON.stringify(request.range ? { Range: request.range } : {})},
        });
        const streams = (globalThis.__lumiereStreams ??= new Map());
        if (response.body) streams.set(${JSON.stringify(id)}, response.body.getReader());
        return { status: response.status, statusText: response.statusText, url: response.url, headers: [...response.headers] };
      })()`,
      60_000,
    );
    const maxBytes = this.options.readChunkBytes ?? 4 * 1024 * 1024;
    const cancel = () =>
      this.evaluate(
        page,
        `(() => {
          const streams = globalThis.__lumiereStreams;
          const reader = streams && streams.get(${JSON.stringify(id)});
          if (reader) { reader.cancel().catch(() => {}); streams.delete(${JSON.stringify(id)}); }
          return true;
        })()`,
        5_000,
      ).catch(() => undefined);
    const signal = request.signal;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (signal?.aborted) {
          await cancel();
          controller.error(signal.reason ?? new Error('requête annulée'));
          return;
        }
        try {
          const part = await this.evaluate<{ done: boolean; body: string }>(
            page,
            `(async () => {
              ${PAGE_BASE64}
              const reader = globalThis.__lumiereStreams && globalThis.__lumiereStreams.get(${JSON.stringify(id)});
              if (!reader) throw new Error('flux introuvable dans la page');
              const chunks = [];
              let size = 0;
              let done = false;
              while (size < ${maxBytes}) {
                const next = await reader.read();
                if (next.done) { done = true; globalThis.__lumiereStreams.delete(${JSON.stringify(id)}); break; }
                chunks.push(next.value);
                size += next.value.length;
              }
              const bytes = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
              return { done, body: toBase64(bytes) };
            })()`,
            120_000,
          );
          if (part.body) controller.enqueue(Buffer.from(part.body, 'base64'));
          if (part.done) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: async () => {
        await cancel();
      },
    });
    return toResponse(head, body);
  }

  private cancelClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private emit(event: VerificationEvent): void {
    this.options.onEvent?.(event);
  }

  private async runVerification(origin: string): Promise<Clearance> {
    const executable = this.options.locate();
    if (!executable) {
      const message =
        'Cloudflare exige une vérification dans un navigateur, mais aucun navigateur Chrome, Edge, Brave ou Chromium n’a été trouvé (indiquez-en un avec la variable BROWSER_PATH)';
      this.emit({ state: 'failed', browser: null, message });
      throw new BrowserUnavailableError(message);
    }
    this.emit({
      state: 'opening',
      browser: executable.name,
      message: `Vérification Cloudflare : ouverture de ${executable.name}…`,
    });
    try {
      const { cdp, launchedTarget } = await this.connect(executable, origin);
      this.pages.delete(origin);
      const targetId =
        launchedTarget ??
        (await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${origin}/` }))
          .targetId;
      const clearance = await this.waitForPass(cdp, targetId, origin, executable);
      // Les anciens onglets de la même origine ne servent plus.
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
      for (const target of targetInfos) {
        if (target.type === 'page' && target.targetId !== targetId && target.url.startsWith(origin))
          await cdp
            .send('Target.closeTarget', { targetId: target.targetId })
            .catch(() => undefined);
      }
      this.pages.set(origin, this.attach(cdp, targetId));
      this.emit({
        state: 'passed',
        browser: executable.name,
        message: 'Vérification Cloudflare réussie',
      });
      this.options.logger.info(
        {
          origin,
          browser: executable.name,
          cookies: clearance.cookies.map((cookie) => cookie.name),
          expiresAt: clearance.expiresAt ? new Date(clearance.expiresAt).toISOString() : null,
        },
        'Vérification Cloudflare passée dans le navigateur',
      );
      return clearance;
    } catch (error) {
      const message = `La vérification Cloudflare n’a pas abouti : ${errorMessage(error)}`;
      this.emit({ state: 'failed', browser: executable.name, message });
      throw new Error(message, { cause: error });
    }
  }

  private async waitForPass(
    cdp: CdpConnection,
    targetId: string,
    origin: string,
    executable: BrowserExecutable,
  ): Promise<Clearance> {
    const host = new URL(origin).hostname;
    const started = Date.now();
    const deadline = started + (this.options.challengeTimeoutMs ?? 180_000);
    let sawChallenge = false;
    let announced = false;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
      const target = targetInfos.find((info) => info.targetId === targetId);
      if (!target) throw new Error('la fenêtre de vérification a été fermée');
      const challenged = isChallengeTitle(target.title);
      if (challenged) sawChallenge = true;
      const cookies = await this.cookiesFor(cdp, host);
      const cleared = cookies.some((cookie) => cookie.name === 'cf_clearance');
      const loaded =
        target.url.startsWith(origin) &&
        target.title.trim() !== '' &&
        !challenged &&
        !isAddressTitle(target.title, target.url);
      if (loaded && (cleared || !sawChallenge)) {
        // La page est chargée : l'inspecter ne peut plus gêner la vérification.
        const info = await this.inspect(cdp, targetId);
        if (!info.challenge) return this.toClearance(origin, executable, info, cookies);
        sawChallenge = true;
      }
      if (!announced && sawChallenge && Date.now() - started > INTERACTIVE_AFTER_MS) {
        announced = true;
        await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);
        this.emit({
          state: 'waiting',
          browser: executable.name,
          message: `Cloudflare demande une vérification : si une case « Je suis humain » apparaît dans la fenêtre ${executable.name}, cochez-la.`,
        });
      }
    }
    throw new Error('délai dépassé');
  }

  private toClearance(
    origin: string,
    executable: BrowserExecutable,
    info: PageInfo,
    cookies: BrowserCookie[],
  ): Clearance {
    const clientHints: Record<string, string> = {};
    if (info.brands) {
      clientHints['sec-ch-ua'] = info.brands
        .map((brand) => `"${brand.brand}";v="${brand.version}"`)
        .join(', ');
      clientHints['sec-ch-ua-mobile'] = info.mobile ? '?1' : '?0';
      if (info.platform) clientHints['sec-ch-ua-platform'] = `"${info.platform}"`;
    }
    const clearance = cookies.find((cookie) => cookie.name === 'cf_clearance');
    return {
      origin,
      browser: executable.name,
      userAgent: info.userAgent,
      clientHints,
      acceptLanguage: acceptLanguageFrom(info.languages),
      cookies,
      obtainedAt: Date.now(),
      expiresAt: clearance && clearance.expires > 0 ? Math.round(clearance.expires * 1000) : null,
    };
  }

  private async cookiesFor(cdp: CdpConnection, host: string): Promise<BrowserCookie[]> {
    const { cookies } = await cdp.send<{ cookies: BrowserCookie[] }>('Storage.getCookies');
    return cookies
      .filter((cookie) => domainMatches(host, cookie.domain))
      .map(({ name, value, domain, path: cookiePath, expires, secure, httpOnly }) => ({
        name,
        value,
        domain,
        path: cookiePath,
        expires,
        secure,
        httpOnly,
      }));
  }

  private async inspect(cdp: CdpConnection, targetId: string): Promise<PageInfo> {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    try {
      return await this.evaluate<PageInfo>({ targetId, sessionId }, PAGE_INFO, 10_000, cdp);
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }

  /** Onglet de l'origine auquel Lumière est attaché pour y faire des requêtes. */
  private page(origin: string): Promise<PageHandle> {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return Promise.reject(new Error('navigateur fermé'));
    let handle = this.pages.get(origin);
    if (!handle) {
      handle = (async () => {
        const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
        const target = targetInfos.find(
          (info) => info.type === 'page' && info.url.startsWith(origin),
        );
        if (!target) throw new Error('aucun onglet ouvert sur la source');
        return this.attach(cdp, target.targetId);
      })();
      this.pages.set(origin, handle);
      handle.catch(() => this.pages.delete(origin));
    }
    return handle;
  }

  private async attach(cdp: CdpConnection, targetId: string): Promise<PageHandle> {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return { targetId, sessionId };
  }

  private async evaluate<T>(
    page: PageHandle,
    expression: string,
    timeoutMs: number,
    connection: CdpConnection | null = this.cdp,
  ): Promise<T> {
    if (!connection || connection.closed) throw new Error('navigateur fermé');
    const { result, exceptionDetails } = await connection.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { sessionId: page.sessionId, timeoutMs },
    );
    if (exceptionDetails) {
      throw new Error(
        `requête dans le navigateur impossible : ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    }
    return result.value as T;
  }

  /** Connexion au navigateur : réutilise celui déjà ouvert sur le profil, sinon le lance. */
  private async connect(
    executable: BrowserExecutable,
    origin: string,
  ): Promise<{ cdp: CdpConnection; launchedTarget: string | null }> {
    if (this.cdp && !this.cdp.closed) return { cdp: this.cdp, launchedTarget: null };
    if (this.connecting) return { cdp: await this.connecting, launchedTarget: null };
    const portFile = path.join(this.options.profileDir, 'DevToolsActivePort');
    const existing = await this.attachExisting(portFile);
    if (existing) return { cdp: existing, launchedTarget: null };
    this.connecting = this.launch(executable, `${origin}/`, portFile).finally(() => {
      this.connecting = null;
    });
    const cdp = await this.connecting;
    // Le navigateur vient d'être lancé sur la source : son premier onglet sert à la vérification.
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const pages = targetInfos.filter((info) => info.type === 'page');
    const target = pages.find((info) => info.url.startsWith(origin)) ?? pages[0];
    return { cdp, launchedTarget: target?.targetId ?? null };
  }

  private async attachExisting(portFile: string): Promise<CdpConnection | null> {
    let content: string;
    try {
      content = fs.readFileSync(portFile, 'utf8');
    } catch {
      return null;
    }
    const [port, wsPath] = content.trim().split(/\r?\n/);
    if (!port || !wsPath) return null;
    try {
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`, 2_000);
      this.adopt(cdp);
      return cdp;
    } catch {
      return null;
    }
  }

  private async launch(
    executable: BrowserExecutable,
    url: string,
    portFile: string,
  ): Promise<CdpConnection> {
    fs.mkdirSync(this.options.profileDir, { recursive: true });
    fs.rmSync(portFile, { force: true });
    const args = [
      `--user-data-dir=${this.options.profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=640,780',
    ];
    if (this.options.headless) args.push('--headless=new');
    // Chrome refuse de démarrer en root sans cette option (conteneurs Linux).
    if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
    args.push(url);
    const child = spawn(executable.path, args, { stdio: 'ignore', windowsHide: false });
    this.child = child;
    const startup: { failure: Error | null } = { failure: null };
    child.once('error', (error) => {
      startup.failure = error;
    });
    child.once('exit', (code) => {
      startup.failure ??= new Error(
        `${executable.name} s’est arrêté au démarrage (code ${code ?? '?'})`,
      );
      if (this.child === child) this.child = null;
    });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startup.failure) throw startup.failure;
      const cdp = await this.attachExisting(portFile);
      if (cdp) return cdp;
      await sleep(150);
    }
    child.kill();
    throw new Error(`${executable.name} ne répond pas`);
  }

  private adopt(cdp: CdpConnection): void {
    this.cdp = cdp;
    cdp.onClose(() => {
      if (this.cdp === cdp) {
        this.cdp = null;
        this.pages.clear();
      }
    });
  }
}

function toResponse(
  result: FetchResult,
  body: string | ReadableStream<Uint8Array> | null,
): SourceResponse {
  const headers = new Headers();
  for (const [name, value] of result.headers) {
    try {
      headers.append(name, value);
    } catch {
      // En-tête invalide ignoré.
    }
  }
  const nullBody = [101, 204, 205, 304].includes(result.status);
  const response = new Response(nullBody ? null : body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    url: result.url,
    headers: response.headers,
    get body() {
      return response.body;
    },
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}
