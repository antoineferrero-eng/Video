/**
 * Fausses extensions Stremio pour la démonstration hors ligne : même protocole que les
 * extensions réelles (manifest.json, /stream/<type>/<id>.json), avec ce qui compte pour
 * Lumière chez 111477 : des liens qui expirent, une réserve de liens qui se vide (un jeton
 * par lien) et se remplit lentement, et une limite de requêtes en rafale.
 *
 *   GET /stremio/manifest.json
 *   GET /stremio/stream/movie/tt9100101.json
 *   GET /stremio/stream/series/tt9100201%3A1%3A2.json
 *   GET /stremio/link/<jeton>/<fichier>            (lien de lecture, avec Range)
 *
 * Deux extensions sont servies, pour montrer plusieurs sources à la fois : « Lumière démo »
 * (/stremio/, films et séries) et « Miroir démo » (/stremio-miroir/, films seulement). Une
 * partie de leurs fichiers est commune (l'une prend le relais si le lien de l'autre est
 * refusé), le reste n'est proposé que par l'une ou l'autre.
 *
 * Réglages (première extension) : DEMO_ADDON_TOKENS (réserve, 0 = illimitée),
 * DEMO_ADDON_REFILL_S (un jeton regagné toutes les N secondes), DEMO_ADDON_LINK_TTL_S (durée
 * de vie d'un lien), DEMO_ADDON_BURST (requêtes par 10 s, 0 = sans limite).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DEMO_TITLES, type DemoTitle } from './fake-tmdb';

export interface FakeStremioOptions {
  root: string;
  /** Préfixe des routes de l'extension (« /stremio »). */
  prefix: string;
  id: string;
  name: string;
  types: Array<'movie' | 'series'>;
  /** Fichiers proposés par cette extension (d'après leur nom). */
  accepts: (fileName: string) => boolean;
  tokens: number;
  refillSeconds: number;
  linkTtlSeconds: number;
  burst: number;
}

/** Les deux extensions de la démonstration. */
export function fakeStremioOptions(root: string): FakeStremioOptions[] {
  return [
    {
      root,
      prefix: '/stremio',
      id: 'org.lumiere.demo-addon',
      name: 'Lumière démo',
      types: ['movie', 'series'],
      // Les versions sous-titrées ne sont proposées que par le miroir.
      accepts: (name) => !/VOSTFR/i.test(name),
      tokens: Number(process.env.DEMO_ADDON_TOKENS ?? 0),
      refillSeconds: Number(process.env.DEMO_ADDON_REFILL_S ?? 300),
      linkTtlSeconds: Number(process.env.DEMO_ADDON_LINK_TTL_S ?? 3600),
      burst: Number(process.env.DEMO_ADDON_BURST ?? 10),
    },
    {
      root,
      prefix: '/stremio-miroir',
      id: 'org.lumiere.demo-mirror',
      name: 'Miroir démo',
      types: ['movie'],
      // Pas de 4K sur le miroir.
      accepts: (name) => !/2160p/i.test(name),
      tokens: 0,
      refillSeconds: 300,
      linkTtlSeconds: 3600,
      burst: 0,
    },
  ];
}

const VIDEO = /\.(mkv|mp4|webm|avi|mov)$/i;
const LIMIT_TITLE = '⚠️ Slow down — rate limit reached';

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function resolution(name: string): string {
  return /2160p/i.test(name) ? '4K' : (/(1080p|720p|480p)/i.exec(name)?.[1] ?? 'SD');
}

/** Fichiers d'un film, ou d'un épisode (SxxEyy dans le nom). */
function filesFor(root: string, title: DemoTitle, season?: number, episode?: number): string[] {
  if (!title.folder) return [];
  const section = title.kind === 'movie' ? 'movies' : 'tvs';
  const files = walk(path.join(root, section, title.folder)).filter((file) => VIDEO.test(file));
  if (title.kind === 'movie') return files;
  return files.filter((file) => {
    const match = /S(\d{1,2})E(\d{1,3})/i.exec(path.basename(file));
    return match && Number(match[1]) === season && Number(match[2]) === episode;
  });
}

