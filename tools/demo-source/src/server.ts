/**
 * Serveur de démonstration hors ligne : faux TMDB (/tmdb/3, catalogue), deux fausses
 * extensions Stremio (/stremio/manifest.json et /stremio-miroir/manifest.json, fichiers) et
 * faux services de sous-titres en ligne (/opensubtitles/api/v1,
 * /subtitles-addon/manifest.json), ainsi qu'un faux 1fichier et un faux site de liens pour les
 * sources personnalisées (/site-demo/, /1fichier/api/v1, voir fake-onefichier.ts). Les vidéos d'exemple ne sont servies que par les liens des
 * extensions, avec prise en charge des requêtes Range. Le débit peut être bridé pour observer
 * la progression des téléchargements (DEMO_THROTTLE_KBPS, 0 = illimité) et le nombre de
 * connexions simultanées à un même fichier limité, comme chez certains hébergeurs
 * (DEMO_MAX_CONNECTIONS, 0 = sans limite ; au-delà, réponse 503).
 *
 *   npm run serve -w @lumiere/demo-source
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { FakeOneFichier } from './fake-onefichier';
import { FakeStremio, fakeStremioOptions } from './fake-stremio';
import { FakeSubtitles } from './fake-subtitles';
import { handleFakeTmdb } from './fake-tmdb';

export interface DemoServerOptions {
  root: string;
  port: number;
  host: string;
  throttleKbps: number;
  /** Connexions simultanées acceptées par fichier (0 ou absent : sans limite). */
  maxConnections?: number;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.txt': 'text/plain; charset=utf-8',
};

function throttle(kbps: number): Transform {
  const bytesPerSecond = kbps * 1024;
  let sent = 0;
  const started = Date.now();
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.length;
      const expected = (sent / bytesPerSecond) * 1000;
      const wait = Math.max(0, expected - (Date.now() - started));
      setTimeout(() => callback(null, chunk), wait);
    },
  });
}

export function createDemoServer(options: DemoServerOptions): http.Server {
  const root = path.resolve(options.root);
  const addons = fakeStremioOptions(root).map((addon) => new FakeStremio(addon));
  const subtitles = new FakeSubtitles();
  const oneFichier = new FakeOneFichier(root);
  /** Connexions en cours par fichier servi. */
  const active = new Map<string, number>();
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (handleFakeTmdb(url, request.headers, response, path.join(root, '.tmdb'))) return;
      if (subtitles.handle(url, request, response)) return;
      // Lien d'une extension : chemin du fichier à servir (aucune autre façon d'y accéder).
      let target: string | null = null;
      const direct = oneFichier.handle(url, request, response);
      if (direct === true) return;
      if (typeof direct === 'string') target = direct;
      for (const addon of target ? [] : addons) {
        const handled = addon.handle(url, request, response);
        if (handled === true) return;
        if (typeof handled === 'string') {
          target = handled;
          break;
        }
      }
      if (!target || !target.startsWith(root + path.sep)) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
        return;
      }
      const stats = fs.existsSync(target) ? fs.statSync(target) : null;
      if (!stats?.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
        return;
      }

      const maxConnections = options.maxConnections ?? 0;
      const connections = active.get(target) ?? 0;
      if (maxConnections > 0 && connections >= maxConnections) {
        response.writeHead(503, { 'retry-after': '1' }).end('Trop de connexions simultanées');
        return;
      }
      active.set(target, connections + 1);
      response.on('close', () => {
        const remaining = (active.get(target) ?? 1) - 1;
        if (remaining > 0) active.set(target, remaining);
        else active.delete(target);
      });

      const size = stats.size;
      const headers: Record<string, string | number> = {
        'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'last-modified': stats.mtime.toUTCString(),
      };
      let start = 0;
      let end = size - 1;
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
      if (range) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          return;
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['content-length'] = end - start + 1;
      response.writeHead(status, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(target, { start, end });
      try {
        if (options.throttleKbps > 0)
          await pipeline(stream, throttle(options.throttleKbps), response);
        else await pipeline(stream, response);
      } catch {
        // Client parti (lecteur qui se repositionne, téléchargement en pause…).
      }
    })();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options: DemoServerOptions = {
    root: process.env.DEMO_ROOT ?? fileURLToPath(new URL('../content', import.meta.url)),
    port: Number(process.env.DEMO_PORT ?? 8585),
    host: process.env.DEMO_HOST ?? '127.0.0.1',
    throttleKbps: Number(process.env.DEMO_THROTTLE_KBPS ?? 4096),
    maxConnections: Number(process.env.DEMO_MAX_CONNECTIONS ?? 0),
  };
  if (!fs.existsSync(options.root)) {
    console.error(
      `Contenu de démonstration absent (${options.root}) : lancez d'abord « npm run demo:media ».`,
    );
    process.exit(1);
  }
  createDemoServer(options).listen(options.port, options.host, () => {
    console.log(
      `Services de démonstration : http://${options.host}:${options.port}/ (débit ${options.throttleKbps || '∞'} Kio/s)`,
    );
  });
}
