import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadItem, EnqueueResult, ServerEvent } from '@lumiere/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { json, listen, sendBytes, tmdbCatalogRoute, type FakeTitle } from './helpers/fakes';
import { buildZip } from './helpers/zip-writer';

/**
 * Test d'intégration : un lien 1fichier (obtenu sur une source personnalisée) est vérifié
 * auprès d'une fausse API 1fichier, puis téléchargé par le lien direct qu'elle délivre (plages
 * d'octets) et rattaché au film choisi.
 */
const API_KEY = 'cle-1fichier';
const FILE_ID = 'abcde12345';
const FILE_NAME = 'Test.Movie.2024.1080p.WEB-DL.H264-GRP.mkv';
const FILE_SIZE = 2 * 1024 * 1024;
const content = crypto.randomBytes(FILE_SIZE);
const checksum = crypto.createHash('sha256').update(content).digest('hex');
const TITLES: FakeTitle[] = [
  { id: 42, kind: 'movie', name: 'Test Movie', date: '2024-05-01', imdb: 'tt0000042' },
  { id: 77, kind: 'tv', name: 'Test Show', date: '2023-01-01', imdb: 'tt0000077' },
];
/** Épisodes d'une saison, rangés dans des archives zip (stockée, puis compressée). */
const episodes = [1, 2, 3].map((episode) => ({
  name: `Test.Show.S02E0${episode}.1080p.WEB.mkv`,
  data: crypto.randomBytes(300_000 + episode),
}));
const STORED_ID = 'zipst00001';
const DEFLATED_ID = 'zipdf00001';
const FILES: Record<string, { name: string; bytes: Buffer }> = {
  [FILE_ID]: { name: FILE_NAME, bytes: content },
  [STORED_ID]: {
    name: 'Test.Show.S02.1080p.WEB.zip',
    bytes: buildZip(
      [
        ...episodes.map((episode) => ({
          name: `Test Show S02/${episode.name}`,
          data: episode.data,
        })),
        { name: 'Test Show S02/LISEZMOI.txt', data: Buffer.from('bonjour') },
      ],
      { zip64: true },
    ),
  },
  [DEFLATED_ID]: {
    // Saison 3, épisodes sans numéro de saison dans leur nom : la saison cherchée fait foi.
    name: 'Test.Show.Saison.3.zip',
    bytes: buildZip(
      episodes.map((episode, index) => ({
        name: `Episode ${index + 1}.mkv`,
        data: episode.data,
        compress: true,
      })),
    ),
  },
};

let server: http.Server;
let container: Container;
let app: FastifyInstance;
let dataDir: string;
let baseUrl = '';
const apiCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
const tokensServed: string[] = [];
const tokenFiles = new Map<string, string>();

function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {}));
  });
}

/** Fausse API 1fichier (v1) : compte premium, informations et lien direct d'un fichier. */
async function fakeApi(
  method: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  apiCalls.push({ method, body });
  if (request.headers.authorization !== `Bearer ${API_KEY}`) {
    json(response, 401, { status: 'KO', message: 'Not authenticated #247' });
    return;
  }
  if (method === 'user/info.cgi') {
    json(response, 200, {
      status: 'OK',
      email: 'test@example.com',
      offer: 1,
      subscription_end: '2027-01-31 12:00:00',
    });
    return;
  }
  const id = /^https:\/\/1fichier\.com\/\?([a-z0-9]+)$/.exec(String(body.url))?.[1] ?? '';
  const file = FILES[id];
  if (!file) {
    json(response, 404, { status: 'KO', message: 'Resource not found #469' });
    return;
  }
  if (method === 'file/info.cgi') {
    json(response, 200, { filename: file.name, size: file.bytes.length, checksum: 'w', pass: 0 });
    return;
  }
  if (method === 'download/get_token.cgi') {
    const token = crypto.randomBytes(6).toString('hex');
    tokensServed.push(token);
    tokenFiles.set(token, id);
    json(response, 200, { status: 'OK', url: `${baseUrl}/dl/${token}` });
    return;
  }
  json(response, 404, { status: 'KO', message: 'Unknown method' });
}

