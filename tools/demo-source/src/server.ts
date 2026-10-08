/**
 * Serveur d'index HTTP de démonstration : reproduit un « autoindex » nginx
 * (listing <pre> avec dates et tailles) et sert les fichiers avec prise en charge
 * des requêtes Range. Le débit peut être bridé pour observer la progression des
 * téléchargements (DEMO_THROTTLE_KBPS, 0 = illimité) et le nombre de connexions
 * simultanées à un même fichier limité, comme chez certains hébergeurs (DEMO_MAX_CONNECTIONS,
 * 0 = sans limite ; au-delà, réponse 503). Il héberge aussi un faux TMDB (/tmdb/3) et une
 * fausse extension Stremio (/stremio/manifest.json).
 *
 *   npm run serve -w @lumiere/demo-source
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { FakeStremio, fakeStremioOptions } from './fake-stremio';
import { handleFakeTmdb } from './fake-tmdb';

export interface DemoServerOptions {
  root: string;
  port: number;
  host: string;
  throttleKbps: number;
  /** Connexions simultanées acceptées par fichier (0 ou absent : sans limite). */
  maxConnections?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function nginxDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIndex(urlPath: string, dir: string): string {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !entry.name.includes('.tmp'))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
  const lines = entries.map((entry) => {
    const stats = fs.statSync(path.join(dir, entry.name));
    const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
    const display = name.length > 50 ? `${name.slice(0, 47)}..&gt;` : escapeHtml(name);
    const padding = ' '.repeat(Math.max(1, 51 - Math.min(name.length, 50)));
    const size = entry.isDirectory() ? '-' : String(stats.size);
    return `<a href="${encodeURIComponent(entry.name)}${entry.isDirectory() ? '/' : ''}">${display}</a>${padding}${nginxDate(stats.mtime)} ${size.padStart(19)}`;
  });
  const title = `Index of ${escapeHtml(urlPath)}`;
  return `<html>\r\n<head><title>${title}</title></head>\r\n<body>\r\n<h1>${title}</h1><hr><pre><a href="../">../</a>\r\n${lines.join('\r\n')}\r\n</pre><hr></body>\r\n</html>\r\n`;
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
  const addon = new FakeStremio(fakeStremioOptions(root));
  /** Connexions en cours par fichier servi. */
  const active = new Map<string, number>();
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (handleFakeTmdb(url, request.headers, response, path.join(root, '.tmdb'))) return;
      // Lien de l'extension : chemin du fichier à servir.
      const addonFile = addon.handle(url, request, response);
      if (addonFile === true) return;
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400).end('Bad Request');
        return;
      }
      const target = typeof addonFile === 'string' ? addonFile : path.resolve(root, `.${urlPath}`);
      if (target !== root && !target.startsWith(root + path.sep)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const stats = fs.existsSync(target) ? fs.statSync(target) : null;
      if (!stats) {
        response
          .writeHead(404, { 'content-type': 'text/html' })
          .end('<html><body><h1>404 Not Found</h1></body></html>');
        return;
      }
      if (stats.isDirectory()) {
        if (!urlPath.endsWith('/')) {
          response.writeHead(301, { location: `${url.pathname}/` }).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' }).end(renderIndex(urlPath, target));
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
      `Source de démonstration : http://${options.host}:${options.port}/ (débit ${options.throttleKbps || '∞'} Kio/s)`,
    );
  });
}
