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
 * Catalogue TMDB : listes de films et de séries (popularité, tendances…) et recherche, triés
 * comme sur le site de TMDB. Les fichiers viennent des extensions Stremio (voir
 * addon-catalog.test.ts) : sans extension configurée, la fiche le signale.
 */
const silent = createLogger({ level: 'silent', pretty: false });

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
  {
    id: 4,
    kind: 'movie',
    fr: 'Demain',
    en: 'Tomorrow',
    original: 'Tomorrow',
    date: '2999-01-01',
  },
  { id: 10, kind: 'tv', fr: 'Orbite', en: 'Orbite', original: 'Orbite', date: '2020-09-15' },
];

/** Popularité TMDB de chaque titre (indépendante de l'ordre des listes). */
const POPULARITY: Record<number, number> = { 1: 30.5, 2: 90.2, 3: 60.1, 4: 5, 10: 40 };

/** Films de plus servis par « Découvrir » (aucun par défaut), après ceux des listes. */
let discoverExtra = 0;
/** Pages de « Découvrir » demandées. */
const discoverPages: number[] = [];

function extraMovie(index: number): DemoTitle {
  const name = `Film ${index}`;
  return {
    id: 1000 + index,
    kind: 'movie',
    fr: name,
    en: name,
    original: name,
    date: '2010-01-01',
  };
}

function item(title: DemoTitle, language: string) {
  const name = language.startsWith('en') ? title.en : title.fr;
  const common = {
    id: title.id,
    overview: `Résumé de ${title.fr}.`,
    poster_path: `/p${title.id}.jpg`,
    backdrop_path: `/b${title.id}.jpg`,
    vote_average: 7.5,
    vote_count: 100,
    popularity: POPULARITY[title.id] ?? 1,
    genre_ids: [title.kind === 'movie' ? 878 : 10765],
  };
  return title.kind === 'movie'
    ? { ...common, title: name, original_title: title.original, release_date: title.date }
    : { ...common, name, original_name: title.original, first_air_date: title.date };
}

let tmdb: http.Server;
let dataDir: string;
let container: Container;
let tmdbUrl: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
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
    const discover = /^\/discover\/(movie|tv)$/.exec(route);
    if (discover) {
      const page = Number(url.searchParams.get('page') ?? 1);
      if (discover[1] === 'movie') discoverPages.push(page);
      const titles = TITLES.filter((title) => title.kind === discover[1]);
      if (discover[1] === 'movie')
        for (let index = 0; index < discoverExtra; index += 1) titles.push(extraMovie(index));
      const results = titles
        .slice((page - 1) * 20, page * 20)
        .map((title) => item(title, language));
      return send(200, { page, results, total_pages: Math.ceil(titles.length / 20) });
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
        seasons:
          title.kind === 'tv'
            ? [{ season_number: 1, episode_count: 2, name: 'Saison 1', poster_path: null }]
            : undefined,
      });
    }
    send(404, { status_code: 34 });
  });
  tmdbUrl = await listen(tmdb);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-tmdb-catalog-'));
  container = createContainer(
    loadConfig({
      DATA_DIR: dataDir,
      STREMIO_ADDON_URLS: '',
      TMDB_API_KEY: 'cle',
      TMDB_API_BASE_URL: `${tmdbUrl}/3`,
      LOG_LEVEL: 'silent',
    }),
    silent,
  );
});

