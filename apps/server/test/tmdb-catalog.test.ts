import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';

/**
 * Catalogue TMDB : la liste complète de la source est illisible (trop volumineuse), le
 * catalogue vient donc de TMDB et le dossier de chaque titre est cherché à l'ouverture de
 * sa fiche, d'après les conventions « Titre (Année) » / « Titre ».
 */
const silent = createLogger({ level: 'silent', pretty: false });

const FOLDERS: Record<string, string[]> = {
  '/movies/COSMOS ODYSSEY (2025)/': ['Cosmos.Odyssey.2025.1080p.WEB.H264-LUMIERE.mkv'],
  '/movies/Le Voyage Imaginaire (2023)/': ['Le.Voyage.Imaginaire.2023.MULTi.1080p.WEB.mkv'],
  '/tvs/Orbite (2020)/': ['Saison 1/'],
  '/tvs/Orbite (2020)/Saison 1/': [
    'Orbite.S01E01.720p.HDTV.x264-LUMIERE.mp4',
    'Orbite.S01E02.720p.HDTV.x264-LUMIERE.mp4',
  ],
};

interface DemoTitle {
  id: number;
  kind: 'movie' | 'tv';
  fr: string;
  en: string;
  original: string;
  date: string;
}

const TITLES: DemoTitle[] = [
  {
    id: 1,
    kind: 'movie',
    fr: 'Cosmos Odyssey',
    en: 'Cosmos Odyssey',
    original: 'Cosmos Odyssey',
    date: '2025-03-19',
  },
  {
    id: 2,
    kind: 'movie',
    fr: 'Le Voyage imaginaire',
    en: 'Le Voyage imaginaire',
    original: 'Le Voyage Imaginaire',
    date: '2023-11-08',
  },
  {
    id: 3,
    kind: 'movie',
    fr: 'L’Éclipse oubliée',
    en: 'The Forgotten Eclipse',
    original: 'The Forgotten Eclipse',
    date: '2024-10-02',
  },
  { id: 10, kind: 'tv', fr: 'Orbite', en: 'Orbite', original: 'Orbite', date: '2020-09-15' },
];

/** Popularité TMDB de chaque titre (indépendante de l'ordre des listes). */
const POPULARITY: Record<number, number> = { 1: 30.5, 2: 90.2, 3: 60.1, 10: 40 };

function item(title: DemoTitle, language: string) {
  const name = language.startsWith('en') ? title.en : title.fr;
  const common = {
    id: title.id,
    overview: `Résumé de ${title.fr}.`,
    poster_path: `/p${title.id}.jpg`,
    backdrop_path: `/b${title.id}.jpg`,
    vote_average: 7.5,
    vote_count: 100,
    popularity: POPULARITY[title.id],
    genre_ids: [title.kind === 'movie' ? 878 : 10765],
  };
  return title.kind === 'movie'
    ? { ...common, title: name, original_title: title.original, release_date: title.date }
    : { ...common, name, original_name: title.original, first_air_date: title.date };
}

