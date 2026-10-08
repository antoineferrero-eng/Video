import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { nodeRequest } from '../src/modules/source/node-http';
import { SourceClient } from '../src/modules/source/source-client';
import { SourceRelay, loopbackHost } from '../src/modules/source/source-relay';
import type { AddonLink, StremioAddons } from '../src/modules/source/stremio/stremio-addon';
import { looksBlocked, type Transport } from '../src/modules/source/transport';

/**
 * Lecture des liens fournis par les extensions : plages d'octets, bascule vers l'imitation de
 * navigateur quand l'hôte filtre les robots, relais entre extensions quand un lien est
 * refusé, relais local pour ffmpeg.
 */
const FILE = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const PATH = '/@stremio/movie/tt1/Film.2020.1080p.mkv';
const silent = createLogger({ level: 'silent', pretty: false });

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
}
const seen: Seen[] = [];
let server: http.Server;
let baseUrl: string;

function sendFile(request: http.IncomingMessage, response: http.ServerResponse): void {
  const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : FILE.length - 1;
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${FILE.length}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
    });
    response.end(request.method === 'HEAD' ? undefined : FILE.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { 'content-length': FILE.length, 'accept-ranges': 'bytes' });
  response.end(request.method === 'HEAD' ? undefined : FILE);
}

/**
 * Faux hôtes de liens :
 *  - /file.bin : plages d'octets ; /redirect : redirection vers /file.bin ;
 *  - /fingerprint.bin : refuse (défi Cloudflare) tout sauf le transport « navigateur » simulé ;
 *  - /expired.bin : lien expiré (410).
 */
beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({ url: url.pathname, headers: request.headers });
    if (url.pathname === '/file.bin') return sendFile(request, response);
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/file.bin' });
      return response.end();
    }
    if (url.pathname === '/fingerprint.bin') {
      if (request.headers['x-impersonated'] === 'chrome') return sendFile(request, response);
      response.writeHead(403, {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html',
      });
      return response.end('<html><head><title>Just a moment...</title></head></html>');
    }
    if (url.pathname === '/expired.bin') return response.writeHead(410).end('Gone');
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

/** Extensions simulées : des liens fixes, puis d'autres après renouvellement. */
function fakeAddons(
  first: string[],
  refreshed: string[] = first,
): StremioAddons & { refreshes: number } {
  const stub = {
    enabled: true,
    refreshes: 0,
    links: async (_path: string, options: { refresh?: boolean } = {}): Promise<AddonLink[]> => {
      if (options.refresh) stub.refreshes += 1;
      return (options.refresh ? refreshed : first).map((name, index) => ({
        url: `${baseUrl}${name}`,
        headers: {},
        addon: `Extension ${index + 1}`,
      }));
    },
  };
  return stub as unknown as StremioAddons & { refreshes: number };
}

describe('requêtes vers les hôtes des liens', () => {
  it('transmettent les plages d’octets, suivent les redirections, exposent un corps stable', async () => {
    const response = await nodeRequest(`${baseUrl}/redirect`, {
      headers: { range: 'bytes=10-19' },
    });
    expect(response.status).toBe(206);
    expect(response.url).toBe(`${baseUrl}/file.bin`);
    expect(response.body).toBe(response.body);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('abcdefghij');
  });

  it('ne retentent que les réponses de filtrage', () => {
    expect(looksBlocked({ status: 403, headers: new Headers() })).toBe(true);
    expect(looksBlocked({ status: 503, headers: new Headers({ server: 'cloudflare' }) })).toBe(
      true,
    );
    expect(looksBlocked({ status: 503, headers: new Headers({ server: 'nginx' }) })).toBe(false);
    expect(looksBlocked({ status: 404, headers: new Headers() })).toBe(false);
  });
});

describe('lecture d’un fichier des extensions', () => {
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

  it('imite Chrome quand l’hôte du lien filtre les robots', async () => {
    const client = new SourceClient(fakeAddons(['/fingerprint.bin']), silent, {
      loadImpersonation: async () => fakeBrowser,
    });
    const response = await client.openFile(PATH, { start: 0, end: 3 });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('0123');
    expect(seen.map((request) => Boolean(request.headers['x-impersonated']))).toEqual([
      false,
      true,
    ]);
  });

  it('passe à l’extension suivante quand un lien est refusé', async () => {
    const addons = fakeAddons(['/expired.bin', '/file.bin']);
    const client = new SourceClient(addons, silent, { loadImpersonation: async () => null });
    const response = await client.openFile(PATH, { range: 'bytes=0-9' });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('0123456789');
    expect(seen.map((request) => request.url)).toEqual(['/expired.bin', '/file.bin']);
    expect(addons.refreshes).toBe(0);
  });

  it('redemande les liens une fois s’ils sont tous refusés, sans boucler', async () => {
    const addons = fakeAddons(['/expired.bin', '/missing.bin'], ['/file.bin']);
    const client = new SourceClient(addons, silent, { loadImpersonation: async () => null });
    const first = await client.openFile(PATH);
    expect(first.status).toBe(200);
    await first.body?.cancel();
    expect(addons.refreshes).toBe(1);

    // Liens renouvelés à nouveau refusés : la réponse de l'hôte est rendue telle quelle
    // pendant le délai minimal entre deux renouvellements.
    const stuck = fakeAddons(['/expired.bin']);
    const other = new SourceClient(stuck, silent, { loadImpersonation: async () => null });
    expect((await other.openFile(PATH)).status).toBe(410);
    expect((await other.openFile(PATH)).status).toBe(410);
    expect(stuck.refreshes).toBe(1);
  });

  it('refuse un chemin de l’ancienne source', async () => {
    const client = new SourceClient(fakeAddons(['/file.bin']), silent);
    await expect(client.openFile('/movies/Film (2020)/film.mkv')).rejects.toThrow(
      /ancienne source/,
    );
  });
});

describe('relais local pour ffmpeg', () => {
  let dataDir: string;
  let container: Container;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-relay-'));
    container = createContainer(
      loadConfig({ DATA_DIR: dataDir, STREMIO_ADDON_URLS: '', LOG_LEVEL: 'silent' }),
      silent,
    );
    container.source = new SourceClient(fakeAddons(['/file.bin']), silent);
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
    expect(relay.urlFor('/@stremio/movie/tt1/A b.mkv')).toMatch(
      /^http:\/\/127\.0\.0\.1:8484\/api\/internal\/source\?path=%2F%40stremio%2Fmovie%2Ftt1%2FA\+b\.mkv&token=[0-9a-f]{48}$/,
    );
  });

  it('relaie les plages d’octets avec le bon jeton et refuse les autres', async () => {
    const url = new URL(container.relay.urlFor(PATH));
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
      url: `/api/internal/source?path=${encodeURIComponent(PATH)}&token=nope`,
    });
    expect(forged.statusCode).toBe(403);
  });
});