function startServer(): Promise<string> {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const api = /^\/1f\/v1\/(.+)$/.exec(url.pathname);
    if (api?.[1] && request.method === 'POST') {
      void fakeApi(api[1], request, response);
      return;
    }
    const download = /^\/dl\/([0-9a-f]+)$/.exec(url.pathname);
    if (download?.[1]) {
      const file = FILES[tokenFiles.get(download[1]) ?? ''];
      if (!file) {
        response.writeHead(403).end();
        return;
      }
      sendBytes(request, response, file.bytes);
      return;
    }
    if (tmdbCatalogRoute(TITLES, url.pathname.replace(/^\/3/, ''), response)) return;
    json(response, 404, { status_code: 34 });
  });
  return listen(server);
}

function waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs = 15_000) {
  return new Promise<ServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Délai dépassé'));
    }, timeoutMs);
    const unsubscribe = container.events.subscribe((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

beforeAll(async () => {
  baseUrl = await startServer();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-1fichier-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    STREMIO_ADDON_URLS: '',
    TMDB_API_KEY: 'cle',
    TMDB_API_BASE_URL: `${baseUrl}/3`,
    ONEFICHIER_API_URL: `${baseUrl}/1f/v1`,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
  });
  container = createContainer(config, createLogger({ level: 'silent', pretty: false }));
  container.downloads.start();
  app = await buildApp(container);
  await container.catalog.refresh('movie');
  await container.catalog.refresh('series');
});

/** Attend la fin (réussie ou non) des téléchargements donnés. */
async function waitDone(ids: number[]): Promise<DownloadItem[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const items = ids.map((id) => container.downloads.get(id));
    if (items.every((item) => item.status === 'completed' || item.status === 'failed'))
      return items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Téléchargements trop longs');
}

