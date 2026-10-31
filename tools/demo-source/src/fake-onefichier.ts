/**
 * Faux 1fichier et faux site de liens pour la démonstration hors ligne des sources
 * personnalisées : la fiche d'un titre propose « Voir sur … », le site affiche les liens
 * 1fichier de ses fichiers, et Lumière les télécharge par l'API (compte premium, clé « demo »).
 *
 *   GET  /site-demo/?q=<titre>                    page du site : liens 1fichier trouvés
 *   POST /1fichier/api/v1/user/info.cgi           compte premium
 *   POST /1fichier/api/v1/file/info.cgi           nom et taille d'un fichier
 *   POST /1fichier/api/v1/download/get_token.cgi  lien direct (valable 5 minutes)
 *   GET  /1fichier/dl/<jeton>/<fichier>           le fichier (Range)
 *
 * Les liens affichés ont la forme réelle (https://1fichier.com/?identifiant) ; leur
 * identifiant est tiré du chemin du fichier, et seule cette fausse API les connaît. Chaque
 * saison d'une série est aussi proposée complète, en archive zip (content/.archives) :
 * stockée sans compression pour « Les Explorateurs » (épisodes lisibles dans l'archive),
 * compressée pour « Orbite » (décompressée par Lumière une fois téléchargée).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DEMO_TITLES } from './fake-tmdb';
import { formatSize, walk } from './fake-stremio';
import { buildZip } from './zip-writer';

const API_KEY = 'demo';
const TOKEN_TTL_MS = 5 * 60_000;
const VIDEO = /\.(mkv|mp4|webm|avi|mov)$/i;

interface DemoFile {
  id: string;
  file: string;
  title: string;
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => {
      try {
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Une archive zip par saison (créée au premier lancement, à côté du contenu). */
function seasonArchives(
  root: string,
  title: string,
  videos: string[],
  compress: boolean,
): string[] {
  const seasons = new Map<number, string[]>();
  for (const video of videos) {
    const season = Number(/S(\d{1,2})E\d{1,3}/i.exec(path.basename(video))?.[1] ?? 0);
    seasons.set(season, [...(seasons.get(season) ?? []), video]);
  }
  const folder = path.join(root, '.archives');
  fs.mkdirSync(folder, { recursive: true });
  return [...seasons].map(([season, files]) => {
    const name = `${title.replace(/\s+/g, '.')}.S${String(season).padStart(2, '0')}.Saison.complete${compress ? '.compressee' : ''}.zip`;
    const target = path.join(folder, name);
    if (!fs.existsSync(target)) {
      const entries = files.map((file) => ({
        name: `${title} Saison ${season}/${path.basename(file)}`,
        data: fs.readFileSync(file),
      }));
      fs.writeFileSync(target, buildZip(entries, { compress }));
    }
    return target;
  });
}

export class FakeOneFichier {
  private readonly files: DemoFile[];
  private readonly tokens = new Map<string, { file: string; expiresAt: number }>();

  constructor(root: string) {
    const entry = (file: string, title: string): DemoFile => ({
      // Identifiant de 10 caractères, stable d'un lancement à l'autre.
      id: createHash('sha1').update(path.relative(root, file)).digest('hex').slice(0, 10),
      file,
      title,
    });
    this.files = DEMO_TITLES.flatMap((title) => {
      if (!title.folder) return [];
      const section = title.kind === 'movie' ? 'movies' : 'tvs';
      const videos = walk(path.join(root, section, title.folder)).filter((file) =>
        VIDEO.test(file),
      );
      const files = videos.map((file) => entry(file, title.title));
      if (title.kind !== 'movie') {
        const compress = title.title === 'Orbite';
        for (const archive of seasonArchives(root, title.title, videos, compress)) {
          files.push(entry(archive, title.title));
        }
      }
      return files;
    });
  }