afterAll(async () => {
  await stopServices(container);
  tmdb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('catalogue TMDB', () => {
  it('importe les listes de TMDB', async () => {
    const movies = await container.catalog.refresh('movie');
    expect(movies).toMatchObject({ state: 'idle', count: 4, lastError: null });
    const series = await container.catalog.refresh('series');
    expect(series).toMatchObject({ state: 'idle', count: 1 });

    const page = await container.catalog.search({ kind: 'movie', sort: 'title' });
    expect(page.items.map((title) => [title.title, title.sourceStatus])).toEqual([
      ['Cosmos Odyssey', 'unknown'],
      ['Demain', 'unknown'],
      ['L’Éclipse oubliée', 'unknown'],
      ['Le Voyage imaginaire', 'unknown'],
    ]);
  });

  it('trie par popularité TMDB par défaut, accueil compris', async () => {
    const byPopularity = ['Le Voyage imaginaire', 'L’Éclipse oubliée', 'Cosmos Odyssey', 'Demain'];
    const page = await container.catalog.search({ kind: 'movie' });
    expect(page.items.map((title) => title.title)).toEqual(byPopularity);
    const home = container.catalog.home();
    expect(home.popularMovies.map((title) => title.title)).toEqual(byPopularity);
    expect(home.popularSeries.map((title) => title.title)).toEqual(['Orbite']);
    expect(home.featured[0]?.title).toBe('Le Voyage imaginaire');
  });

  it('trie les sorties récentes d’abord, les titres à venir à la fin', async () => {
    const page = await container.catalog.search({ kind: 'movie', sort: 'recent' });
    expect(page.items.map((title) => title.title)).toEqual([
      'Cosmos Odyssey',
      'L’Éclipse oubliée',
      'Le Voyage imaginaire',
      'Demain',
    ]);
  });

  it('signale sur la fiche d’un film qu’aucune extension n’est configurée', async () => {
    const [cosmos] = (await container.catalog.search({ q: 'cosmos' })).items;
    const details = await container.catalog.details(cosmos!.id);
    expect(details.files).toEqual([]);
    expect(details.sourceNotice).toMatch(/Aucune extension Stremio configurée/);
  });

  it('liste les saisons et épisodes d’une série d’après TMDB', async () => {
    const [orbite] = (await container.catalog.search({ kind: 'series' })).items;
    const details = await container.catalog.details(orbite!.id);
    expect(details.seasons[0]?.episodes.map((episode) => episode.episode)).toEqual([1, 2]);
  });

  it('ajoute au catalogue les titres trouvés par la recherche TMDB', async () => {
    const results = await container.catalog.search({ q: 'forgotten' });
    expect(results.items.map((title) => title.title)).toEqual(['L’Éclipse oubliée']);
  });
});

describe('taille du catalogue', () => {
  it('complète les listes par « Découvrir » jusqu’à la taille choisie', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-catalog-size-'));
    const fresh = createContainer(
      loadConfig({
        DATA_DIR: dir,
        STREMIO_ADDON_URLS: '',
        TMDB_API_KEY: 'cle',
        TMDB_API_BASE_URL: `${tmdbUrl}/3`,
        LOG_LEVEL: 'silent',
      }),
      silent,
    );
    discoverExtra = 250; // 254 films en 13 pages.
    try {
      await fresh.settings.update({ catalogSize: 50 });
      await fresh.catalog.refresh('movie');
      // Pages demandées par lots de 5 : le premier suffit (100 films).
      expect(fresh.titles.count('movie')).toBe(100);
      expect(Math.max(...discoverPages)).toBe(5);

      // Catalogue agrandi : réimporté sans attendre.
      const imported = new Promise<void>((resolve) => {
        const unsubscribe = fresh.events.subscribe((event) => {
          if (
            event.type === 'catalog.updated' &&
            event.status.kind === 'movie' &&
            event.status.state === 'idle'
          ) {
            unsubscribe();
            resolve();
          }
        });
      });
      await fresh.settings.update({ catalogSize: 10_000 });
      await imported;
      // Jamais au-delà de la dernière page annoncée par TMDB.
      expect(fresh.titles.count('movie')).toBe(254);
      expect(Math.max(...discoverPages)).toBe(13);
    } finally {
      discoverExtra = 0;
      await stopServices(fresh);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('premier lancement', () => {
  it('importe le catalogue dès que la clé TMDB est enregistrée', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-first-run-'));
    const fresh = createContainer(
      loadConfig({
        DATA_DIR: dir,
        STREMIO_ADDON_URLS: '',
        TMDB_API_BASE_URL: `${tmdbUrl}/3`,
        LOG_LEVEL: 'silent',
      }),
      silent,
    );
    try {
      await expect(fresh.catalog.refresh('movie')).rejects.toThrow(/clé TMDB/);
      const imported = new Promise<void>((resolve) => {
        const unsubscribe = fresh.events.subscribe((event) => {
          if (
            event.type === 'catalog.updated' &&
            event.status.kind === 'movie' &&
            event.status.state === 'idle'
          ) {
            unsubscribe();
            resolve();
          }
        });
      });
      await fresh.settings.update({ tmdbApiKey: 'cle' });
      await imported;
      expect(fresh.titles.count('movie')).toBe(4);
      expect(fresh.catalog.statuses().map((status) => status.lastError)).toEqual([null, null]);
    } finally {
      await stopServices(fresh);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