let source: http.Server;
let tmdb: http.Server;
const probes: string[] = [];
let dataDir: string;
let container: Container;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  source = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    probes.push(pathname);
    if (pathname === '/movies/' || pathname === '/tvs/') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      return response.end('Réponse trop volumineuse');
    }
    const entries = FOLDERS[pathname];
    if (!entries) return void response.writeHead(404).end('Not Found');
    const rows = entries
      .map(
        (name) =>
          `<a href="${encodeURIComponent(name.replace(/\/$/, ''))}${name.endsWith('/') ? '/' : ''}">${name}</a>  01-Jan-2025 10:00  ${name.endsWith('/') ? '-' : '734003200'}`,
      )
      .join('\n');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<html><body><pre><a href="../">../</a>\n${rows}\n</pre></body></html>`);
  });
  tmdb = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const route = url.pathname.replace(/^\/3/, '');
    const language = url.searchParams.get('language') ?? 'fr-FR';
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const list =
      /^\/(?:trending\/(movie|tv)\/week|(movie)\/(?:popular|now_playing|top_rated)|(tv)\/(?:popular|on_the_air|top_rated))$/.exec(
        route,
      );
    if (list) {
      const kind = list[1] ?? list[2] ?? list[3];
      const results = TITLES.filter((title) => title.kind === kind).map((title) =>
        item(title, language),
      );
      return send(200, { page: 1, results, total_pages: 1 });
    }
    if (/^\/genre\/(movie|tv)\/list$/.test(route))
      return send(200, {
        genres: [
          { id: 878, name: 'Science-Fiction' },
          { id: 10765, name: 'Science-Fiction & Fantastique' },
        ],
      });
    const search = /^\/search\/(movie|tv)$/.exec(route);
    if (search) {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const results = TITLES.filter(
        (title) =>
          title.kind === search[1] &&
          [title.fr, title.en, title.original].some((name) => name.toLowerCase().includes(query)),
      ).map((title) => item(title, language));
      return send(200, { page: 1, results, total_results: results.length });
    }
    const season = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(route);
    if (season) {
      return send(200, {
        season_number: Number(season[2]),
        name: `Saison ${season[2]}`,
        overview: '',
        poster_path: null,
        episodes: [1, 2].map((episode) => ({
          episode_number: episode,
          name: `Épisode ${episode}`,
          overview: '',
          still_path: null,
          air_date: null,
          runtime: 40,
        })),
      });
    }
    const detail = /^\/(movie|tv)\/(\d+)$/.exec(route);
    const title = detail && TITLES.find((entry) => entry.id === Number(detail[2]));
    if (title) {
      return send(200, {
        ...item(title, language),
        tagline: null,
        runtime: 120,
        episode_run_time: [40],
        genres: [{ id: 878, name: 'Science-Fiction' }],
      });
    }
    send(404, { status_code: 34 });
  });
  const [sourceUrl, tmdbUrl] = await Promise.all([listen(source), listen(tmdb)]);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-tmdb-catalog-'));
  container = createContainer(
    loadConfig({
      DATA_DIR: dataDir,
      // Liste de la source lue directement (pas d'extension Stremio).
      STREMIO_ADDON_URL: '',
      SOURCE_BASE_URL: sourceUrl,
      TMDB_API_KEY: 'cle',
      TMDB_API_BASE_URL: `${tmdbUrl}/3`,
      LOG_LEVEL: 'silent',
    }),
    silent,
  );
});

afterAll(async () => {
  await stopServices(container);
  source.close();
  tmdb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('catalogue TMDB', () => {
  it('se replie sur TMDB quand la liste complète de la source est illisible', async () => {
    const movies = await container.catalog.refresh('movie');
    expect(movies).toMatchObject({ state: 'idle', mode: 'tmdb', count: 3, lastError: null });
    expect(movies.note).toMatch(/La liste complète de \/movies\/ n’a pas pu être lue/);
    const series = await container.catalog.refresh('series');
    expect(series).toMatchObject({ mode: 'tmdb', count: 1 });
    expect(container.catalog.tmdbActive()).toBe(true);

    const page = await container.catalog.search({ kind: 'movie', sort: 'title' });
    expect(page.items.map((title) => [title.title, title.sourceStatus])).toEqual([
      ['Cosmos Odyssey', 'unknown'],
      ['L’Éclipse oubliée', 'unknown'],
      ['Le Voyage imaginaire', 'unknown'],
    ]);
  });

  it('trie par popularité TMDB par défaut, accueil compris', async () => {
    const byPopularity = ['Le Voyage imaginaire', 'L’Éclipse oubliée', 'Cosmos Odyssey'];
    const page = await container.catalog.search({ kind: 'movie' });
    expect(page.items.map((title) => title.title)).toEqual(byPopularity);
    const home = container.catalog.home();
    expect(home.popularMovies.map((title) => title.title)).toEqual(byPopularity);
    expect(home.popularSeries.map((title) => title.title)).toEqual(['Orbite']);
    expect(home.featured[0]?.title).toBe('Le Voyage imaginaire');
    // Catalogue TMDB : pas de date d'ajout sur la source, donc pas de « récemment ajoutés ».
    expect(home.recentMovies).toEqual([]);
    expect(home.recentSeries).toEqual([]);
  });

  it('trouve le dossier d’un film à l’ouverture de sa fiche, même en capitales', async () => {
    const [cosmos] = (await container.catalog.search({ q: 'cosmos' })).items;
    probes.length = 0;
    const details = await container.catalog.details(cosmos!.id);
    expect(details.sourceStatus).toBe('present');
    expect(details.remotePath).toBe('/movies/COSMOS ODYSSEY (2025)/');
    expect(details.files.map((file) => file.name)).toEqual([
      'Cosmos.Odyssey.2025.1080p.WEB.H264-LUMIERE.mkv',
    ]);
    expect(probes).toEqual(['/movies/Cosmos Odyssey (2025)/', '/movies/COSMOS ODYSSEY (2025)/']);

    // Mémorisé : plus aucun essai à la réouverture.
    probes.length = 0;
    await container.catalog.details(cosmos!.id);
    expect(probes).toEqual([]);
  });

  it('essaie le titre original, puis note les dossiers essayés quand le titre est absent', async () => {
    const [voyage] = (await container.catalog.search({ q: 'voyage' })).items;
    const found = await container.catalog.details(voyage!.id);
    expect(found.remotePath).toBe('/movies/Le Voyage Imaginaire (2023)/');

    const [eclipse] = (await container.catalog.search({ q: 'eclipse' })).items;
    const missing = await container.catalog.details(eclipse!.id);
    expect(missing.sourceStatus).toBe('missing');
    expect(missing.files).toEqual([]);
    expect(missing.sourceTried[0]).toBe('The Forgotten Eclipse (2024)');
    expect(missing.sourceTried).toContain('L’Éclipse oubliée (2024)');
    expect((await container.catalog.search({ q: 'eclipse' })).items[0]?.sourceStatus).toBe(
      'missing',
    );
  });

  it('trouve une série nommée « Titre (Année) » et ses épisodes', async () => {
    const [orbite] = (await container.catalog.search({ kind: 'series' })).items;
    const details = await container.catalog.details(orbite!.id);
    expect(details.remotePath).toBe('/tvs/Orbite (2020)/');
    expect(details.seasons[0]?.episodes.map((episode) => episode.episode)).toEqual([1, 2]);
  });

  it('ajoute au catalogue les titres trouvés par la recherche TMDB', async () => {
    await container.settings.update({ catalogSource: 'tmdb' });
    const results = await container.catalog.search({ q: 'forgotten' });
    expect(results.items.map((title) => title.title)).toEqual(['L’Éclipse oubliée']);
  });
});
