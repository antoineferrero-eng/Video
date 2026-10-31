import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@lumiere/shared';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';

/**
 * Mode « extension Stremio » : catalogue venu de TMDB, fichiers fournis par l'extension.
 * Les liens ne sont demandés qu'à l'ouverture d'un film ou pour un épisode précis (jamais
 * pour lister une série), sont gardés en base, et redemandés quand l'hôte les refuse.
 */
const silent = createLogger({ level: 'silent', pretty: false });

const MOVIE_FILE = 'Ready.Player.One.2018.1080p.WEB.H264-GRP.mkv';
const MOVIE_BYTES = crypto.randomBytes(256 * 1024);
const EPISODE_BYTES = crypto.randomBytes(64 * 1024);

interface Title {
  id: number;
  kind: 'movie' | 'tv';
  name: string;
  date: string;
  imdb: string;
  seasons?: number[];
}

const TITLES: Title[] = [
  { id: 333339, kind: 'movie', name: 'Ready Player One', date: '2018-03-28', imdb: 'tt1677720' },
  { id: 999, kind: 'movie', name: 'Film introuvable', date: '2020-01-01', imdb: 'tt0000999' },
  {
    id: 1396,
    kind: 'tv',
    name: 'Breaking Bad',
    date: '2008-01-20',
    imdb: 'tt0903747',
    seasons: [3, 2],
  },
];

const addonRequests: string[] = [];
/** Liens délivrés : jeton → contenu ; un jeton « expiré » est refusé (410). */
const links = new Map<string, { bytes: Buffer; expired: boolean }>();
/** Épisodes pour lesquels l'extension répond « limite atteinte ». */
const limitedEpisodes = new Set<string>();

let tmdb: http.Server;
let addon: http.Server;
let container: Container;
let dataDir: string;
let addonUrl: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function item(title: Title) {
  return title.kind === 'movie'
    ? { id: title.id, title: title.name, original_title: title.name, release_date: title.date }
    : { id: title.id, name: title.name, original_name: title.name, first_air_date: title.date };
}

function link(bytes: Buffer, name: string): string {
  const token = crypto.randomBytes(8).toString('hex');
  links.set(token, { bytes, expired: false });
  return `${addonUrl}/link/${token}/${encodeURIComponent(name)}`;
}

function waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs = 15_000) {
  return new Promise<ServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Délai dépassé'));
    }, timeoutMs);
    const unsubscribe = container.events.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

