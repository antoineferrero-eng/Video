import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { createLogger } from '../src/core/logger';
import { KeyValueCache, openDatabase, type Db } from '../src/infra/database/database';
import { EpisodeQueue, type BatchSummary } from '../src/modules/downloads/episode-queue';
import { SettingsService } from '../src/modules/settings/settings.service';
import {
  StremioAddons,
  contentIdFor,
  fileNameFromUrl,
  normalizeAddonUrl,
  parseSize,
  type AddonManifest,
} from '../src/modules/source/stremio/stremio-addon';
import {
  isVirtualPath,
  parseVirtualPath,
  safeFileName,
  virtualFilePath,
  virtualFolder,
} from '../src/modules/source/stremio/virtual-path';

const silent = createLogger({ level: 'silent', pretty: false });

describe('adresse de l’extension', () => {
  it('accepte un lien d’installation, une adresse de configuration ou le manifeste', () => {
    expect(normalizeAddonUrl('stremio://st.111477.xyz/manifest.json')).toBe(
      'https://st.111477.xyz/manifest.json',
    );
    expect(normalizeAddonUrl('st.111477.xyz')).toBe('https://st.111477.xyz/manifest.json');
    expect(normalizeAddonUrl('https://st.111477.xyz/eyJjb25maWciOjF9/')).toBe(
      'https://st.111477.xyz/eyJjb25maWciOjF9/manifest.json',
    );
    expect(normalizeAddonUrl('  ')).toBe('');
    expect(() => normalizeAddonUrl('http://')).toThrow(/invalide/);
  });
});

describe('identifiant d’un titre pour une extension', () => {
  const manifest = (idPrefixes?: string[]): AddonManifest => ({
    id: 'x',
    name: 'x',
    version: '1',
    types: ['movie', 'series'],
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes }],
  });
  const ids = { imdb: 'tt1677720', tmdb: 333339 };

  it('préfère l’identifiant IMDb, sinon tmdb:<id> si l’extension le demande', () => {
    expect(contentIdFor(manifest(), 'movie', ids)).toBe('tt1677720');
    expect(contentIdFor(manifest(['tt']), 'movie', ids)).toBe('tt1677720');
    expect(contentIdFor(manifest(['tmdb:']), 'movie', ids)).toBe('tmdb:333339');
    // Sans identifiant IMDb, une extension qui n'accepte que « tt » n'est pas interrogée.
    expect(contentIdFor(manifest(['tt']), 'movie', { imdb: null, tmdb: 333339 })).toBeNull();
    expect(contentIdFor(manifest(), 'movie', { imdb: null, tmdb: 333339 })).toBeNull();
    expect(
      contentIdFor({ ...manifest(), resources: ['catalog'] }, 'movie', { imdb: 'tt1', tmdb: 1 }),
    ).toBeNull();
  });

  it('respecte les types de titres de l’extension', () => {
    const movies: AddonManifest = {
      ...manifest(),
      resources: [{ name: 'stream', types: ['movie'] }],
    };
    expect(contentIdFor(movies, 'movie', ids)).toBe('tt1677720');
    expect(contentIdFor(movies, 'series', ids)).toBeNull();
    expect(contentIdFor({ ...manifest(), types: ['movie'] }, 'series', ids)).toBe('tt1677720');
    expect(contentIdFor({ ...movies, resources: ['stream'] }, 'series', ids)).toBe('tt1677720');
    expect(
      contentIdFor({ ...manifest(), types: ['movie'], resources: ['stream'] }, 'series', ids),
    ).toBeNull();
  });
});

describe('lecture des réponses', () => {
  it('extrait la taille et le nom du fichier', () => {
    expect(parseSize('1080p · 💾 2.1 GB')).toBe(Math.round(2.1 * 1024 ** 3));
    expect(parseSize('1,5 Go')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('700 MB')).toBe(700 * 1024 ** 2);
    expect(parseSize('aucune taille')).toBeNull();
    expect(
      fileNameFromUrl(
        'https://worker.example/play?u=https%3A%2F%2Fa.111477.xyz%2Fmovies%2FX%2FFilm.2018.1080p.mkv',
      ),
    ).toBe('Film.2018.1080p.mkv');
    expect(fileNameFromUrl('https://cdn.example/files/Film%20(2018).mp4?token=1')).toBe(
      'Film (2018).mp4',
    );
    expect(fileNameFromUrl('https://worker.example/stream/abcdef')).toBeNull();
  });

  it('donne à chaque fichier un chemin stable', () => {
    const movie = virtualFilePath({ kind: 'movie', id: 'tt1677720', fileName: 'Film.mkv' });
    expect(movie).toBe('/@stremio/movie/tt1677720/Film.mkv');
    expect(parseVirtualPath(movie)).toEqual({
      kind: 'movie',
      id: 'tt1677720',
      season: null,
      episode: null,
      fileName: 'Film.mkv',
    });
    const episode = virtualFilePath({
      kind: 'series',
      id: 'tt0903747',
      season: 1,
      episode: 3,
      fileName: 'Show.S01E03.mkv',
    });
    expect(episode).toBe('/@stremio/series/tt0903747/1x3/Show.S01E03.mkv');
    expect(parseVirtualPath(episode)).toMatchObject({ season: 1, episode: 3 });
    expect(episode.startsWith(virtualFolder('series', 'tt0903747'))).toBe(true);
    expect(isVirtualPath('/movies/Film/')).toBe(false);
    expect(safeFileName('a/b\\c\u0000.mkv')).toBe('a-b-c.mkv');
  });
});

