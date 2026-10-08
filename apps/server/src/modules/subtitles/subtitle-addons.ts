import { UpstreamError, errorMessage } from '../../core/errors';
import { normalizeLanguageCode } from '../../domain/media-files';
import { addonBase, validateManifest, type AddonManifest } from '../source/stremio/stremio-addon';

/**
 * Extensions Stremio de sous-titres (ressource « subtitles » du protocole des extensions),
 * comme OpenSubtitles v3 (gratuite, sans clé) ou d'autres services compatibles :
 *
 *   GET <base>/manifest.json
 *   GET <base>/subtitles/movie/tt1677720/filename=…&videoHash=…&videoSize=….json
 *   GET <base>/subtitles/series/tt0903747:1:3.json
 *
 * Réponse : { subtitles: [{ id, url, lang (ISO 639-2), label? }] }.
 */

export interface SubtitleAddonQuery {
  kind: 'movie' | 'series';
  imdbId: string;
  season: number | null;
  episode: number | null;
  hash: string | null;
  size: number | null;
  fileName: string | null;
}

export interface SubtitleAddonHit {
  id: string;
  url: string;
  language: string | null;
  label: string | null;
}

interface RawSubtitle {
  id?: unknown;
  url?: unknown;
  lang?: unknown;
  label?: unknown;
}

const MANIFEST_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

/** L'extension fournit-elle des sous-titres pour ce type de contenu et cet identifiant ? */
export function providesSubtitles(manifest: AddonManifest, kind: 'movie' | 'series', id: string) {
  const resource = manifest.resources.find(
    (item) => (typeof item === 'string' ? item : item.name) === 'subtitles',
  );
  if (!resource) return false;
  const types = (typeof resource === 'object' ? resource.types : undefined) ?? manifest.types;
  const prefixes =
    (typeof resource === 'object' ? resource.idPrefixes : undefined) ?? manifest.idPrefixes ?? [];
  return (
    types.includes(kind) &&
    (prefixes.length === 0 || prefixes.some((prefix) => id.startsWith(prefix)))
  );
}

/** Adresse de la recherche, avec l'empreinte et le nom du fichier en arguments supplémentaires. */
export function subtitlesUrl(manifestUrl: string, query: SubtitleAddonQuery): string {
  const id =
    query.kind === 'series' && query.season !== null && query.episode !== null
      ? `${query.imdbId}:${query.season}:${query.episode}`
      : query.imdbId;
  const extra = new URLSearchParams();
  if (query.fileName) extra.set('filename', query.fileName);
  if (query.hash) extra.set('videoHash', query.hash);
  if (query.size !== null) extra.set('videoSize', String(query.size));
  const suffix = extra.size > 0 ? `/${extra.toString()}` : '';
  return `${addonBase(manifestUrl)}subtitles/${query.kind}/${encodeURIComponent(id)}${suffix}.json`;
}

export class SubtitleAddons {
  private readonly manifests = new Map<string, { at: number; manifest: AddonManifest }>();

  async manifest(manifestUrl: string): Promise<AddonManifest> {
    const cached = this.manifests.get(manifestUrl);
    if (cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.manifest;
    const manifest = validateManifest(await this.getJson(manifestUrl));
    this.manifests.set(manifestUrl, { at: Date.now(), manifest });
    return manifest;
  }

  /** Sous-titres proposés par une extension ; null si elle ne gère pas ce contenu. */
  async search(
    manifestUrl: string,
    query: SubtitleAddonQuery,
  ): Promise<{ name: string; hits: SubtitleAddonHit[] } | null> {
    const manifest = await this.manifest(manifestUrl);
    if (!providesSubtitles(manifest, query.kind, query.imdbId)) return null;
    const data = (await this.getJson(subtitlesUrl(manifestUrl, query))) as {
      subtitles?: RawSubtitle[];
    } | null;
    const hits: SubtitleAddonHit[] = [];
    for (const entry of Array.isArray(data?.subtitles) ? data.subtitles : []) {
      if (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) continue;
      const lang = typeof entry.lang === 'string' ? entry.lang : null;
      hits.push({
        id:
          typeof entry.id === 'string' || typeof entry.id === 'number'
            ? String(entry.id)
            : entry.url,
        url: entry.url,
        language: normalizeLanguageCode(lang),
        label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null,
      });
    }
    return { name: manifest.name, hits };
  }

  async download(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new UpstreamError(`Sous-titres injoignables : ${errorMessage(error)}`);
    }
    if (!response.ok) throw new UpstreamError(`Sous-titres refusés (${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_SUBTITLE_BYTES)
      throw new UpstreamError('Fichier de sous-titres trop volumineux.');
    return data;
  }

  private async getJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`Extension de sous-titres injoignable : ${errorMessage(error)}`);
    }
    if (!response.ok)
      throw new UpstreamError(`L’extension de sous-titres a répondu ${response.status}.`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new UpstreamError('L’extension de sous-titres n’a pas renvoyé de données.');
    }
  }
}
