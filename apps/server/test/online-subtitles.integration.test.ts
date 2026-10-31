import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OnlineSubtitlesResult, PlaybackSession } from '@lumiere/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { openSubtitlesHash } from '../src/modules/subtitles/opensubtitles-hash';
import { addonRoute, listen, tmdbCatalogRoute } from './helpers/fakes';

/**
 * Sous-titres en ligne de bout en bout : un film lu sans être téléchargé (relais), son
 * empreinte calculée à distance, un faux OpenSubtitles.com et une fausse extension Stremio
 * de sous-titres (à côté de celle qui fournit le fichier).
 */
const hasFfmpeg =
  spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 &&
  spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;

const FILE_NAME = 'Ready.Player.One.2018.1080p.WEB.H264.AC3-GRP.mkv';
const FILE_PATH = `/@stremio/movie/tt1677720/${FILE_NAME}`;
const CHROME = {
  videoCodecs: ['h264', 'vp9'],
  audioCodecs: ['aac', 'opus'],
  containers: ['mp4', 'webm'],
};
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nBonjour à tous\n';

let workDir: string;
let media: Buffer;
let server: http.Server;
let base: string;
let container: Container;
let app: FastifyInstance;
const searches: URLSearchParams[] = [];
const addonRequests: string[] = [];
let downloads = 0;

const streams = addonRoute({
  prefix: '/streams',
  base: () => base,
  get streams() {
    return { tt1677720: [{ fileName: FILE_NAME, bytes: media }] };
  },
});

function startServer(): Promise<string> {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    const send = (status: number, body: unknown) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    // --- TMDB (catalogue) et extension qui fournit le fichier (Range)
    if (streams(request, response)) return;
    if (
      tmdbCatalogRoute(
        [
          {
            id: 333339,
            kind: 'movie',
            name: 'Ready Player One',
            date: '2018-03-28',
            imdb: 'tt1677720',
          },
        ],
        pathname.replace(/^\/3/, ''),
        response,
      )
    )
      return;

    // --- Faux OpenSubtitles.com
    // Lien temporaire : téléchargeable sans clé, comme chez OpenSubtitles.
    if (pathname === '/os/files/13.srt') return void response.end(SRT);
    if (pathname.startsWith('/os/')) {
      if (request.headers['api-key'] !== 'cle') return send(403, { message: 'Invalid API key' });
      if (pathname === '/os/api/v1/subtitles') {
        searches.push(url.searchParams);
        const attributes = (fileId: number, language: string, match: boolean, count: number) => ({
          attributes: {
            language,
            release: `Ready.Player.One.${fileId}`,
            download_count: count,
            moviehash_match: match,
            hearing_impaired: false,
            files: [{ file_id: fileId, file_name: `${fileId}.srt` }],
          },
        });
        return send(200, {
          data: [
            attributes(11, 'en', false, 900),
            attributes(12, 'fr', false, 5000),
            attributes(13, 'fr', true, 10),
          ],
        });
      }
      if (pathname === '/os/api/v1/download' && request.method === 'POST') {
        downloads += 1;
        return send(200, { link: `${base}/os/files/13.srt`, file_name: '13.srt', remaining: 9 });
      }
    }

    // --- Fausse extension Stremio de sous-titres
    if (pathname === '/addon/manifest.json') {
      return send(200, {
        id: 'subs',
        name: 'Sous-titres test',
        version: '1.0.0',
        types: ['movie', 'series'],
        resources: ['subtitles'],
        idPrefixes: ['tt'],
      });
    }
    if (pathname.startsWith('/addon/subtitles/')) {
      addonRequests.push(pathname);
      return send(200, {
        subtitles: [{ id: 'a1', url: `${base}/addon/files/a1.vtt`, lang: 'fre' }],
      });
    }
    if (pathname === '/addon/files/a1.vtt') {
      return void response.end('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nDepuis l’extension\n');
    }
    response.writeHead(404).end();
  });
  return listen(server);
}