  /**
   * true si la réponse est envoyée, le chemin d'un fichier à servir (lien direct valide), ou
   * false si la route n'est pas concernée.
   */
  handle(url: URL, request: http.IncomingMessage, response: http.ServerResponse): boolean | string {
    if (url.pathname === '/site-demo/' || url.pathname === '/site-demo') {
      this.sitePage(url.searchParams.get('q') ?? '', response);
      return true;
    }
    const download = /^\/1fichier\/dl\/([a-f0-9]+)\//.exec(url.pathname);
    if (download?.[1]) {
      const entry = this.tokens.get(download[1]);
      if (!entry || entry.expiresAt < Date.now()) {
        response.writeHead(403, { 'content-type': 'text/plain' }).end('Jeton expiré');
        return true;
      }
      return entry.file;
    }
    const api = /^\/1fichier\/api\/v1\/(.+)$/.exec(url.pathname);
    if (!api?.[1]) return false;
    void this.api(api[1], request, response);
    return true;
  }

  private async api(
    method: string,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await readJson(request);
    if (request.headers.authorization !== `Bearer ${API_KEY}`) {
      send(response, 401, { status: 'KO', message: 'Not authenticated #247' });
      return;
    }
    if (method === 'user/info.cgi') {
      send(response, 200, {
        status: 'OK',
        email: 'demo@lumiere.local',
        offer: 1,
        subscription_end: '2099-12-31 23:59:59',
      });
      return;
    }
    const id = /^https:\/\/1fichier\.com\/\?([a-z0-9]{5,20})$/.exec(String(body.url ?? ''))?.[1];
    const entry = this.files.find((item) => item.id === id);
    if (!entry) {
      send(response, 404, { status: 'KO', message: 'Resource not found #469' });
      return;
    }
    if (method === 'file/info.cgi') {
      send(response, 200, {
        url: body.url,
        filename: path.basename(entry.file),
        size: fs.statSync(entry.file).size,
        checksum: '',
        pass: 0,
      });
      return;
    }
    if (method === 'download/get_token.cgi') {
      const token = randomBytes(12).toString('hex');
      this.tokens.set(token, { file: entry.file, expiresAt: Date.now() + TOKEN_TTL_MS });
      const base = `http://${request.headers.host ?? '127.0.0.1'}/1fichier/dl`;
      send(response, 200, {
        status: 'OK',
        url: `${base}/${token}/${encodeURIComponent(path.basename(entry.file))}`,
      });
      return;
    }
    send(response, 404, { status: 'KO', message: 'Unknown method' });
  }

  /** Page du faux site : liens 1fichier des fichiers dont le titre correspond à la recherche. */
  private sitePage(query: string, response: http.ServerResponse): void {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    const found = this.files.filter((item) => {
      const title = normalize(item.title);
      return words.every((word) => title.includes(word));
    });
    const rows = found
      .map((item) => {
        const link = `https://1fichier.com/?${item.id}`;
        const name = path.basename(item.file);
        return `<li><strong>${escapeHtml(name)}</strong> <small>${formatSize(fs.statSync(item.file).size)}</small><br>
<code>${link}</code> <button data-link="${link}">Copier</button></li>`;
      })
      .join('\n');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Site de démonstration</title>
<style>body{font:15px system-ui;margin:2rem auto;max-width:46rem;padding:0 1rem;background:#111;color:#eee}
li{margin:1rem 0;list-style:none}code{color:#fbbf24}button{margin-left:.5rem}</style></head>
<body><h1>Site de démonstration</h1>
<form><input name="q" value="${escapeHtml(query)}" placeholder="Titre"> <button>Chercher</button></form>
<p>Comme sur un vrai site : copiez le lien 1fichier (bouton « Copier »), revenez sur Lumière et
faites Ctrl+V, ou cliquez sur le favori « Envoyer à Lumière ».</p>
<ul>${rows || '<li>Aucun fichier pour cette recherche.</li>'}</ul>
<script>document.addEventListener('click',(e)=>{const b=e.target.closest('button[data-link]');
if(!b)return;navigator.clipboard.writeText(b.dataset.link).then(()=>{b.textContent='Copié';});});</script>
</body></html>`);
  }
}
