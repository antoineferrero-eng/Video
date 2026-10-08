import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { pickBestMatch } from '../src/modules/metadata/metadata.service';
import { listen, tmdbCatalogRoute, type FakeTitle } from './helpers/fakes';

/**
 * Enrichissement TMDB de bout en bout contre un faux serveur reproduisant l'API v3 :
 * listes, détails localisés, saisons/épisodes et cache des images.
 */
const TITLES: FakeTitle[] = [
  { id: 603, kind: 'movie', name: 'Matrix', date: '1999-03-31', imdb: 'tt0133093' },
  { id: 70523, kind: 'tv', name: 'Dark', date: '2017-12-01', imdb: 'tt5753856' },
];
let tmdb: http.Server;
let container: Container;
let dataDir: string;
const requests: string[] = [];

beforeAll(async () => {
  tmdb = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    // Le CDN d'images de TMDB ne demande pas de clé, contrairement à l'API.
    if (url.pathname.startsWith('/images/')) {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      return response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (url.searchParams.get('api_key') !== 'secret') return json({ status_code: 7 }, 401);
    switch (url.pathname) {
      case '/3/search/movie':
        if (url.searchParams.get('query') === 'The Matrix') {
          return json({
            results: [
              {
                id: 999,
                title: 'Matrix Reloaded',
                original_title: 'The Matrix Reloaded',
                release_date: '2003-05-15',
                vote_count: 9000,
              },
              {
                id: 603,
                title: 'Matrix',
                original_title: 'The Matrix',
                release_date: '1999-03-31',
                vote_count: 25000,
              },
            ],
            total_results: 2,
          });
        }
        return json({ results: [], total_results: 0 });
      case '/3/movie/603':
        return json({
          id: 603,
          title: 'Matrix',
          original_title: 'The Matrix',
          overview: 'Programmeur le jour, pirate la nuit…',
          tagline: 'Bienvenue dans le monde réel.',
          runtime: 136,
          release_date: '1999-03-31',
          genres: [
            { id: 28, name: 'Action' },
            { id: 878, name: 'Science-Fiction' },
          ],
          poster_path: '/matrix.jpg',
          backdrop_path: '/matrix-bg.jpg',
          vote_average: 8.2,
          vote_count: 25000,
        });
      case '/3/search/tv':
        return json({
          results: [
            {
              id: 70523,
              name: 'Dark',
              original_name: 'Dark',
              first_air_date: '2017-12-01',
              vote_count: 6000,
            },
          ],
          total_results: 1,
        });
      case '/3/tv/70523':
        return json({
          id: 70523,
          name: 'Dark',
          original_name: 'Dark',
          overview: 'Une série allemande.',
          tagline: '',
          episode_run_time: [53],
          first_air_date: '2017-12-01',
          genres: [{ id: 18, name: 'Drame' }],
          poster_path: '/dark.jpg',
          backdrop_path: null,
          vote_average: 8.4,
          vote_count: 6000,
          seasons: [
            { season_number: 1, episode_count: 1, name: 'Saison 1', poster_path: '/dark-s1.jpg' },
          ],
        });
      case '/3/tv/70523/season/1':
        return json({
          season_number: 1,
          name: 'Saison 1',
          overview: 'Winden, 2019.',
          poster_path: '/dark-s1.jpg',
          episodes: [
            {
              episode_number: 1,
              name: 'Secrets',
              overview: 'Un enfant disparaît.',
              still_path: '/e1.jpg',
              air_date: '2017-12-01',
              runtime: 51,
            },
          ],
        });
      default:
        if (tmdbCatalogRoute(TITLES, url.pathname.replace(/^\/3/, ''), response)) return;
        return json({ status_code: 34 }, 404);
    }
  });
  const tmdbUrl = await listen(tmdb);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-meta-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    STREMIO_ADDON_URLS: '',
    TMDB_API_KEY: 'secret',
    TMDB_API_BASE_URL: `${tmdbUrl}/3`,
    TMDB_IMAGE_BASE_URL: `${tmdbUrl}/images`,
    LOG_LEVEL: 'silent',
  });
  container = createContainer(config, createLogger({ level: 'silent', pretty: false }));
  await container.catalog.refresh('movie');
  await container.catalog.refresh('series');
});

afterAll(async () => {
  await stopServices(container);
  tmdb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('enrichissement TMDB', () => {
  it('choisit le bon résultat grâce au titre exact et à l’année', () => {
    const match = pickBestMatch(
      [
        {
          id: 1,
          title: 'Matrix Reloaded',
          original_title: 'The Matrix Reloaded',
          release_date: '2003-05-15',
        },
        { id: 2, title: 'Matrix', original_title: 'The Matrix', release_date: '1999-03-31' },
      ],
      'The Matrix',
      1999,
    );
    expect(match?.id).toBe(2);
    expect(
      pickBestMatch(
        [{ id: 3, title: 'Autre chose', release_date: '1980-01-01' }],
        'The Matrix',
        1999,
      ),
    ).toBeNull();
  });

  it('récupère les métadonnées d’un film (titre localisé, genres, affiche)', async () => {
    const [title] = (await container.catalog.search({ kind: 'movie', q: 'matrix' })).items;
    const details = await container.catalog.details(title!.id);
    expect(details).toMatchObject({
      title: 'Matrix',
      originalTitle: 'The Matrix',
      year: 1999,
      tmdbId: 603,
      metadataStatus: 'matched',
      genres: ['Action', 'Science-Fiction'],
      rating: 8.2,
      runtime: 136,
      posterUrl: '/api/images/w342/matrix.jpg',
    });
    // La recherche fonctionne aussi sur le titre TMDB.
    expect((await container.catalog.search({ q: 'monde reel' })).items).toHaveLength(0);
    expect((await container.catalog.search({ q: 'matrix' })).items[0]?.title).toBe('Matrix');
  });

  it('enrichit les épisodes d’une série et met les images en cache', async () => {
    const [series] = (await container.catalog.search({ kind: 'series' })).items;
    const details = await container.catalog.details(series!.id);
    expect(details.title).toBe('Dark');
    expect(details.seasons[0]).toMatchObject({ name: 'Saison 1', overview: 'Winden, 2019.' });
    expect(details.seasons[0]?.episodes[0]).toMatchObject({
      title: 'Secrets',
      stillUrl: '/api/images/w300/e1.jpg',
      runtime: 51,
    });
    const local = await container.images.get('w300', 'e1.jpg');
    expect(fs.existsSync(local)).toBe(true);
    await container.images.get('w300', 'e1.jpg');
    expect(requests.filter((request) => request.startsWith('/images/w300/e1.jpg'))).toHaveLength(1);
  });
});
