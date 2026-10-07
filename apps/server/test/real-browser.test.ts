import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import {
  BrowserSession,
  type VerificationEvent,
} from '../src/modules/source/browser/browser-session';
import { locateBrowser } from '../src/modules/source/browser/locate-browser';
import {
  RealBrowserTransport,
  fingerprintFor,
} from '../src/modules/source/browser/real-browser-transport';
import { SourceClient } from '../src/modules/source/source-client';
import { CookieJar } from '../src/modules/source/transport';

/**
 * Vérification Cloudflare dans un vrai navigateur, contre un faux « Cloudflare » qui impose
 * une page de vérification JavaScript (« Just a moment… ») : le cookie `cf_clearance` n'est
 * délivré qu'au navigateur qui exécute le défi, et lié à son User-Agent.
 *
 * Nécessite un navigateur Chromium (Chrome, Edge, Brave, Chromium ; `BROWSER_PATH` pour en
 * imposer un). Sans fenêtre par défaut ; `LUMIERE_TEST_HEADFUL=1` pour l'afficher.
 */
const PLAYWRIGHT_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executable =
  locateBrowser(process.env.BROWSER_PATH ?? null) ??
  (fs.existsSync(PLAYWRIGHT_CHROMIUM) ? { name: 'Chromium', path: PLAYWRIGHT_CHROMIUM } : null);

const LISTING =
  '<html><head><title>Index of /movies/</title></head><body><pre><a href="../">../</a>\n<a href="Film%20(2020)/">Film (2020)/</a>   01-Jan-2025 10:00   -\n</pre></body></html>';
const FILE = randomBytes(1_300_000);

type Mode = 'cookie' | 'page-only';

interface FakeCloudflare {
  url: string;
  mode: Mode;
  /** User-Agent associé à chaque cookie cf_clearance délivré. */
  tokens: Map<string, string>;
  requests: Array<{ path: string; site: string | undefined; cleared: boolean }>;
  close(): void;
}

function challengePage(): string {
  return `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<div id="challenge-running">Vérification…</div>
<script>
  window._cf_chl_opt = {};
  setTimeout(async () => {
    await fetch('/cdn-cgi/challenge-platform/solve', { method: 'POST' });
    location.replace(location.pathname + '?__cf_chl_tk=ok');
  }, 300);
</script></body></html>`;
}