beforeAll(async () => {
  tmdb = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const route = url.pathname.replace(/^\/3/, '');
    const list = /^\/(?:trending\/(movie|tv)\/week|discover\/(movie|tv)|(movie|tv)\/[a-z_]+)$/.exec(
      route,
    );
    if (list && !/^\/(movie|tv)\/\d+$/.test(route)) {
      const kind = list[1] ?? list[2] ?? list[3];
      const results = TITLES.filter((title) => title.kind === kind).map(item);
      return json(response, 200, { page: 1, total_pages: 1, results });
    }
    if (/^\/genre\/(movie|tv)\/list$/.test(route)) return json(response, 200, { genres: [] });
    const external = /^\/(movie|tv)\/(\d+)\/external_ids$/.exec(route);
    if (external) {
      const title = TITLES.find((entry) => entry.id === Number(external[2]));
      return json(response, 200, { id: title?.id, imdb_id: title?.imdb ?? null });
    }
    const season = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(route);
    if (season) {
      const title = TITLES.find((entry) => entry.id === Number(season[1]));
      const count = title?.seasons?.[Number(season[2]) - 1] ?? 0;
      return json(response, 200, {
        season_number: Number(season[2]),
        name: `Saison ${season[2]}`,
        episodes: Array.from({ length: count }, (_, index) => ({
          episode_number: index + 1,
          name: `Épisode ${index + 1}`,
          air_date: '2008-01-20',
        })),
      });
    }
    const detail = /^\/(movie|tv)\/(\d+)$/.exec(route);
    const title = detail && TITLES.find((entry) => entry.id === Number(detail[2]));
    if (title) {
      return json(response, 200, {
        ...item(title),
        genres: [],
        seasons: (title.seasons ?? []).map((count, index) => ({
          season_number: index + 1,
          episode_count: count,
          name: `Saison ${index + 1}`,
          air_date: title.date,
          poster_path: null,
        })),
      });
    }
    json(response, 404, { status_code: 34 });
  });

  addon = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/manifest.json') {
      return json(response, 200, {
        id: 'test.addon',
        name: 'Extension de test',
        version: '1.0.0',
        types: ['movie', 'series'],
        resources: ['stream'],
        idPrefixes: ['tt'],
      });
    }
    const stream = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(pathname);
    if (stream?.[2]) {
      addonRequests.push(stream[2]);
      const id = stream[2];
      if (limitedEpisodes.has(id)) {
        return json(response, 200, {
          streams: [{ name: '111477', title: '⚠️ Slow down — rate limit reached' }],
        });
      }
      if (id === 'tt1677720') {
        return json(response, 200, {
          streams: [
            {
              name: '111477\n1080p',
              title: `${MOVIE_FILE}\n💾 256 KB`,
              url: link(MOVIE_BYTES, MOVIE_FILE),
              behaviorHints: { filename: MOVIE_FILE, videoSize: MOVIE_BYTES.length },
            },
          ],
        });
      }
      const episode = /^tt0903747:(\d+):(\d+)$/.exec(id);
      if (episode) {
        const name = `Breaking.Bad.S0${episode[1]}E0${episode[2]}.720p.mkv`;
        return json(response, 200, {
          streams: [{ name: '111477\n720p', url: link(EPISODE_BYTES, name) }],
        });
      }
      return json(response, 200, { streams: [] });
    }
    const file = /^\/link\/([a-f0-9]+)\//.exec(pathname);
    const entry = file?.[1] ? links.get(file[1]) : undefined;
    if (!entry || entry.expired) {
      response.writeHead(410).end('Lien expiré');
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : entry.bytes.length - 1;
    response.writeHead(range ? 206 : 200, {
      'content-type': 'video/x-matroska',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${entry.bytes.length}` } : {}),
    });
    response.end(entry.bytes.subarray(start, end + 1));
  });

  const [tmdbUrl, addonBase] = await Promise.all([listen(tmdb), listen(addon)]);
  addonUrl = addonBase;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-addon-'));
  container = createContainer(
    loadConfig({
      DATA_DIR: dataDir,
      STREMIO_ADDON_URLS: `${addonBase}/manifest.json`,
      TMDB_API_KEY: 'cle',
      TMDB_API_BASE_URL: `${tmdbUrl}/3`,
      LOG_LEVEL: 'silent',
    }),
    silent,
  );
  container.downloads.start();
});

afterAll(async () => {
  await stopServices(container);
  tmdb.close();
  addon.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function titleId(name: string): Promise<number> {
  const page = await container.catalog.search({ q: name });
  const found = page.items.find((title) => title.title === name);
  if (!found) throw new Error(`${name} absent du catalogue`);
  return found.id;
}

describe('catalogue TMDB et fichiers de l’extension Stremio', () => {
  it('construit le catalogue depuis TMDB', async () => {
    const movies = await container.catalog.refresh('movie');
    expect(movies).toMatchObject({ state: 'idle', count: 2, lastError: null });
    await container.catalog.refresh('series');
  });

  it('n’interroge aucune extension à l’ouverture d’une fiche, seulement pour ses versions', async () => {
    const id = await titleId('Ready Player One');
    addonRequests.length = 0;
    expect((await container.catalog.details(id)).files).toEqual([]);
    expect(addonRequests).toEqual([]);

    const versions = await container.catalog.movieVersions(id);
    expect(versions.notice).toBeNull();
    expect(versions.files.map((file) => [file.name, file.size, file.label])).toEqual([
      [MOVIE_FILE, MOVIE_BYTES.length, '111477 · 1080p · 💾 256 KB'],
    ]);
    await container.catalog.movieVersions(id);
    expect(addonRequests).toEqual(['tt1677720']);
    const details = await container.catalog.details(id);
    expect(details.remotePath).toBe('/@stremio/movie/tt1677720/');
    expect(details.sourceStatus).toBe('present');
  });

  it('marque absent un film que l’extension ne propose pas', async () => {
    const id = await titleId('Film introuvable');
    expect((await container.catalog.movieVersions(id)).files).toEqual([]);
    expect((await container.catalog.details(id)).sourceStatus).toBe('missing');
  });

  it('liste les épisodes d’une série sans demander de liens', async () => {
    const id = await titleId('Breaking Bad');
    addonRequests.length = 0;
    const details = await container.catalog.details(id);
    expect(details.remotePath).toBe('/@stremio/series/tt0903747/');
    expect(details.seasons.map((season) => [season.name, season.episodes.length])).toEqual([
      ['Saison 1', 3],
      ['Saison 2', 2],
    ]);
    expect(details.seasons[0]?.episodes[0]).toMatchObject({ season: 1, episode: 1, files: [] });
    expect(addonRequests).toEqual([]);

    const files = await container.catalog.episodeFiles(id, 1, 2);
    expect(files.files.map((file) => [file.name, file.season, file.episode])).toEqual([
      ['Breaking.Bad.S01E02.720p.mkv', 1, 2],
    ]);
    expect(addonRequests).toEqual(['tt0903747:1:2']);
  });

  it('télécharge un film et redemande un lien expiré', async () => {
    for (const entry of links.values()) entry.expired = true;
    addonRequests.length = 0;
    const result = await container.downloads.enqueueTitle(await titleId('Ready Player One'));
    const [download] = result.created;
    expect(download?.targetPath).toBe(
      path.join(dataDir, 'media', 'Films', 'Ready Player One (2018)', MOVIE_FILE),
    );
    await waitFor(
      (event) =>
        event.type === 'download.updated' &&
        event.download.id === download?.id &&
        event.download.status === 'completed',
    );
    expect(fs.readFileSync(download!.targetPath).equals(MOVIE_BYTES)).toBe(true);
    // Lien gardé en base refusé par l'hôte : une seule nouvelle demande.
    expect(addonRequests).toEqual(['tt1677720']);

    const details = await container.catalog.details(await titleId('Ready Player One'));
    expect(details.files[0]?.availability.libraryItemId).not.toBeNull();
  });

  it('ne renouvelle pas en boucle un lien que l’hôte refuse', async () => {
    const { files } = await container.catalog.episodeFiles(await titleId('Breaking Bad'), 1, 2);
    const remotePath = files[0]!.path;
    for (const entry of links.values()) entry.expired = true;
    addonRequests.length = 0;
    const first = await container.source.openFile(remotePath);
    await first.body?.cancel();
    expect(first.status).toBe(200);
    expect(addonRequests).toEqual(['tt0903747:1:2']);
    // Nouveau lien aussitôt refusé : pas de nouvelle demande (chacune consomme des jetons).
    for (const entry of links.values()) entry.expired = true;
    const second = await container.source.openFile(remotePath);
    await second.body?.cancel();
    expect(second.status).toBe(410);
    expect(addonRequests).toEqual(['tt0903747:1:2']);
  });

  it('télécharge une saison en arrière-plan, épisode par épisode', async () => {
    const id = await titleId('Breaking Bad');
    const notice = waitFor((event) => event.type === 'downloads.notice');
    const result = await container.downloads.enqueueTitle(id, 2);
    expect(result).toMatchObject({ created: [], skipped: [], pending: 2 });
    expect(await notice).toMatchObject({
      level: 'success',
      message: 'Breaking Bad · saison 2 : 2 épisodes ajoutés aux téléchargements',
    });
    const episodes = container.downloads
      .list()
      .items.filter((item) => item.titleId === id)
      .map((item) => [item.season, item.episode, item.kind]);
    expect(episodes).toEqual(
      expect.arrayContaining([
        [2, 1, 'episode'],
        [2, 2, 'episode'],
      ]),
    );
    // Déjà en file : la saison n'est pas redemandée.
    addonRequests.length = 0;
    const again = await container.downloads.enqueueTitle(id, 2);
    expect(again.pending).toBe(0);
    expect(again.skipped).toHaveLength(2);
    expect(addonRequests).toEqual([]);
  });

  it('arrête un lot quand l’extension atteint sa limite de liens', async () => {
    const id = await titleId('Breaking Bad');
    limitedEpisodes.add('tt0903747:1:1');
    const notice = waitFor((event) => event.type === 'downloads.notice');
    const result = await container.downloads.enqueueTitle(id, 1);
    // Aucun épisode de la saison 1 n'est téléchargé : les trois sont à demander.
    expect(result.pending).toBe(3);
    const event = await notice;
    expect(event).toMatchObject({
      level: 'warning',
      message: 'Breaking Bad · saison 1 : aucun épisode ajouté',
    });
    expect(event.type === 'downloads.notice' && event.description).toMatch(
      /2 épisodes non demandés.*limite de liens/,
    );
    limitedEpisodes.clear();
  });

  it('enchaîne sur l’épisode suivant sans demander son fichier', async () => {
    const id = await titleId('Breaking Bad');
    const row = container.catalog.getRow(id);
    expect(await container.catalog.nextEpisode(row, 1, 3)).toEqual({ season: 2, episode: 1 });
    expect(await container.catalog.nextEpisode(row, 2, 2)).toBeNull();
  });
});
