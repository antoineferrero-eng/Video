import { randomBytes } from 'node:crypto';
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
import { SourceClient } from '../src/modules/source/source-client';
import type { Transport } from '../src/modules/source/transport';
import { ZenRowsTransport } from '../src/modules/source/zenrows-transport';

/**
 * Pages de listing via ZenRows (faux service local) quand Cloudflare exige une vérification,
 * fichiers téléchargés directement ou, à défaut, via le point d'accès de lecture.
 */
const FILE = randomBytes(64 * 1024);
const silent = createLogger({ level: 'silent', pretty: false });

interface Fakes {
  source: string;
  zenrows: string;
  cdn: string;
  /** Les fichiers sont-ils servis sans vérification ? */
  filesOpen: boolean;
  /** Le mode automatique de ZenRows échoue-t-il (pour tester la configuration suivante) ? */
  autoFails: boolean;
  zenrowsCalls: Array<Record<string, string>>;
  cdnCalls: string[];
  close(): void;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function challenge(response: http.ServerResponse): void {
  response.writeHead(403, {
    server: 'cloudflare',
    'cf-ray': '8f00-CDG',
    'cf-mitigated': 'challenge',
    'content-type': 'text/html',
  });
  response.end('<html><head><title>Just a moment...</title></head></html>');
}

function serveFile(request: http.IncomingMessage, response: http.ServerResponse): void {
  const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : FILE.length - 1;
  response.writeHead(match ? 206 : 200, {
    'content-type': 'video/x-matroska',
    'content-length': end - start + 1,
    ...(match ? { 'content-range': `bytes ${start}-${end}/${FILE.length}` } : {}),
  });
  response.end(FILE.subarray(start, end + 1));
}

async function startFakes(): Promise<Fakes> {
  const state = {
    filesOpen: true,
    autoFails: true,
    zenrowsCalls: [] as Array<Record<string, string>>,
    cdnCalls: [] as string[],
  };
  // Source derrière Cloudflare : seules les requêtes « de ZenRows » passent pour les pages.
  const source = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const viaZenRows = request.headers['x-zenrows'] === '1';
    if (pathname === '/movies/Film (2020)/Film.2020.1080p.mkv') {
      return state.filesOpen || viaZenRows ? serveFile(request, response) : challenge(response);
    }
    if (!viaZenRows) return challenge(response);
    const pages: Record<string, string> = {
      '/movies/': '<a href="Film%20(2020)/">Film (2020)/</a>  01-Jan-2025 10:00  -',
      '/movies/Film (2020)/': `<a href="Film.2020.1080p.mkv">Film.2020.1080p.mkv</a>  01-Jan-2025 10:00  ${FILE.length}`,
    };
    const rows = pages[pathname];
    if (!rows) return void response.writeHead(404).end('Not Found');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<html><body><pre><a href="../">../</a>\n${rows}\n</pre></body></html>`);
  });
  // Faux ZenRows : clé, erreurs au format de l'API, statut d'origine, en-têtes de suivi.
  const zenrows = http.createServer(async (request, response) => {
    const params = Object.fromEntries(new URL(request.url ?? '/', 'http://x').searchParams);
    state.zenrowsCalls.push(params);
    const fail = (status: number, code: string, title: string) => {
      response.writeHead(status, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ code, title, status }));
    };
    if (params.apikey === 'empty') return fail(402, 'AUTH004', 'Usage Exceeded');
    if (params.apikey !== 'good') return fail(401, 'AUTH002', 'Invalid API Key');
    if (params.url?.endsWith('/absent/')) return fail(404, 'RESP008', 'Not Found');
    if (params.mode === 'auto' && state.autoFails)
      return fail(422, 'RESP001', 'Could not get content');
    const target = await fetch(params.url ?? '', { headers: { 'x-zenrows': '1' } });
    const body = await target.text();
    response.writeHead(params.original_status === 'true' ? target.status : 200, {
      'content-type': 'text/html; charset=utf-8',
      'zr-final-url': params.url ?? '',
      'x-request-credits': params.mode === 'auto' ? '10' : '25',
    });
    response.end(body);
  });
  // Faux point d'accès de lecture : sert le fichier désigné par « u ».
  const cdn = http.createServer((request, response) => {
    const u = new URL(request.url ?? '/', 'http://x').searchParams.get('u') ?? '';
    state.cdnCalls.push(u);
    if (decodeURIComponent(new URL(u).pathname).endsWith('Film.2020.1080p.mkv'))
      return serveFile(request, response);
    response.writeHead(404, { 'content-type': 'text/html' }).end('<p>introuvable</p>');
  });
  const [sourceUrl, zenrowsUrl, cdnUrl] = await Promise.all([
    listen(source),
    listen(zenrows),
    listen(cdn),
  ]);
  return {
    source: sourceUrl,
    zenrows: `${zenrowsUrl}/v1/`,
    cdn: `${cdnUrl}/bulk`,
    get filesOpen() {
      return state.filesOpen;
    },
    set filesOpen(value: boolean) {
      state.filesOpen = value;
    },
    get autoFails() {
      return state.autoFails;
    },
    set autoFails(value: boolean) {
      state.autoFails = value;
    },
    zenrowsCalls: state.zenrowsCalls,
    cdnCalls: state.cdnCalls,
    close: () => {
      source.close();
      zenrows.close();
      cdn.close();
    },
  };
}

let fakes: Fakes;
let dataDir: string;
let container: Container;

beforeAll(async () => {
  fakes = await startFakes();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-zenrows-'));
  container = createContainer(
    loadConfig({
      DATA_DIR: dataDir,
      SOURCE_BASE_URL: fakes.source,
      ZENROWS_API_URL: fakes.zenrows,
      LOG_LEVEL: 'silent',
    }),
    silent,
  );
});

afterAll(async () => {
  await stopServices(container);
  fakes.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  fakes.zenrowsCalls.length = 0;
  fakes.cdnCalls.length = 0;
  fakes.filesOpen = true;
  fakes.autoFails = true;
});

describe('transport ZenRows', () => {
  it('passe à une configuration plus robuste si la moins chère échoue, puis s’y tient', async () => {
    const zenrows = new ZenRowsTransport(() => 'good', fakes.zenrows, silent);
    const response = await zenrows.fetch(`${fakes.source}/movies/`, { kind: 'document' });
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${fakes.source}/movies/`);
    expect(await response.text()).toContain('Film (2020)');
    expect(fakes.zenrowsCalls.map((call) => call.mode ?? 'js+premium')).toEqual([
      'auto',
      'js+premium',
    ]);
    expect(fakes.zenrowsCalls[1]).toMatchObject({
      js_render: 'true',
      premium_proxy: 'true',
      original_status: 'true',
    });