afterAll(async () => {
  await app.close();
  await stopServices(container);
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('sources personnalisées et 1fichier', () => {
  it('demande la clé d’API avant de toucher à 1fichier', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier/info',
      payload: { url: `https://1fichier.com/?${FILE_ID}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'ONEFICHIER_NOT_CONFIGURED' });
    expect(apiCalls).toHaveLength(0);
  });

  it('enregistre les sources personnalisées et la clé, puis teste le compte', async () => {
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        oneFichierApiKey: ` ${API_KEY} `,
        customSources: [
          {
            id: '',
            name: ' loadix.fun ',
            searchUrl: 'https://loadix.fun/?q={titre}',
            host: '1fichier',
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.oneFichierApiKeyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(body.settings.customSources).toEqual([
      {
        id: expect.any(String),
        name: 'loadix.fun',
        searchUrl: 'https://loadix.fun/?q={titre}',
        host: '1fichier',
      },
    ]);
    expect(body.settings.customSources[0].id).not.toBe('');

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        customSources: [{ id: 'x', name: 'Site', searchUrl: 'ftp://site', host: '1fichier' }],
      },
    });
    expect(invalid.statusCode).toBe(400);

    const test = await app.inject({
      method: 'POST',
      url: '/api/settings/test-onefichier',
      payload: {},
    });
    expect(test.json()).toEqual({ ok: true, message: 'Compte Premium, jusqu’au 2027-01-31.' });
  });

  it('refuse un texte sans lien 1fichier et signale un fichier introuvable', async () => {
    const none = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier/info',
      payload: { url: 'https://example.com/?abcde12345' },
    });
    expect(none.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier/info',
      payload: { url: 'https://1fichier.com/?zzzzz99999' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toMatch(/introuvable/);
  });

  it('télécharge le lien collé, rattaché au film, et l’affiche sur sa fiche', async () => {
    const [title] = (await container.catalog.search({ kind: 'movie' })).items;
    const response = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier',
      payload: {
        url: `Lien : https://www.1fichier.com/?${FILE_ID}&af=4242 (mot de passe : aucun)`,
        titleId: title!.id,
      },
    });
    expect(response.statusCode).toBe(201);
    const result = response.json<EnqueueResult>();
    expect(result.created).toHaveLength(1);
    const created = result.created[0] as DownloadItem;
    expect(created).toMatchObject({
      kind: 'movie',
      titleId: title!.id,
      remotePath: `/@1fichier/${FILE_ID}/${FILE_NAME}`,
      totalBytes: FILE_SIZE,
    });
    // Lien normalisé : seule forme acceptée par l'API.
    expect(apiCalls.at(-1)).toMatchObject({
      method: 'file/info.cgi',
      body: { url: `https://1fichier.com/?${FILE_ID}` },
    });

    const done = await waitFor(
      (event) =>
        event.type === 'download.updated' &&
        event.download.id === created.id &&
        (event.download.status === 'completed' || event.download.status === 'failed'),
    );
    const item = (done as Extract<ServerEvent, { type: 'download.updated' }>).download;
    expect(item.error).toBeNull();
    expect(item.status).toBe('completed');
    expect(item.targetPath).toContain(path.join('Films', 'Test Movie (2024)', FILE_NAME));
    const written = fs.readFileSync(item.targetPath);
    expect(crypto.createHash('sha256').update(written).digest('hex')).toBe(checksum);
    // Le lien direct est réutilisé pendant sa durée de validité (pas un par morceau).
    expect(tokensServed.length).toBe(1);

    const details = await container.catalog.details(title!.id);
    const file = details.files.find((entry) => entry.path === created.remotePath);
    expect(file?.availability.libraryItemId).toBe(item.libraryItemId);
  });

  it('ne retélécharge pas un fichier déjà dans la bibliothèque', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier',
      payload: { url: `https://1fichier.com/?${FILE_ID}` },
    });
    expect(response.json<EnqueueResult>().skipped[0]?.reason).toMatch(/bibliothèque/);
  });

  it('ouvre une saison en zip non compressé : chaque épisode se lit et se télécharge seul', async () => {
    const [show] = (await container.catalog.search({ kind: 'series' })).items;
    const info = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier/info',
      payload: { url: `https://1fichier.com/?${STORED_ID}` },
    });
    const archive = info.json().archive;
    expect(archive.streamable).toBe(true);
    expect(
      archive.entries.map((entry: { name: string; season: number; episode: number }) => [
        entry.name,
        entry.season,
        entry.episode,
      ]),
    ).toEqual(episodes.map((episode, index) => [episode.name, 2, index + 1]));

    // Lecture directe d'un épisode dans l'archive, par plages d'octets.
    const second = archive.entries[1].path as string;
    const partial = await container.source.openFile(second, { start: 1000, end: 1999 });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 1000-1999/${episodes[1]!.data.length}`,
    );
    expect(
      Buffer.from(await partial.arrayBuffer()).equals(episodes[1]!.data.subarray(1000, 2000)),
    ).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier',
      payload: {
        url: `https://1fichier.com/?${STORED_ID}`,
        titleId: show!.id,
        season: 2,
        entries: [archive.entries[0].path, archive.entries[2].path],
      },
    });
    const created = response.json<EnqueueResult>().created;
    expect(created.map((item) => [item.kind, item.season, item.episode])).toEqual([
      ['episode', 2, 1],
      ['episode', 2, 3],
    ]);
    const done = await waitDone(created.map((item) => item.id));
    for (const [index, item] of done.entries()) {
      expect(item.error).toBeNull();
      expect(item.targetPath).toContain(path.join('Séries', 'Test Show', 'Saison 02'));
      expect(fs.readFileSync(item.targetPath).equals(episodes[index * 2]!.data)).toBe(true);
    }
  });

  it('télécharge une saison en zip compressé puis la décompresse dans la série', async () => {
    const [show] = (await container.catalog.search({ kind: 'series' })).items;
    const info = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier/info',
      payload: { url: `https://1fichier.com/?${DEFLATED_ID}` },
    });
    expect(info.json().archive.streamable).toBe(false);
    const response = await app.inject({
      method: 'POST',
      url: '/api/downloads/1fichier',
      payload: { url: `https://1fichier.com/?${DEFLATED_ID}`, titleId: show!.id, season: 3 },
    });
    const [download] = response.json<EnqueueResult>().created;
    const [done] = await waitDone([download!.id]);
    expect(done!.error).toBeNull();
    expect(done!.status).toBe('completed');

    const library = container.library
      .list()
      .filter((item) => item.titleId === show!.id && item.season === 3);
    expect(library.map((item) => item.episode).sort()).toEqual([1, 2, 3]);
    for (const item of library) {
      expect(fs.readFileSync(item.filePath).equals(episodes[item.episode! - 1]!.data)).toBe(true);
    }
    const folder = path.dirname(library[0]!.filePath);
    expect(folder).toContain(path.join('Séries', 'Test Show', 'Saison 03'));
    expect(fs.readdirSync(folder).some((name) => name.endsWith('.zip'))).toBe(false);
  });
});
