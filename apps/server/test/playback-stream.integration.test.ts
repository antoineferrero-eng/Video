import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlaybackSession } from '@lumiere/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';
import { addonRoute, sendBytes } from './helpers/fakes';

/**
 * Test d'intégration du flux relancé (ffmpeg réel, à travers le relais) : un MKV dont les
 * images clés sont espacées de 10 s est lu sans être téléchargé, puis repositionné.
 */
const hasFfmpeg =
  spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 &&
  spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;

const FILE_NAME = 'Film.2024.1080p.WEB.H264.AC3-GRP.mkv';
const FILE_PATH = `/@stremio/movie/tt0000001/${FILE_NAME}`;
const CHROME = {
  videoCodecs: ['h264', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
  containers: ['mp4', 'webm'],
};

let workDir: string;
let media: Buffer;
let source: http.Server;
let container: Container;
let app: FastifyInstance;
let origin: string;
/** Coupe l'hôte du lien (réponses 404) pour simuler un fichier devenu inaccessible. */
let sourceDown = false;
let baseUrl = '';

const addon = addonRoute({
  prefix: '/addon',
  base: () => baseUrl,
  get streams() {
    return { tt0000001: [{ fileName: FILE_NAME, bytes: media }] };
  },
  serve: (request, response, file) => {
    if (sourceDown) response.writeHead(404).end();
    else sendBytes(request, response, file.bytes);
  },
});

function startSource(): Promise<string> {
  source = http.createServer((request, response) => {
    if (!addon(request, response)) response.writeHead(404).end();
  });
  return new Promise((resolve) =>
    source.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(source.address() as AddressInfo).port}`),
    ),
  );
}

async function createSession(): Promise<PlaybackSession> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/playback/sessions',
    payload: { media: { type: 'remote', path: FILE_PATH }, capabilities: CHROME },
  });
  expect(response.statusCode).toBe(200);
  return response.json<PlaybackSession>();
}

/** Lit le début d'un flux puis coupe la connexion (comme un lecteur qui change de position). */
async function readStreamStart(url: string): Promise<{ status: number; head: Buffer }> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${url}`, { signal: controller.signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return { status: response.status, head: Buffer.alloc(0) };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < 32 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  controller.abort();
  return { status: response.status, head: Buffer.concat(chunks) };
}

async function streamOrigin(session: PlaybackSession, streamId: string) {
  const response = await fetch(
    `${origin}/api/playback/sessions/${session.sessionId}/streams/${streamId}/origin`,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!hasFfmpeg)('flux relancé (ffmpeg)', () => {
  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-stream-'));
    const file = path.join(workDir, 'film.mkv');
    const generated = spawnSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3'],
      ...['-g', '240', '-keyint_min', '240', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'ac3', '-b:a', '96k', file],
    ]);
    expect(generated.status).toBe(0);
    media = fs.readFileSync(file);

    baseUrl = await startSource();
    const config = loadConfig({
      DATA_DIR: path.join(workDir, 'data'),
      STREMIO_ADDON_URLS: `${baseUrl}/addon/manifest.json`,
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
    });
    container = createContainer(config, createLogger({ level: 'silent', pretty: false }));
    await container.ffmpeg.detect();
    app = await buildApp(container);
    await app.listen({ host: '127.0.0.1', port: 0 });
    container.relay.setListeningAddress(app.server.address());
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (container) await stopServices(container);
    source?.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('repart de l’image clé précédente et en donne l’instant exact', async () => {
    const session = await createSession();
    expect(session.mode).toBe('remux');
    const streamed = await readStreamStart(`${session.streamUrl}?start=37&stream=a1`);
    expect(streamed.status).toBe(200);
    expect(streamed.head.subarray(4, 8).toString()).toBe('ftyp');
    const result = await streamOrigin(session, 'a1');
    expect(result.status).toBe(200);
    expect(result.body.start).toBeCloseTo(30, 1);
  }, 30_000);

  it('un nouveau positionnement remplace le flux en cours', async () => {
    const session = await createSession();
    const first = readStreamStart(`${session.streamUrl}?start=12&stream=b1`);
    const second = await readStreamStart(`${session.streamUrl}?start=47&stream=b2`);
    await first.catch(() => undefined);
    expect(second.status).toBe(200);
    expect(second.head.subarray(4, 8).toString()).toBe('ftyp');
    expect((await streamOrigin(session, 'b2')).body.start).toBeCloseTo(40, 1);
  }, 30_000);

  it('refuse la reprise au milieu d’un flux produit à la volée', async () => {
    const session = await createSession();
    const response = await fetch(`${origin}${session.streamUrl}?start=0`, {
      headers: { range: 'bytes=5000-' },
    });
    await response.body?.cancel();
    expect(response.status).toBe(416);
  });

  it('signale un échec au lieu d’envoyer un flux vide', async () => {
    const session = await createSession();
    sourceDown = true;
    try {
      const streamed = await readStreamStart(`${session.streamUrl}?start=20&stream=c1`);
      expect(streamed.status).toBe(502);
      const result = await streamOrigin(session, 'c1');
      expect(result.status).toBe(502);
      expect(String(result.body.message)).toMatch(/conversion vidéo a échoué/);
    } finally {
      sourceDown = false;
    }
  }, 30_000);
});