    fakes.zenrowsCalls.length = 0;
    await zenrows.fetch(`${fakes.source}/movies/Film%20(2020)/`, { kind: 'document' });
    expect(fakes.zenrowsCalls).toHaveLength(1);
    expect(zenrows.usage()).toEqual({ pages: 2, credits: 50 });
  });

  it('transmet le statut d’origine et explique les erreurs du service', async () => {
    fakes.autoFails = false;
    const zenrows = new ZenRowsTransport(() => 'good', fakes.zenrows, silent);
    const missing = await zenrows.fetch(`${fakes.source}/nope/`, { kind: 'document' });
    expect(missing.status).toBe(404);
    // 404 au format d'erreur de ZenRows : dossier absent, sans essai plus coûteux.
    fakes.zenrowsCalls.length = 0;
    fakes.autoFails = true;
    const absent = await zenrows.fetch(`${fakes.source}/absent/`, { kind: 'document' });
    expect(absent.status).toBe(404);
    expect(fakes.zenrowsCalls).toHaveLength(1);
    fakes.autoFails = false;

    const invalid = new ZenRowsTransport(() => 'bad', fakes.zenrows, silent);
    await expect(invalid.fetch(`${fakes.source}/movies/`, { kind: 'document' })).rejects.toThrow(
      'ZenRows : clé API ZenRows invalide (vérifiez-la dans Paramètres → Source) (AUTH002)',
    );
    const exhausted = new ZenRowsTransport(() => 'empty', fakes.zenrows, silent);
    await expect(exhausted.fetch(`${fakes.source}/movies/`, { kind: 'document' })).rejects.toThrow(
      /crédits ZenRows épuisés/,
    );
    const unreachable = new ZenRowsTransport(() => 'good', 'http://127.0.0.1:9/v1/', silent);
    await expect(
      unreachable.fetch(`${fakes.source}/movies/`, { kind: 'document' }),
    ).rejects.toThrow();
    const none = new ZenRowsTransport(() => null, fakes.zenrows, silent);
    await expect(none.fetch(`${fakes.source}/movies/`, { kind: 'document' })).rejects.toThrow(
      /aucune clé API ZenRows/,
    );
  });
});

