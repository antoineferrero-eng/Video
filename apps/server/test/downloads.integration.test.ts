import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadItem, ServerEvent } from '@lumiere/shared';
import { loadConfig } from '../src/config/env';
import { createContainer, stopServices, type Container } from '../src/container';
import { createLogger } from '../src/core/logger';

/**
 * Test d'intégration : un mini index HTTP (listing <pre> façon nginx + Range) sert un
 * « film » ; on vérifie catalogue, téléchargement, pause/reprise et intégrité du fichier.
 */
const FILE_SIZE = 3 * 1024 * 1024;
const content = crypto.randomBytes(FILE_SIZE);
const checksum = crypto.createHash('sha256').update(content).digest('hex');
const FILE_NAME = 'Test.Movie.2024.1080p.WEB-DL.H264-GRP.mkv';

let server: http.Server;
let container: Container;
let dataDir: string;
const rangeRequests: string[] = [];

function startSourceServer(): Promise<string> {
  server = http.createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    if (url === '/movies/') {
      response.end(
        `<html><body><pre><a href="../">../</a>\n<a href="Test%20Movie%20(2024)/">Test Movie (2024)/</a>   01-Jan-2025 10:00   -\n</pre></body></html>`,
      );
    } else if (url === '/tvs/') {
      response.end(
        '<html><body><pre><a href="../">../</a>\n<a href="Show/">Show/</a>   01-Jan-2025 10:00   -\n</pre></body></html>',
      );
    } else if (url === '/movies/Test Movie (2024)/') {
      response.end(
        `<html><body><pre><a href="../">../</a>\n<a href="${encodeURIComponent(FILE_NAME)}">${FILE_NAME}</a>   01-Jan-2025 10:00   ${FILE_SIZE}\n</pre></body></html>`,
      );
    } else if (url === `/movies/Test Movie (2024)/${FILE_NAME}`) {
      const match = /bytes=(\d+)-/.exec(request.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      if (request.headers.range) rangeRequests.push(request.headers.range);
      response.writeHead(match ? 206 : 200, {
        'content-length': FILE_SIZE - start,
        'accept-ranges': 'bytes',
        ...(match ? { 'content-range': `bytes ${start}-${FILE_SIZE - 1}/${FILE_SIZE}` } : {}),
      });
      // Envoi lent (16 Kio toutes les 10 ms) pour pouvoir mettre en pause en cours de route.
      let offset = start;
      const timer = setInterval(() => {
        if (offset >= FILE_SIZE) {
          clearInterval(timer);
          response.end();
          return;
        }
        const end = Math.min(FILE_SIZE, offset + 16 * 1024);
        response.write(content.subarray(offset, end));
        offset = end;
      }, 10);
      response.on('close', () => clearInterval(timer));
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function waitFor(
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 15_000,
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
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
  const baseUrl = await startSourceServer();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    SOURCE_BASE_URL: baseUrl,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
  });
  container = createContainer(config, createLogger({ level: 'silent', pretty: false }));
  container.downloads.start();
});

afterAll(async () => {
  await stopServices(container);
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('catalogue + téléchargements', () => {
  it('indexe la section films', async () => {
    const status = await container.catalog.refresh('movie');
    expect(status.count).toBe(1);
    const page = await container.catalog.search({ kind: 'movie', q: 'test movie' });
    expect(page.items[0]).toMatchObject({ title: 'Test Movie', year: 2024 });
  });

  it('télécharge, met en pause, reprend (Range) et produit un fichier intact', async () => {
    const [title] = (await container.catalog.search({ kind: 'movie' })).items;
    const result = await container.downloads.enqueueTitle(title!.id);
    expect(result.created).toHaveLength(1);
    const id = (result.created[0] as DownloadItem).id;

    await waitFor(
      (event) =>
        event.type === 'download.updated' &&
        event.download.id === id &&
        event.download.downloadedBytes > 256 * 1024,
    );
    container.downloads.pause(id);
    await waitFor(
      (event) =>
        event.type === 'download.updated' &&
        event.download.id === id &&
        event.download.status === 'paused',
    );
    // Laisse la tâche se terminer proprement avant de reprendre.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const paused = container.downloads.get(id);
    expect(paused.downloadedBytes).toBeGreaterThan(0);
    expect(paused.downloadedBytes).toBeLessThan(FILE_SIZE);

    container.downloads.resume(id);
    const done = await waitFor(
      (event) =>
        event.type === 'download.updated' &&
        event.download.id === id &&
        event.download.status === 'completed',
    );
    const item = (done as Extract<ServerEvent, { type: 'download.updated' }>).download;
    expect(item.targetPath).toContain(path.join('Films', 'Test Movie (2024)', FILE_NAME));
    const written = fs.readFileSync(item.targetPath);
    expect(written.length).toBe(FILE_SIZE);
    expect(crypto.createHash('sha256').update(written).digest('hex')).toBe(checksum);
    expect(rangeRequests.some((range) => range !== 'bytes=0-')).toBe(true);

    const library = container.library.list();
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({ kind: 'movie', title: 'Test Movie', exists: true });
  });

  it('refuse de re-télécharger un fichier déjà présent', async () => {
    const [title] = (await container.catalog.search({ kind: 'movie' })).items;
    const result = container.downloads.enqueueFiles([
      { path: `/movies/Test Movie (2024)/${FILE_NAME}`, titleId: title!.id },
    ]);
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/bibliothèque/);
  });
});
