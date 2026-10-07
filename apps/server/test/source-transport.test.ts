import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { DEFAULT_USER_AGENT } from '../src/modules/settings/settings.service';
import { nodeRequest } from '../src/modules/source/node-http';
import { SourceClient } from '../src/modules/source/source-client';
import { SourceRelay, loopbackHost } from '../src/modules/source/source-relay';
import {
  CookieJar,
  StandardTransport,
  browserHeaders,
  describeRefusal,
  looksBlocked,
  type Transport,
} from '../src/modules/source/transport';

/**
 * Connexion à la source protégée par un pare-feu anti-robot : en-têtes de navigateur,
 * cookies, bascule automatique vers l'imitation de navigateur, relais local pour ffmpeg.
 */
const LISTING =
  '<html><body><pre><a href="../">../</a>\n<a href="Film%20(2020)/">Film (2020)/</a>   01-Jan-2025 10:00   -\n</pre></body></html>';
const FILE = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
}
const seen: Seen[] = [];
let server: http.Server;
let baseUrl: string;

/**
 * Faux « Cloudflare » :
 *  - /guarded/ : refuse (403, défi) les requêtes sans `sec-fetch-mode: navigate` ;
 *  - /fingerprint/ : refuse tout sauf le transport « navigateur » simulé ;
 *  - /cookie/ : dépose un cookie puis l'exige ;
 *  - /gzip/, /zstd/ : pages compressées ; /redirect/ : redirection ; /file.bin : plages d'octets.
 */
beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({ url: url.pathname, headers: request.headers });
    const challenge = () => {
      response.writeHead(403, {
        server: 'cloudflare',
        'cf-ray': '8a1b-CDG',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html',
      });
      response.end('<html><head><title>Just a moment...</title></head></html>');
    };
    if (url.pathname.startsWith('/guarded/')) {
      if (request.headers['sec-fetch-mode'] !== 'navigate') return challenge();
      return response.end(LISTING);
    }
    if (url.pathname.startsWith('/fingerprint/')) {
      if (request.headers['x-impersonated'] !== 'chrome') return challenge();
      return response.end(LISTING);
    }
    if (url.pathname === '/cookie/') {
      if (!/clearance=ok/.test(request.headers.cookie ?? '')) {
        response.writeHead(403, { 'set-cookie': 'clearance=ok; Path=/; HttpOnly' });
        return response.end('Forbidden');
      }
      return response.end(LISTING);
    }
    if (url.pathname === '/gzip/') {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' });
      return response.end(zlib.gzipSync(LISTING));
    }
    if (url.pathname === '/zstd/') {
      response.writeHead(200, { 'content-encoding': 'zstd', 'content-type': 'text/html' });
      return response.end(zlib.zstdCompressSync(LISTING));
    }
    if (url.pathname === '/redirect/') {
      response.writeHead(302, { location: '/gzip/' });
      return response.end();
    }
    if (url.pathname === '/file.bin') {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : FILE.length - 1;
        response.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${FILE.length}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
        });
        return response.end(request.method === 'HEAD' ? undefined : FILE.subarray(start, end + 1));
      }
      response.writeHead(200, { 'content-length': FILE.length, 'accept-ranges': 'bytes' });
      return response.end(request.method === 'HEAD' ? undefined : FILE);
    }
    response.writeHead(404).end();
  });
  baseUrl = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen.length = 0;
});

describe('en-têtes de navigateur', () => {
  it('sont cohérents avec l’identité Chrome choisie', () => {
    const headers = browserHeaders(DEFAULT_USER_AGENT, { kind: 'document' });
    expect(headers['sec-ch-ua']).toContain('"Google Chrome";v="141"');
    expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
    expect(headers['sec-fetch-mode']).toBe('navigate');
    expect(headers['accept-language']).toMatch(/^fr-FR/);
    expect(headers.accept).toMatch(/^text\/html/);
  });

  it('n’envoient pas d’indices clients pour Firefox, demandent les fichiers sans compression', () => {
    const firefox = browserHeaders(
      'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
      { kind: 'file', range: 'bytes=10-' },
    );
    expect(firefox['sec-ch-ua']).toBeUndefined();
    expect(firefox.accept).toBe('*/*');
    expect(firefox['accept-encoding']).toBe('identity');
    expect(firefox.range).toBe('bytes=10-');
  });
});