describe('client de la source avec ZenRows', () => {
  /** Le navigateur réel ne doit jamais être sollicité quand ZenRows est configuré. */
  const realBrowserCalls: string[] = [];
  const realBrowser: Transport = {
    name: 'real-browser',
    fetch: async (url) => {
      realBrowserCalls.push(url);
      throw new Error('navigateur ouvert');
    },
  };
  const client = () =>
    new SourceClient(container.settings, silent, {
      zenrows: new ZenRowsTransport(() => 'good', fakes.zenrows, silent),
      realBrowser: () => realBrowser,
      cdn: { baseUrl: fakes.cdn, hosts: /^127\.0\.0\.1$/ },
    });

  it('liste via ZenRows et télécharge le fichier directement', async () => {
    await container.settings.update({ sourceConnection: 'zenrows' });
    const source = client();
    const movies = await source.list('/movies/');
    expect(movies.transport).toBe('zenrows');
    expect(movies.entries.map((entry) => entry.path)).toEqual(['/movies/Film (2020)/']);
    const folder = await source.list('/movies/Film (2020)/');
    const file = folder.entries[0];
    expect(file?.path).toBe('/movies/Film (2020)/Film.2020.1080p.mkv');
    expect(file?.size).toBe(FILE.length);

    const response = await source.openFile(file?.path ?? '', { start: 10, end: 99 });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(FILE.subarray(10, 100))).toBe(true);
    expect(fakes.cdnCalls).toHaveLength(0);
    expect(realBrowserCalls).toHaveLength(0);
  });

  it('passe par le point d’accès de lecture si le lien direct est refusé', async () => {
    await container.settings.update({ sourceConnection: 'zenrows' });
    fakes.filesOpen = false;
    const source = client();
    const response = await source.openFile('/movies/Film (2020)/Film.2020.1080p.mkv', {
      start: 0,
      end: 1023,
    });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(FILE.subarray(0, 1024))).toBe(true);
    expect(fakes.cdnCalls).toEqual([`${fakes.source}/movies/Film%20(2020)/Film.2020.1080p.mkv`]);
    expect(realBrowserCalls).toHaveLength(0);
  });

  it('utilise ZenRows en mode automatique dès qu’une clé est configurée', async () => {
    await container.settings.update({ sourceConnection: 'auto' });
    const listing = await client().list('/movies/', { force: true });
    expect(listing.transport).toBe('zenrows');
    expect(realBrowserCalls).toHaveLength(0);
  });
});

describe('clé ZenRows dans les paramètres', () => {
  it('est enregistrée sans jamais être renvoyée à l’interface', async () => {
    const app = await buildApp(container);
    try {
      const saved = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { zenrowsApiKey: '  secret-zenrows  ' },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ zenrowsApiKeyConfigured: true });
      expect(saved.body).not.toContain('secret-zenrows');
      expect(container.settings.getZenrowsApiKey()).toBe('secret-zenrows');

      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { zenrowsApiKey: '' } });
      expect(container.settings.getZenrowsApiKey()).toBeNull();
    } finally {
      await app.close();
    }
  });
});