describe('client des extensions', () => {
  let server: http.Server;
  let origin: string;
  let base: string;
  let db: Db;
  let settings: SettingsService;
  const requests: string[] = [];
  /** Réponses de chaque extension (par préfixe), par identifiant demandé. */
  let streams: Record<string, Record<string, unknown[]>> = {};
  const manifests: Record<string, unknown> = {
    cfg: {
      id: 'test',
      name: 'Test',
      version: '2.0.0',
      types: ['movie', 'series'],
      resources: ['stream'],
      idPrefixes: ['tt'],
    },
    second: {
      id: 'second',
      name: 'Seconde',
      version: '1.0.0',
      types: ['movie'],
      resources: ['stream'],
      idPrefixes: ['tt'],
    },
    tmdb: {
      id: 'tmdb',
      name: 'Par TMDB',
      version: '1.0.0',
      types: ['movie', 'series'],
      resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tmdb:'] }],
    },
  };

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      requests.push(decodeURIComponent(url.pathname));
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const manifest = /^\/(\w+)\/manifest\.json$/.exec(url.pathname);
      if (manifest?.[1]) {
        const body = manifests[manifest[1]];
        return body ? send(200, body) : send(500, { error: 'panne' });
      }
      const match = /^\/(\w+)\/stream\/(movie|series)\/(.+)\.json$/.exec(url.pathname);
      if (match?.[1] && match[3])
        return send(200, { streams: streams[match[1]]?.[decodeURIComponent(match[3])] ?? [] });
      send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `${origin}/cfg`;
    db = openDatabase(':memory:', silent);
    settings = new SettingsService(db, loadConfig({ LOG_LEVEL: 'silent' }));
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  beforeEach(async () => {
    requests.length = 0;
    db.exec('DELETE FROM kv_cache');
    await settings.update({ stremioAddonUrls: [base] });
  });

  const addons = (options: ConstructorParameters<typeof StremioAddons>[3] = {}) =>
    new StremioAddons(settings, new KeyValueCache(db), silent, options);

  it('liste les fichiers d’un film, sans doublon, et garde la réponse', async () => {
    streams = {
      cfg: {
        tt1677720: [
          {
            name: '111477\n1080p',
            title: 'Ready.Player.One.2018.1080p.mkv\n💾 2.1 GB',
            url: 'https://w.example/a/Ready.Player.One.2018.1080p.mkv',
            behaviorHints: { proxyHeaders: { request: { referer: 'https://a.111477.xyz/' } } },
          },
          {
            name: 'miroir',
            title: 'Ready.Player.One.2018.1080p.mkv',
            url: 'https://mirror.example/Ready.Player.One.2018.1080p.mkv',
          },
          {
            name: '111477\n2160p',
            url: 'https://w.example/b',
            behaviorHints: { filename: 'Ready.Player.One.2018.2160p.mkv', videoSize: 42 },
          },
        ],
      },
    };
    const client = addons();
    expect(client.manifestUrls).toEqual([`${base}/manifest.json`]);
    const result = await client.files({ kind: 'movie', id: 'tt1677720' });
    expect(result.limited).toBe(false);
    expect(result.files).toEqual([
      {
        path: '/@stremio/movie/tt1677720/Ready.Player.One.2018.1080p.mkv',
        fileName: 'Ready.Player.One.2018.1080p.mkv',
        size: Math.round(2.1 * 1024 ** 3),
        label: '111477 · 1080p · 💾 2.1 GB',
        addon: 'Test',
      },
      {
        path: '/@stremio/movie/tt1677720/Ready.Player.One.2018.2160p.mkv',
        fileName: 'Ready.Player.One.2018.2160p.mkv',
        size: 42,
        label: '111477 · 2160p',
        addon: 'Test',
      },
    ]);
    expect(await client.links(result.files[0]!.path)).toEqual([
      {
        url: 'https://w.example/a/Ready.Player.One.2018.1080p.mkv',
        headers: { referer: 'https://a.111477.xyz/' },
        addon: 'Test',
      },
    ]);

    // Réponse gardée en base : aucune nouvelle demande de liens.
    await client.files({ kind: 'movie', id: 'tt1677720' });
    await addons().links(result.files[1]!.path);
    expect(requests.filter((path) => path.includes('/stream/'))).toEqual([
      '/cfg/stream/movie/tt1677720.json',
    ]);
  });

  it('demande un épisode avec son code saison:épisode', async () => {
    streams = {
      cfg: { 'tt0903747:1:3': [{ name: 'x', url: 'https://w.example/Show.S01E03.720p.mkv' }] },
    };
    const result = await addons().files({
      kind: 'series',
      id: 'tt0903747',
      season: 1,
      episode: 3,
    });
    expect(result.files.map((file) => file.path)).toEqual([
      '/@stremio/series/tt0903747/1x3/Show.S01E03.720p.mkv',
    ]);
    expect(requests).toContain('/cfg/stream/series/tt0903747:1:3.json');
  });

  it('signale la limite de liens et redemande vite une réponse limitée', async () => {
    streams = { cfg: { tt1: [{ name: '111477', title: '⚠️ Slow down — rate limit reached' }] } };
    const client = addons();
    const limited = await client.files({ kind: 'movie', id: 'tt1' });
    expect(limited.files).toEqual([]);
    expect(limited.limited).toBe(true);
    expect(limited.notice).toMatch(/limite de liens.*Slow down/);
    // Gardée quelques minutes seulement : expirée, elle est redemandée.
    db.exec('UPDATE kv_cache SET expires_at = 0');
    streams = { cfg: { tt1: [{ name: 'x', url: 'https://w.example/Film.mkv' }] } };
    const fresh = await client.files({ kind: 'movie', id: 'tt1' });
    expect(fresh.files).toHaveLength(1);
    expect(fresh.limited).toBe(false);
  });

  it('garde les liens déjà obtenus quand un renouvellement tombe sur la limite', async () => {
    streams = { cfg: { tt3: [{ name: 'x', url: 'https://w.example/Film.mkv?jeton=1' }] } };
    const client = addons();
    const path = '/@stremio/movie/tt3/Film.mkv';
    await client.links(path);
    streams = { cfg: { tt3: [{ name: '111477', title: '⚠️ Slow down — rate limit reached' }] } };
    const [refreshed] = await client.links(path, { refresh: true });
    expect(refreshed?.url).toBe('https://w.example/Film.mkv?jeton=1');
    const result = await client.files({ kind: 'movie', id: 'tt3' });
    expect(result.limited).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual([path]);
  });

  it('redemande le lien d’un fichier absent de la réponse gardée', async () => {
    streams = { cfg: { tt2: [{ name: 'x', url: 'https://w.example/Old.mkv' }] } };
    const client = addons();
    await client.files({ kind: 'movie', id: 'tt2' });
    streams = { cfg: { tt2: [{ name: 'x', url: 'https://w.example/New.mkv' }] } };
    await expect(client.links('/@stremio/movie/tt2/New.mkv')).resolves.toMatchObject([
      { url: 'https://w.example/New.mkv' },
    ]);
    await expect(client.links('/@stremio/movie/tt2/Gone.mkv')).rejects.toThrow(/ne propose plus/);
  });

  describe('plusieurs extensions', () => {
    beforeEach(async () => {
      await settings.update({
        stremioAddonUrls: [base, `${origin}/second`, `${origin}/tmdb`],
      });
    });

    it('réunit leurs fichiers, dans l’ordre des extensions, avec un lien chez chacune', async () => {
      streams = {
        cfg: { tt5: [{ name: 'A', url: 'https://a.example/Film.1080p.mkv' }] },
        second: {
          tt5: [
            { name: 'B', url: 'https://b.example/Film.1080p.mkv' },
            { name: 'B', url: 'https://b.example/Film.720p.mkv' },
          ],
        },
        tmdb: { 'tmdb:55': [{ name: 'Par TMDB\n4K', url: 'https://c.example/Film.2160p.mkv' }] },
      };
      const client = addons();
      const result = await client.files({ kind: 'movie', id: 'tt5', tmdb: 55 });
      expect(result.files.map((file) => [file.fileName, file.addon, file.label])).toEqual([
        ['Film.1080p.mkv', 'Test', 'Test · A'],
        ['Film.720p.mkv', 'Seconde', 'Seconde · B'],
        // Nom déjà dans la description : pas répété.
        ['Film.2160p.mkv', 'Par TMDB', 'Par TMDB · 4K'],
      ]);
      // Le chemin ne dépend pas de l'extension : il porte l'identifiant IMDb du titre.
      expect(result.files[2]!.path).toBe('/@stremio/movie/tt5/Film.2160p.mkv');
      expect(requests).toContain('/tmdb/stream/movie/tmdb:55.json');
      expect(
        (await client.links('/@stremio/movie/tt5/Film.1080p.mkv')).map((link) => link.addon),
      ).toEqual(['Test', 'Seconde']);
    });

    it('n’interroge que les extensions qui gèrent ce type de titre', async () => {
      streams = { cfg: { 'tt6:1:1': [{ name: 'A', url: 'https://a.example/S01E01.mkv' }] } };
      const result = await addons({ tmdbIdOf: () => null }).files({
        kind: 'series',
        id: 'tt6',
        season: 1,
        episode: 1,
      });
      expect(result.files).toHaveLength(1);
      // « Seconde » ne propose que des films ; « Par TMDB » n'a pas d'identifiant TMDB.
      expect(requests.filter((path) => path.includes('/stream/'))).toEqual([
        '/cfg/stream/series/tt6:1:1.json',
      ]);
    });

    it('retrouve l’identifiant TMDB d’un chemin pour l’extension qui le demande', async () => {
      streams = { tmdb: { 'tmdb:77': [{ name: 'C', url: 'https://c.example/Film.mkv' }] } };
      const client = addons({
        tmdbIdOf: (kind, id) => (kind === 'movie' && id === 'tt7' ? 77 : null),
      });
      const [link] = await client.links('/@stremio/movie/tt7/Film.mkv');
      expect(link).toMatchObject({ url: 'https://c.example/Film.mkv', addon: 'Par TMDB' });
    });

    it('ne mêle pas deux fichiers du même nom mais de tailles différentes', async () => {
      streams = {
        cfg: {
          tt8: [{ url: 'https://a.example/Film.mkv', behaviorHints: { videoSize: 100 } }],
        },
        second: {
          tt8: [{ url: 'https://b.example/Film.mkv', behaviorHints: { videoSize: 200 } }],
        },
      };
      const links = await addons().links('/@stremio/movie/tt8/Film.mkv');
      expect(links.map((link) => link.url)).toEqual(['https://a.example/Film.mkv']);
    });

    it('signale une extension injoignable sans priver des autres', async () => {
      await settings.update({ stremioAddonUrls: [`${origin}/down`, base] });
      streams = { cfg: { tt9: [{ name: 'A', url: 'https://a.example/Film.mkv' }] } };
      const result = await addons().files({ kind: 'movie', id: 'tt9' });
      expect(result.files.map((file) => file.addon)).toEqual(['Test']);
      expect(result.limited).toBe(true);
      expect(result.notice).toMatch(/^127\.0\.0\.1:\d+ : L’extension Stremio a répondu 500/);

      await settings.update({ stremioAddonUrls: [`${origin}/down`] });
      await expect(addons().files({ kind: 'movie', id: 'tt9' })).rejects.toThrow(/répondu 500/);
    });
  });
});

describe('file des épisodes à demander', () => {
  it('demande les épisodes un par un et abandonne le lot à la limite de liens', async () => {
    const handled: string[] = [];
    const summaries: BatchSummary[] = [];
    const queue = new EpisodeQueue(
      async (_titleId, target) => {
        handled.push(`${target.season}x${target.episode}`);
        if (target.episode === 2)
          return { status: 'skipped', reason: 'limite atteinte', limited: true };
        return { status: 'added', limited: false };
      },
      (summary) => summaries.push(summary),
      silent,
      0,
    );
    const targets = [1, 2, 3, 4].map((episode) => ({ season: 1, episode }));
    expect(queue.add(7, 'Série · saison 1', targets)).toBe(4);
    // Déjà en file : pas ajoutés une seconde fois.
    expect(queue.add(7, 'Série · saison 1', targets.slice(0, 2))).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handled).toEqual(['1x1', '1x2']);
    expect(summaries).toEqual([
      {
        label: 'Série · saison 1',
        added: 1,
        skipped: [{ code: 'S01E02', reason: 'limite atteinte' }],
        abandoned: 2,
      },
    ]);
    expect(queue.pendingFor(7)).toBe(0);
  });
});
