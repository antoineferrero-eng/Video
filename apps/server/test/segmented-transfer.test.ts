import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger';
import { ByteRanges } from '../src/modules/downloads/byte-ranges';
import {
  SegmentedTransfer,
  progressFile,
  type Tuning,
} from '../src/modules/downloads/segmented-transfer';

/**
 * Téléchargement en plusieurs morceaux simultanés, contre un hôte qui bride chaque connexion
 * (environ 1,3 Mo/s), refuse parfois les connexions en trop ou ignore les plages.
 */
const SIZE = 4 * 1024 * 1024;
const content = crypto.randomBytes(SIZE);
const checksum = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const silent = createLogger({ level: 'silent', pretty: false });
const FAST: Partial<Tuning> = { minSegment: 128 * 1024, evaluateEveryMs: 150, persistEveryMs: 20 };

interface HostOptions {
  /** Connexions servies en même temps au plus (au-delà : 429). */
  maxConnections?: number;
  ignoreRanges?: boolean;
}

let host: HostOptions = {};
let server: http.Server;
let url = '';
let dir: string;
let active = 0;
let peak = 0;
let sent = 0;
const requested: string[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    requested.push(request.headers.range ?? '');
    if (host.maxConnections !== undefined && active >= host.maxConnections) {
      response.writeHead(429).end();
      return;
    }
    const start = range && !host.ignoreRanges ? Number(range[1]) : 0;
    const end = range && !host.ignoreRanges && range[2] ? Number(range[2]) + 1 : SIZE;
    response.writeHead(range && !host.ignoreRanges ? 206 : 200, {
      'content-length': end - start,
      'accept-ranges': host.ignoreRanges ? 'none' : 'bytes',
      ...(range && !host.ignoreRanges
        ? { 'content-range': `bytes ${start}-${end - 1}/${SIZE}` }
        : {}),
    });
    active += 1;
    peak = Math.max(peak, active);
    let offset = start;
    const timer = setInterval(() => {
      if (offset >= end) {
        clearInterval(timer);
        response.end();
        return;
      }
      const next = Math.min(end, offset + 32 * 1024);
      response.write(content.subarray(offset, next));
      sent += next - offset;
      offset = next;
    }, 25);
    response.on('close', () => {
      clearInterval(timer);
      active -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/film.mkv`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-segments-'));
});

afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  // Connexions d'un transfert interrompu : fermées côté serveur avant le test suivant.
  for (let waited = 0; active > 0 && waited < 2000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  host = {};
  peak = 0;
  sent = 0;
  requested.length = 0;
});

function transfer(partPath: string, signal = new AbortController().signal) {
  return new SegmentedTransfer({
    partPath,
    expectedTotal: null,
    signal,
    logger: silent,
    tuning: FAST,
    open: (start, end, requestSignal) =>
      fetch(url, {
        headers: { range: `bytes=${start}-${end === null ? '' : end - 1}` },
        signal: requestSignal,
      }),
    remoteSize: () => Promise.resolve(SIZE),
    throttle: () => Promise.resolve(),
    onTotal: () => undefined,
    onProgress: () => undefined,
  });
}

describe('ByteRanges', () => {
  it('fusionne les plages et liste les trous', () => {
    const ranges = new ByteRanges([
      [10, 20],
      [0, 5],
    ]);
    ranges.add(20, 30);
    ranges.add(5, 8);
    expect(ranges.toJSON()).toEqual([
      [0, 8],
      [10, 30],
    ]);
    expect(ranges.size).toBe(28);
    expect(ranges.firstMissing()).toBe(8);
    expect(ranges.nextCovered(8)).toBe(10);
    expect(ranges.gaps(40)).toEqual([
      [8, 10],
      [30, 40],
    ]);
  });
});

describe('téléchargement en plusieurs morceaux', () => {
  it('ouvre plusieurs connexions quand chacune est bridée, sans abîmer le fichier', async () => {
    const partPath = path.join(dir, 'a.part');
    const started = Date.now();
    const result = await transfer(partPath).run();
    const elapsed = (Date.now() - started) / 1000;
    expect(result).toEqual({ total: SIZE, downloaded: SIZE });
    expect(checksum(fs.readFileSync(partPath))).toBe(checksum(content));
    expect(peak).toBeGreaterThanOrEqual(3);
    // D'un seul tenant : ~3,2 s à 1,3 Mo/s.
    expect(elapsed).toBeLessThan(2.6);
    // Morceaux partagés sans tout retélécharger.
    expect(sent).toBeLessThan(SIZE * 1.15);
    expect(fs.existsSync(progressFile(partPath))).toBe(false);
  });

  it('s’en tient au nombre de connexions que l’hôte accepte', async () => {
    host = { maxConnections: 2 };
    const partPath = path.join(dir, 'b.part');
    await transfer(partPath).run();
    expect(checksum(fs.readFileSync(partPath))).toBe(checksum(content));
    expect(peak).toBe(2);
  });

  it('reprend seulement ce qui manque après une interruption', async () => {
    const partPath = path.join(dir, 'c.part');
    const controller = new AbortController();
    const first = transfer(partPath, controller.signal).run();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await expect(first).rejects.toThrow();
    const saved = JSON.parse(fs.readFileSync(progressFile(partPath), 'utf8')) as {
      total: number;
      ranges: Array<[number, number]>;
    };
    const done = new ByteRanges(saved.ranges).size;
    expect(saved.total).toBe(SIZE);
    expect(done).toBeGreaterThan(SIZE * 0.2);
    expect(saved.ranges.length).toBeGreaterThan(1);

    sent = 0;
    await transfer(partPath).run();
    expect(checksum(fs.readFileSync(partPath))).toBe(checksum(content));
    expect(sent).toBeLessThan((SIZE - done) * 1.15);
  });

  it('télécharge d’un seul tenant quand l’hôte ignore les plages', async () => {
    host = { ignoreRanges: true };
    const partPath = path.join(dir, 'd.part');
    await transfer(partPath).run();
    expect(checksum(fs.readFileSync(partPath))).toBe(checksum(content));
    expect(peak).toBe(1);
  });

  it('reprend un `.part` d’un seul tenant (version précédente) à sa fin', async () => {
    const partPath = path.join(dir, 'e.part');
    fs.writeFileSync(partPath, content.subarray(0, 1_000_000));
    await transfer(partPath).run();
    expect(requested[0]).toBe('bytes=1000000-');
    expect(checksum(fs.readFileSync(partPath))).toBe(checksum(content));
  });
});
