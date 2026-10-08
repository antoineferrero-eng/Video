/**
 * Faux services de sous-titres en ligne pour la démonstration hors ligne :
 *
 *  - API OpenSubtitles.com (/opensubtitles/api/v1) : clé « demo », compte demo / demo ;
 *    recherche par identifiant IMDb (film, ou série + saison + épisode), téléchargement
 *    par lien temporaire ;
 *  - extension Stremio de sous-titres (/subtitles-addon/manifest.json).
 *
 * Chaque réplique indique son propre horodatage : on vérifie d'un coup d'œil qu'elle
 * s'affiche au bon moment.
 */
import { createHash, randomBytes } from 'node:crypto';
import type http from 'node:http';
import { DEMO_TITLES } from './fake-tmdb';

const API_KEY = 'demo';
const LANGUAGES: Record<string, { iso2: string; label: string; line: string }> = {
  fr: { iso2: 'fr', label: 'Français', line: 'Réplique' },
  en: { iso2: 'en', label: 'English', line: 'Line' },
};
const ISO3: Record<string, string> = { fr: 'fre', en: 'eng' };

const ADDON_MANIFEST = {
  id: 'org.lumiere.demo-subtitles',
  name: 'Sous-titres démo',
  version: '1.0.0',
  description: 'Extension Stremio de sous-titres de démonstration.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function clock(seconds: number, separator: ',' | '.'): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const ms = Math.round((seconds % 1) * 1000);
  const whole = Math.floor(seconds);
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}${separator}${pad(ms, 3)}`;
}

/** Sous-titres SubRip : une réplique toutes les 4 s pendant 3 minutes. */
function srt(source: string, language: string): string {
  const info = LANGUAGES[language] ?? LANGUAGES.en!;
  const cues: string[] = [];
  for (let index = 0, start = 1; start < 180; index += 1, start += 4) {
    cues.push(
      `${index + 1}\n${clock(start, ',')} --> ${clock(start + 3, ',')}\n${info.line} ${index + 1} · ${source} (${info.label})\nà ${clock(start, '.').slice(3, 8)}\n`,
    );
  }
  return cues.join('\n');
}

function numericImdb(value: string | null): string | null {
  return value ? value.replace(/^tt0*/i, '') : null;
}

function findTitle(imdb: string | null) {
  return DEMO_TITLES.find((title) => numericImdb(title.imdb) === imdb);
}

function fileId(...parts: Array<string | number | null>): number {
  return Number.parseInt(createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 8), 16);
}

export class FakeSubtitles {
  private readonly files = new Map<number, { language: string; source: string }>();
  private readonly tokens = new Set<string>();

  /** Traite une requête de sous-titres ; false si la route n'est pas concernée. */
  handle(url: URL, request: http.IncomingMessage, response: http.ServerResponse): boolean {
    if (url.pathname.startsWith('/opensubtitles/')) {
      void this.openSubtitles(url, request, response);
      return true;
    }
    if (url.pathname.startsWith('/subtitles-addon/')) {
      this.addon(url, request, response);
      return true;
    }
    return false;
  }

  private async openSubtitles(
    url: URL,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const file = /^\/opensubtitles\/files\/(\d+)\.srt$/.exec(url.pathname);
    if (file?.[1]) {
      const entry = this.files.get(Number(file[1]));
      if (!entry) return json(response, 404, { message: 'Lien expiré' });
      response.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' });
      response.end(srt(entry.source, entry.language));
      return;
    }
    const route = url.pathname.replace(/^\/opensubtitles\/api\/v1/, '');
    if (request.headers['api-key'] !== API_KEY)
      return json(response, 403, { message: 'You cannot consume this service' });
    const body = request.method === 'POST' ? await readJson(request) : {};

    if (route === '/login' && request.method === 'POST') {
      if (body.username !== 'demo' || body.password !== 'demo')
        return json(response, 401, { message: 'Invalid username/password' });
      const token = randomBytes(12).toString('hex');
      this.tokens.add(token);
      return json(response, 200, {
        token,
        user: { allowed_downloads: 100, remaining_downloads: 100, level: 'Sub leecher' },
      });
    }

    if (route === '/subtitles' && request.method === 'GET') {
      const params = url.searchParams;
      const isEpisode = params.has('parent_imdb_id');
      const title = findTitle(params.get(isEpisode ? 'parent_imdb_id' : 'imdb_id'));
      const season = params.get('season_number');
      const episode = params.get('episode_number');
      const hash = params.get('moviehash');
      const data: unknown[] = [];
      for (const language of (params.get('languages') ?? '').split(',')) {
        if (!title || !LANGUAGES[language]) continue;
        for (const index of [0, 1]) {
          const id = fileId(title.imdb, season, episode, language, index);
          this.files.set(id, { language, source: 'OpenSubtitles démo' });
          const release = `${title.folder ?? title.imdb}${season ? `.S${season}E${episode}` : ''}.${index === 0 ? '1080p.WEB-DL' : '720p.HDTV'}`;
          data.push({
            id: String(id),
            type: 'subtitle',
            attributes: {
              language,
              release,
              download_count: index === 0 ? 4821 : 932,
              hearing_impaired: index === 1,
              foreign_parts_only: false,
              machine_translated: false,
              moviehash_match: Boolean(hash) && index === 0,
              files: [{ file_id: id, file_name: `${release}.srt` }],
            },
          });
        }
      }
      return json(response, 200, { total_count: data.length, page: 1, total_pages: 1, data });
    }

    if (route === '/download' && request.method === 'POST') {
      const id = Number(body.file_id);
      if (!this.files.has(id)) return json(response, 404, { message: 'Invalid file_id' });
      const token = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1];
      const host = request.headers.host ?? '127.0.0.1';
      return json(response, 200, {
        link: `http://${host}/opensubtitles/files/${id}.srt`,
        file_name: `${id}.srt`,
        requests: 1,
        remaining: token && this.tokens.has(token) ? 99 : 4,
      });
    }
    json(response, 404, { message: 'Not found' });
  }

  private addon(url: URL, request: http.IncomingMessage, response: http.ServerResponse): void {
    const route = url.pathname.slice('/subtitles-addon'.length);
    if (route === '/manifest.json') return json(response, 200, ADDON_MANIFEST);
    const file = /^\/files\/([a-z]{2})-(\w+)\.srt$/.exec(route);
    if (file?.[1]) {
      response.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' });
      response.end(srt('Extension démo', file[1]));
      return;
    }
    const match = /^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]*)?\.json$/.exec(route);
    if (!match?.[2]) return json(response, 404, { error: 'not found' });
    const [imdb = ''] = decodeURIComponent(match[2]).split(':');
    if (!DEMO_TITLES.some((title) => title.imdb === imdb))
      return json(response, 200, { subtitles: [] });
    const host = request.headers.host ?? '127.0.0.1';
    const key = createHash('sha1').update(match[2]).digest('hex').slice(0, 10);
    json(response, 200, {
      subtitles: Object.keys(LANGUAGES).map((language) => ({
        id: `${language}-${key}`,
        url: `http://${host}/subtitles-addon/files/${language}-${key}.srt`,
        lang: ISO3[language],
      })),
    });
  }
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