describe('transport standard', () => {
  const transport = new StandardTransport(() => DEFAULT_USER_AGENT, new CookieJar());

  it('envoie une vraie navigation (fetch imposerait sec-fetch-mode: cors)', async () => {
    const response = await transport.fetch(`${baseUrl}/guarded/`, { kind: 'document' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Film (2020)');
    expect(seen[0]?.headers['sec-fetch-mode']).toBe('navigate');
    expect(seen[0]?.headers['sec-fetch-dest']).toBe('document');
  });

  it('renvoie les cookies déposés par la source', async () => {
    const first = await transport.fetch(`${baseUrl}/cookie/`, { kind: 'document' });
    expect(first.status).toBe(403);
    await first.body?.cancel();
    const second = await transport.fetch(`${baseUrl}/cookie/`, { kind: 'document' });
    expect(second.status).toBe(200);
    await second.body?.cancel();
  });

  it('suit les redirections et décompresse les pages', async () => {
    const response = await transport.fetch(`${baseUrl}/redirect/`, { kind: 'document' });
    expect(response.url).toBe(`${baseUrl}/gzip/`);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toContain('Film (2020)');
  });

  it('accepte zstd comme Chrome (encodage servi par Cloudflare)', async () => {
    const response = await transport.fetch(`${baseUrl}/zstd/`, { kind: 'document' });
    expect(seen[0]?.headers['accept-encoding']).toBe('gzip, deflate, br, zstd');
    expect(await response.text()).toContain('Film (2020)');
  });

  it('transmet les plages d’octets et expose un corps stable', async () => {
    const response = await nodeRequest(`${baseUrl}/file.bin`, {
      headers: { range: 'bytes=10-19' },
    });
    expect(response.status).toBe(206);
    expect(response.body).toBe(response.body);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('abcdefghij');
  });
});

describe('analyse des refus', () => {
  it('reconnaît un défi Cloudflare, une règle de pare-feu et un refus ordinaire', () => {
    const challenge = describeRefusal(
      403,
      'Forbidden',
      new Headers({ server: 'cloudflare', 'cf-mitigated': 'challenge' }),
      '<title>Just a moment...</title>',
    );
    expect(challenge.message).toMatch(/vérification anti-robot/);
    expect(challenge.details.title).toBe('Just a moment...');

    const firewall = describeRefusal(
      403,
      'Forbidden',
      new Headers({ server: 'cloudflare' }),
      '<title>Attention Required! | Cloudflare</title><span>Error code: 1020</span>',
    );
    expect(firewall.message).toMatch(/erreur 1020/);

    const origin = describeRefusal(403, 'Forbidden', new Headers({ server: 'nginx' }), 'Nope');
    expect(origin.message).toBe('« 403 Forbidden » (serveur nginx)');
  });

  it('ne retente que les réponses de filtrage', () => {
    expect(looksBlocked({ status: 403, headers: new Headers() })).toBe(true);
    expect(looksBlocked({ status: 503, headers: new Headers({ server: 'cloudflare' }) })).toBe(
      true,
    );
    expect(looksBlocked({ status: 503, headers: new Headers({ server: 'nginx' }) })).toBe(false);
    expect(looksBlocked({ status: 404, headers: new Headers() })).toBe(false);
  });
});

describe('bascule automatique vers l’imitation de navigateur', () => {
  /** Transport « navigateur » simulé : se distingue par un en-tête que seul le faux pare-feu voit. */
  const fakeBrowser: Transport = {
    name: 'browser',
    fetch: (url, request) =>
      nodeRequest(url, {
        method: request.method,
        headers: { 'x-impersonated': 'chrome', ...(request.range ? { range: request.range } : {}) },
        signal: request.signal,
      }),
  };
  let dataDir: string;
  let container: Container;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-transport-'));
    container = createContainer(
      loadConfig({ DATA_DIR: dataDir, SOURCE_BASE_URL: baseUrl, LOG_LEVEL: 'silent' }),
      createLogger({ level: 'silent', pretty: false }),
    );
  });

  afterAll(async () => {
    await stopServices(container);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('passe par le navigateur imité quand la connexion standard est filtrée, puis s’y tient', async () => {
    const client = new SourceClient(
      container.settings,
      createLogger({ level: 'silent', pretty: false }),
      async () => fakeBrowser,
    );
    const listing = await client.list('/fingerprint/');
    expect(listing.transport).toBe('browser');
    expect(listing.entries.map((entry) => entry.name)).toEqual(['Film (2020)']);
    expect(seen.map((request) => Boolean(request.headers['x-impersonated']))).toEqual([
      false,
      true,
    ]);

    seen.length = 0;
    await client.list('/fingerprint/sub/', { force: true }).catch(() => undefined);
    expect(seen.every((request) => request.headers['x-impersonated'] === 'chrome')).toBe(true);
  });

  it('respecte le mode « standard » et explique le refus', async () => {
    await container.settings.update({ sourceConnection: 'standard' });
    const client = new SourceClient(
      container.settings,
      createLogger({ level: 'silent', pretty: false }),
      async () => fakeBrowser,
    );
    await expect(client.list('/fingerprint/')).rejects.toThrow(/vérification anti-robot/);
    expect(seen.some((request) => request.headers['x-impersonated'])).toBe(false);
    await container.settings.update({ sourceConnection: 'auto' });
  });

  it('se replie sur la connexion standard si l’imitation est indisponible', async () => {
    const client = new SourceClient(
      container.settings,
      createLogger({ level: 'silent', pretty: false }),
      async () => null,
    );
    const listing = await client.list('/guarded/');
    expect(listing.transport).toBe('standard');
    expect(listing.entries).toHaveLength(1);
  });
});

describe('relais local pour ffmpeg', () => {
  let dataDir: string;
  let container: Container;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-relay-'));
    container = createContainer(
      loadConfig({ DATA_DIR: dataDir, SOURCE_BASE_URL: baseUrl, LOG_LEVEL: 'silent' }),
      createLogger({ level: 'silent', pretty: false }),
    );
    app = await buildApp(container);
  });

  afterAll(async () => {
    await app.close();
    await stopServices(container);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('construit des URL de bouclage', () => {
    expect(loopbackHost('0.0.0.0')).toBe('127.0.0.1');
    expect(loopbackHost('::')).toBe('127.0.0.1');
    expect(loopbackHost('192.168.1.10')).toBe('192.168.1.10');
    expect(loopbackHost('::1')).toBe('[::1]');
    const relay = new SourceRelay({ host: '0.0.0.0', port: 8484 });
    expect(relay.urlFor('/movies/A b.mkv')).toMatch(
      /^http:\/\/127\.0\.0\.1:8484\/api\/internal\/source\?path=%2Fmovies%2FA\+b\.mkv&token=[0-9a-f]{48}$/,
    );
  });

  it('relaie les plages d’octets avec le bon jeton et refuse les autres', async () => {
    const url = new URL(container.relay.urlFor('/file.bin'));
    const relayed = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { range: 'bytes=0-9' },
    });
    expect(relayed.statusCode).toBe(206);
    expect(relayed.body).toBe('0123456789');
    expect(relayed.headers['content-range']).toBe(`bytes 0-9/${FILE.length}`);

    const forged = await app.inject({
      method: 'GET',
      url: `/api/internal/source?path=${encodeURIComponent('/file.bin')}&token=nope`,
    });
    expect(forged.statusCode).toBe(403);
  });
});