describe.skipIf(!hasFfmpeg)('sous-titres en ligne', () => {
  let session: PlaybackSession;
  let origin: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-subs-'));
    const file = path.join(workDir, 'film.mkv');
    const generated = spawnSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', file],
    ]);
    expect(generated.status).toBe(0);
    media = fs.readFileSync(file);
    base = await startServer();

    const config = loadConfig({
      DATA_DIR: path.join(workDir, 'data'),
      STREMIO_ADDON_URLS: `${base}/streams/manifest.json`,
      TMDB_API_KEY: 'tmdb',
      TMDB_API_BASE_URL: `${base}/3`,
      OPENSUBTITLES_API_KEY: 'cle',
      OPENSUBTITLES_API_URL: `${base}/os/api/v1`,
      SUBTITLE_ADDON_URLS: `${base}/addon/manifest.json`,
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
    });
    container = createContainer(config, createLogger({ level: 'silent', pretty: false }));
    await container.ffmpeg.detect();
    await container.settings.update({ preferredSubtitleLanguage: 'fr' });
    app = await buildApp(container);
    await app.listen({ host: '127.0.0.1', port: 0 });
    container.relay.setListeningAddress(app.server.address());
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    await container.catalog.refresh('movie');
    const [title] = (await container.catalog.search({ kind: 'movie' })).items;
    // Versions demandées : le titre est rattaché à son identifiant IMDb et à ses fichiers.
    await container.catalog.movieVersions(title!.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/playback/sessions',
      payload: { media: { type: 'remote', path: FILE_PATH }, capabilities: CHROME },
    });
    expect(response.statusCode).toBe(200);
    session = response.json<PlaybackSession>();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (container) await stopServices(container);
    server?.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('signale que la langue préférée manque dans le fichier', () => {
    expect(session.onlineSubtitles).toEqual({ available: true, autoLanguage: 'fr' });
  });

  it('interroge les deux services avec l’identifiant IMDb et l’empreinte du fichier', async () => {
    const response = await fetch(
      `${origin}/api/playback/sessions/${session.sessionId}/subtitles/online`,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as OnlineSubtitlesResult;
    expect(result.notices).toEqual([]);
    expect(result.providers.sort()).toEqual(['OpenSubtitles', 'Sous-titres test']);

    const hash = await openSubtitlesHash(media.length, async (start, length) =>
      media.subarray(start, start + length),
    );
    const sent = searches.at(-1);
    expect(sent?.get('imdb_id')).toBe('1677720');
    expect(sent?.get('languages')).toBe('en,fr');
    expect(sent?.get('moviehash')).toBe(hash);
    expect(addonRequests.at(-1)).toBe(
      `/addon/subtitles/movie/tt1677720/filename=${FILE_NAME}&videoHash=${hash}&videoSize=${media.length}.json`,
    );

    // Français d'abord, le fichier exact en tête ; l'anglais ensuite.
    expect(result.tracks.map((track) => [track.language, track.provider, track.hashMatch])).toEqual(
      [
        ['fr', 'OpenSubtitles', true],
        ['fr', 'OpenSubtitles', false],
        ['fr', 'Sous-titres test', false],
        ['en', 'OpenSubtitles', false],
      ],
    );
    expect(result.tracks[0]).toMatchObject({
      source: 'online',
      label: 'Français · Ready.Player.One.13',
    });
  });

  it('télécharge une seule fois et convertit en WebVTT', async () => {
    const result = (await (
      await fetch(`${origin}/api/playback/sessions/${session.sessionId}/subtitles/online`)
    ).json()) as OnlineSubtitlesResult;
    const [best, , fromAddon] = result.tracks;
    const url = (id: string) =>
      `${origin}/api/playback/sessions/${session.sessionId}/subtitles/${encodeURIComponent(id)}`;

    const first = await fetch(url(best!.id));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nBonjour à tous\n');
    // Nouvelle session (même fichier) : servi depuis le cache disque, sans nouveau téléchargement.
    const again = await app.inject({
      method: 'POST',
      url: '/api/playback/sessions',
      payload: { media: { type: 'remote', path: FILE_PATH }, capabilities: CHROME },
    });
    const other = again.json<PlaybackSession>();
    // Piste trouvée par une session précédente : chargée sans nouvelle recherche.
    const cached = await fetch(
      `${origin}/api/playback/sessions/${other.sessionId}/subtitles/${encodeURIComponent(best!.id)}`,
    );
    expect(await cached.text()).toContain('Bonjour à tous');
    expect(downloads).toBe(1);

    const vtt = await fetch(url(fromAddon!.id));
    expect(await vtt.text()).toContain('Depuis l’extension');
  });

  it('teste les services depuis les paramètres', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-subtitles',
      payload: {},
    });
    expect(response.json()).toEqual({
      providers: [
        { name: 'OpenSubtitles.com', ok: true, message: expect.stringMatching(/Clé valide/) },
        {
          name: 'Sous-titres test',
          ok: true,
          message: 'Sous-titres test 1.0.0 : sous-titres de films et de séries.',
        },
      ],
    });
  });
});