export class FakeStremio {
  private available: number;
  private lastRefill = Date.now();
  private readonly links = new Map<string, { file: string; expiresAt: number }>();
  private readonly recent: number[] = [];

  constructor(private readonly options: FakeStremioOptions) {
    this.available = options.tokens;
  }

  private refill(): void {
    if (this.options.tokens <= 0) return;
    const gained = Math.floor((Date.now() - this.lastRefill) / (this.options.refillSeconds * 1000));
    if (gained > 0) {
      this.available = Math.min(this.options.tokens, this.available + gained);
      this.lastRefill += gained * this.options.refillSeconds * 1000;
    }
  }

  /** Un jeton par lien ; réserve illimitée si DEMO_ADDON_TOKENS vaut 0. */
  private take(): boolean {
    if (this.options.tokens <= 0) return true;
    this.refill();
    if (this.available <= 0) return false;
    this.available -= 1;
    return true;
  }

  private burstExceeded(): boolean {
    if (this.options.burst <= 0) return false;
    const now = Date.now();
    while (this.recent.length > 0 && (this.recent[0] ?? 0) < now - 10_000) this.recent.shift();
    this.recent.push(now);
    return this.recent.length > this.options.burst;
  }

  /**
   * Traite une requête de l'extension (sous son préfixe) : true si la réponse est envoyée, le
   * chemin d'un fichier à servir (lien de lecture valide), ou false si la route n'est pas
   * concernée.
   */
  handle(url: URL, request: http.IncomingMessage, response: http.ServerResponse): boolean | string {
    const { prefix } = this.options;
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    const route = url.pathname.slice(prefix.length);
    if (route === '/manifest.json') {
      send(response, 200, {
        id: this.options.id,
        name: this.options.name,
        version: '1.0.0',
        description: 'Extension Stremio de démonstration (vidéos d’exemple générées localement).',
        resources: ['stream'],
        types: this.options.types,
        idPrefixes: ['tt'],
        catalogs: [],
        behaviorHints: { configurable: false },
      });
      return true;
    }
    const link = /^\/link\/([a-f0-9]+)\//.exec(route);
    if (link?.[1]) {
      const entry = this.links.get(link[1]);
      if (!entry || entry.expiresAt < Date.now()) {
        response.writeHead(410, { 'content-type': 'text/plain' }).end('Lien expiré');
        return true;
      }
      return entry.file;
    }
    const stream = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(route);
    if (!stream?.[1] || !stream[2]) {
      send(response, 404, { error: 'not found' });
      return true;
    }
    if (this.burstExceeded()) {
      send(response, 429, { error: 'Too many requests' });
      return true;
    }
    const [imdb = '', season, episode] = decodeURIComponent(stream[2]).split(':');
    const title = DEMO_TITLES.find(
      (item) => item.imdb === imdb && (item.kind === 'movie') === (stream[1] === 'movie'),
    );
    const kind = stream[1] === 'movie' ? 'movie' : 'series';
    const files =
      title && this.options.types.includes(kind)
        ? filesFor(this.options.root, title, Number(season), Number(episode)).filter((file) =>
            this.options.accepts(path.basename(file)),
          )
        : [];
    const base = `http://${request.headers.host ?? '127.0.0.1'}${prefix}/link`;
    const streams: unknown[] = [];
    let limited = false;
    for (const file of files) {
      if (!this.take()) {
        limited = true;
        break;
      }
      const token = randomBytes(12).toString('hex');
      this.links.set(token, {
        file,
        expiresAt: Date.now() + this.options.linkTtlSeconds * 1000,
      });
      const name = path.basename(file);
      const size = fs.statSync(file).size;
      streams.push({
        name: `${this.options.name}\n${resolution(name)}`,
        title: `${name}\n💾 ${formatSize(size)}`,
        url: `${base}/${token}/${encodeURIComponent(name)}`,
        behaviorHints: { filename: name, videoSize: size, bingeGroup: 'lumiere-demo' },
      });
    }
    if (limited) streams.push({ name: this.options.name, title: LIMIT_TITLE });
    send(response, 200, { streams });
    return true;
  }
}
