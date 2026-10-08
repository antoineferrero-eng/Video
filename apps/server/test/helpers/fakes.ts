import type http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Faux services pour les tests d'intégration : listes TMDB minimales et extension Stremio
 * qui sert ses propres fichiers (plages d'octets comprises).
 */

export function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

export function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export interface FakeTitle {
  id: number;
  kind: 'movie' | 'tv';
  name: string;
  date: string;
  imdb: string | null;
}

/** Entrée de liste TMDB (films : `title`, séries : `name`). */
export function tmdbItem(title: FakeTitle): Record<string, unknown> {
  return title.kind === 'movie'
    ? { id: title.id, title: title.name, original_title: title.name, release_date: title.date }
    : { id: title.id, name: title.name, original_name: title.name, first_air_date: title.date };
}

/**
 * Routes « catalogue » de TMDB : listes (populaires, tendances…), genres et identifiants
 * externes. Renvoie false si la route n'en fait pas partie.
 */
export function tmdbCatalogRoute(
  titles: FakeTitle[],
  route: string,
  response: http.ServerResponse,
): boolean {
  const list =
    /^\/(?:trending\/(movie|tv)\/week|(movie|tv)\/(?:popular|now_playing|top_rated|on_the_air))$/.exec(
      route,
    );
  if (list) {
    const kind = list[1] ?? list[2];
    const results = titles.filter((title) => title.kind === kind).map(tmdbItem);
    json(response, 200, { page: 1, total_pages: 1, results });
    return true;
  }
  if (/^\/genre\/(movie|tv)\/list$/.test(route)) {
    json(response, 200, { genres: [] });
    return true;
  }
  const external = /^\/(movie|tv)\/(\d+)\/external_ids$/.exec(route);
  if (external) {
    const title = titles.find((entry) => entry.id === Number(external[2]));
    json(response, 200, { id: Number(external[2]), imdb_id: title?.imdb ?? null });
    return true;
  }
  return false;
}

/** Envoie un contenu en mémoire, plage d'octets comprise. */
export function sendBytes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  bytes: Buffer,
  contentType = 'video/x-matroska',
): void {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  if (range && start >= bytes.length) {
    response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    'content-type': contentType,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
  });
  response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

export interface FakeStreamFile {
  fileName: string;
  bytes: Buffer;
  /** Description affichée par l'extension (nom du serveur, qualité…). */
  name?: string;
}

/**
 * Extension Stremio servie sous `prefix` : manifeste, liens (`/stream/…`) d'après `streams`
 * (identifiant « tt… » ou « tt…:saison:épisode » → fichiers), et fichiers eux-mêmes
 * (`/files/…`). Renvoie false si la requête ne la concerne pas.
 */
export function addonRoute(options: {
  prefix: string;
  base: () => string;
  name?: string;
  streams: Record<string, FakeStreamFile[]>;
  onStreamRequest?: (id: string) => void;
  /** Envoi d'un fichier (par défaut : d'un bloc, plage d'octets comprise). */
  serve?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    file: FakeStreamFile,
  ) => void;
}): (request: http.IncomingMessage, response: http.ServerResponse) => boolean {
  return (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    if (!pathname.startsWith(`${options.prefix}/`)) return false;
    const route = pathname.slice(options.prefix.length);
    if (route === '/manifest.json') {
      json(response, 200, {
        id: `test.${options.prefix.slice(1) || 'addon'}`,
        name: options.name ?? 'Extension de test',
        version: '1.0.0',
        types: ['movie', 'series'],
        resources: ['stream'],
        idPrefixes: ['tt'],
      });
      return true;
    }
    const stream = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(route);
    if (stream?.[2]) {
      options.onStreamRequest?.(stream[2]);
      const files = options.streams[stream[2]] ?? [];
      json(response, 200, {
        streams: files.map((file) => ({
          name: file.name ?? 'Test\n1080p',
          title: file.fileName,
          url: `${options.base()}${options.prefix}/files/${encodeURIComponent(file.fileName)}`,
          behaviorHints: { filename: file.fileName, videoSize: file.bytes.length },
        })),
      });
      return true;
    }
    const served = /^\/files\/(.+)$/.exec(route);
    const file = served?.[1]
      ? Object.values(options.streams)
          .flat()
          .find((entry) => entry.fileName === served[1])
      : undefined;
    if (!file) {
      response.writeHead(404).end();
      return true;
    }
    (options.serve ?? ((req, res, entry) => sendBytes(req, res, entry.bytes)))(
      request,
      response,
      file,
    );
    return true;
  };
}