async function startFakeCloudflare(): Promise<FakeCloudflare> {
  const state = {
    mode: 'cookie' as Mode,
    tokens: new Map<string, string>(),
    requests: [] as FakeCloudflare['requests'],
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const userAgent = request.headers['user-agent'] ?? '';
    if (url.pathname === '/cdn-cgi/challenge-platform/solve' && request.method === 'POST') {
      const token = randomBytes(12).toString('hex');
      state.tokens.set(token, userAgent);
      response.writeHead(200, {
        'set-cookie': `cf_clearance=${token}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`,
      });
      return response.end('ok');
    }
    const token = /cf_clearance=([0-9a-f]+)/.exec(request.headers.cookie ?? '')?.[1];
    const site = request.headers['sec-fetch-site'] as string | undefined;
    let cleared = token !== undefined && state.tokens.get(token) === userAgent;
    // « page-only » : Cloudflare n'accepte le passage que depuis le navigateur lui-même.
    if (state.mode === 'page-only' && site !== 'same-origin') cleared = false;
    state.requests.push({ path: url.pathname, site, cleared });
    if (!cleared) {
      response.writeHead(403, {
        server: 'cloudflare',
        'cf-ray': '8f00-CDG',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=utf-8',
      });
      return response.end(challengePage());
    }
    if (url.pathname === '/' || url.pathname === '/movies/') {
      response.writeHead(200, { server: 'cloudflare', 'content-type': 'text/html' });
      return response.end(LISTING);
    }
    if (decodeURIComponent(url.pathname) === '/movies/Film (2020)/film.mkv') {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : FILE.length - 1;
        response.writeHead(206, {
          server: 'cloudflare',
          'content-range': `bytes ${start}-${end}/${FILE.length}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
        });
        return response.end(FILE.subarray(start, end + 1));
      }
      response.writeHead(200, { server: 'cloudflare', 'content-length': FILE.length });
      return response.end(FILE);
    }
    response.writeHead(404, { server: 'cloudflare' }).end();
  });
  const url = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  return {
    url,
    get mode() {
      return state.mode;
    },
    set mode(mode: Mode) {
      state.mode = mode;
    },
    tokens: state.tokens,
    requests: state.requests,
    close: () => server.close(),
  };
}

const silent = createLogger({ level: 'silent', pretty: false });

describe.skipIf(!executable)('vérification Cloudflare dans le navigateur', () => {
  let cloudflare: FakeCloudflare;
  let profileDir: string;
  const events: VerificationEvent[] = [];
  let session: BrowserSession;

  beforeAll(async () => {
    cloudflare = await startFakeCloudflare();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-browser-'));
    session = new BrowserSession({
      profileDir,
      locate: () => executable,
      logger: silent,
      onEvent: (event) => events.push(event),
      headless: process.env.LUMIERE_TEST_HEADFUL !== '1',
      challengeTimeoutMs: 30_000,
      readChunkBytes: 256 * 1024,
    });
  });

  afterAll(async () => {
    await session.close();
    cloudflare.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it('passe le défi dans le navigateur et récupère cookies, User-Agent et indices clients', async () => {
    const clearance = await session.verify(cloudflare.url);
    const cookie = clearance.cookies.find((entry) => entry.name === 'cf_clearance');
    expect(cookie?.httpOnly).toBe(true);
    expect(cloudflare.tokens.get(cookie?.value ?? '')).toBe(clearance.userAgent);
    expect(clearance.clientHints['sec-ch-ua']).toMatch(/"Chromium";v="\d+"/);
    expect(clearance.acceptLanguage.length).toBeGreaterThan(0);
    expect(clearance.expiresAt).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(events.map((event) => event.state)).toEqual(['opening', 'passed']);
  });

  it('réutilise le passage hors du navigateur (empreinte de la même version de Chrome)', async () => {
    cloudflare.mode = 'cookie';
    const transport = new RealBrowserTransport(session, new CookieJar(), silent);
    const listing = await transport.fetch(`${cloudflare.url}/movies/`, { kind: 'document' });
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain('Film (2020)');

    const part = await transport.fetch(`${cloudflare.url}/movies/Film%20(2020)/film.mkv`, {
      kind: 'file',
      range: 'bytes=1000-1999',
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(FILE.subarray(1000, 2000))).toBe(true);
    // Aucune requête depuis la page : le navigateur peut être refermé.
    expect(cloudflare.requests.at(-1)?.site).toBe('none');
  });

  it('fait les requêtes depuis la page quand Cloudflare refuse le passage ailleurs', async () => {
    cloudflare.mode = 'page-only';
    const transport = new RealBrowserTransport(session, new CookieJar(), silent, {
      renewCooldownMs: 0,
    });
    const listing = await transport.fetch(`${cloudflare.url}/movies/`, { kind: 'document' });
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain('Film (2020)');

    const whole = await transport.fetch(`${cloudflare.url}/movies/Film%20(2020)/film.mkv`, {
      kind: 'file',
    });
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(FILE)).toBe(true);

    const part = await transport.fetch(`${cloudflare.url}/movies/Film%20(2020)/film.mkv`, {
      kind: 'file',
      range: 'bytes=500000-',
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(
      `bytes 500000-${FILE.length - 1}/${FILE.length}`,
    );
    expect(Buffer.from(await part.arrayBuffer()).equals(FILE.subarray(500000))).toBe(true);

    // Lecture interrompue (avance rapide) : le flux de la page est libéré.
    const cancelled = await transport.fetch(`${cloudflare.url}/movies/Film%20(2020)/film.mkv`, {
      kind: 'file',
    });
    const reader = cancelled.body!.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    await reader.cancel();
  });

  it('repasse la vérification quand le passage a expiré', async () => {
    cloudflare.mode = 'cookie';
    const transport = new RealBrowserTransport(session, new CookieJar(), silent, {
      renewCooldownMs: 0,
    });
    expect((await transport.fetch(`${cloudflare.url}/`, { kind: 'document' })).status).toBe(200);
    cloudflare.tokens.clear();
    events.length = 0;
    const listing = await transport.fetch(`${cloudflare.url}/movies/`, { kind: 'document' });
    expect(listing.status).toBe(200);
    expect(events.map((event) => event.state)).toEqual(['opening', 'passed']);
  });

  it('choisit l’empreinte impit de la version de Chrome du navigateur', () => {
    expect(fingerprintFor('Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36')).toBe('chrome136');
    expect(fingerprintFor('Mozilla/5.0 … Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0')).toBe(
      'chrome151',
    );
    expect(fingerprintFor('Mozilla/5.0 … Chrome/90.0.0.0')).toBe('chrome100');
    expect(fingerprintFor('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Firefox/140.0')).toBe(
      'chrome',
    );
  });
});

describe.skipIf(!executable)('client de la source en mode automatique', () => {
  let cloudflare: FakeCloudflare;
  let dataDir: string;
  let container: Container;

  beforeAll(async () => {
    cloudflare = await startFakeCloudflare();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-auto-'));
    container = createContainer(
      loadConfig({ DATA_DIR: dataDir, SOURCE_BASE_URL: cloudflare.url, LOG_LEVEL: 'silent' }),
      silent,
    );
  });

  afterAll(async () => {
    await stopServices(container);
    cloudflare.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('passe de la requête standard à l’imitation, puis au navigateur réel, et s’y tient', async () => {
    const session = new BrowserSession({
      profileDir: path.join(dataDir, 'navigateur'),
      locate: () => executable,
      logger: silent,
      headless: process.env.LUMIERE_TEST_HEADFUL !== '1',
      challengeTimeoutMs: 30_000,
    });
    const client = new SourceClient(container.settings, silent, {
      realBrowser: (cookies) => new RealBrowserTransport(session, cookies, silent),
    });
    try {
      const listing = await client.list('/movies/');
      expect(listing.transport).toBe('real-browser');
      expect(listing.entries.map((entry) => entry.name)).toEqual(['Film (2020)']);
      cloudflare.requests.length = 0;
      const again = await client.list('/', { force: true });
      expect(again.transport).toBe('real-browser');
      // Retenu : plus d'essais standard ni d'imitation seule (requêtes sans cookie valide).
      expect(cloudflare.requests.every((entry) => entry.cleared)).toBe(true);
    } finally {
      await session.close();
    }
  });
});
