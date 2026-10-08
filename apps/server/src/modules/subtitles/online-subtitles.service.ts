import { createHash } from 'node:crypto';
import { TtlCache } from '../../core/async';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { stripExtension } from '../../domain/media-files';
import type { TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { TmdbClient } from '../metadata/tmdb.client';
import type { SettingsService } from '../settings/settings.service';
import { openSubtitlesHash } from './opensubtitles-hash';
import type { OpenSubtitlesClient } from './opensubtitles.client';
import type { SubtitleAddons } from './subtitle-addons';

/**
 * Sous-titres en ligne : OpenSubtitles.com (API officielle, clé requise) et extensions Stremio
 * de sous-titres, interrogés en parallèle. Les résultats faits pour le fichier exact
 * (empreinte identique) passent en tête, puis les plus téléchargés.
 */

/** Ce qu'il faut savoir du média lu pour chercher ses sous-titres. */
export interface OnlineSubtitleMedia {
  title: TitleRow | null;
  kind: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  fileName: string;
  size: number | null;
  /** Lecture d'une plage d'octets du fichier (calcul de l'empreinte). */
  read: ((start: number, length: number) => Promise<Buffer>) | null;
  /** Clé stable du fichier (empreinte gardée en mémoire). */
  cacheKey: string;
}

export type OnlineSubtitleRef =
  { provider: 'opensubtitles'; fileId: number } | { provider: 'addon'; url: string };

export interface OnlineSubtitleCandidate {
  /** Identifiant stable (cache disque des fichiers téléchargés). */
  key: string;
  provider: string;
  language: string | null;
  release: string | null;
  downloads: number | null;
  hashMatch: boolean;
  hearingImpaired: boolean;
  /** Ne traduit que les passages en langue étrangère. */
  forced: boolean;
  ref: OnlineSubtitleRef;
}

export interface OnlineSubtitlesSearch {
  candidates: OnlineSubtitleCandidate[];
  providers: string[];
  notices: string[];
}

const MAX_PER_LANGUAGE = 8;
const OPENSUBTITLES = 'OpenSubtitles';

function stableKey(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 20);
}

export class OnlineSubtitlesService {
  private readonly hashes = new TtlCache<string, string | null>(200, 24 * 3600_000);

  constructor(
    private readonly settings: SettingsService,
    private readonly titles: TitlesRepository,
    private readonly tmdb: TmdbClient,
    private readonly openSubtitles: OpenSubtitlesClient,
    private readonly addons: SubtitleAddons,
    private readonly logger: Logger,
  ) {}

  get available(): boolean {
    return this.openSubtitles.enabled || this.settings.get().subtitleAddonUrls.length > 0;
  }

  /** Langues cherchées, dans l'ordre de préférence : sous-titres, interface, anglais. */
  languages(): string[] {
    const { preferredSubtitleLanguage, metadataLanguage } = this.settings.get();
    return [
      ...new Set(
        [preferredSubtitleLanguage, metadataLanguage.slice(0, 2), 'en'].filter((code) =>
          /^[a-z]{2}$/.test(code),
        ),
      ),
    ];
  }

  async search(media: OnlineSubtitleMedia): Promise<OnlineSubtitlesSearch> {
    const languages = this.languages();
    const [imdbId, hash] = await Promise.all([this.imdbId(media.title), this.hash(media)]);
    const providers: string[] = [];
    const notices: string[] = [];
    const tasks: Array<Promise<OnlineSubtitleCandidate[]>> = [];
    const fail = (name: string) => (error: unknown) => {
      notices.push(`${name} : ${errorMessage(error)}`);
      return [] as OnlineSubtitleCandidate[];
    };

    if (this.openSubtitles.enabled) {
      providers.push(OPENSUBTITLES);
      tasks.push(
        this.openSubtitles
          .search({
            kind: media.kind,
            imdbId,
            tmdbId: media.title?.tmdb_id ?? null,
            season: media.season,
            episode: media.episode,
            languages,
            hash,
            query: stripExtension(media.fileName),
          })
          .then((hits) =>
            hits.map((hit) => ({
              key: stableKey('opensubtitles', String(hit.fileId)),
              provider: OPENSUBTITLES,
              language: hit.language,
              release: hit.release ?? hit.fileName,
              downloads: hit.downloads,
              hashMatch: hit.hashMatch,
              hearingImpaired: hit.hearingImpaired,
              forced: hit.foreignPartsOnly,
              ref: { provider: 'opensubtitles' as const, fileId: hit.fileId },
            })),
          )
          .catch(fail(OPENSUBTITLES)),
      );
    }

    // Les extensions Stremio désignent les titres par leur identifiant IMDb (et un épisode par
    // ses numéros).
    const numbered = media.kind === 'movie' || (media.season !== null && media.episode !== null);
    for (const manifestUrl of this.settings.get().subtitleAddonUrls) {
      if (!imdbId || !numbered) continue;
      const fallbackName = new URL(manifestUrl).host;
      tasks.push(
        this.addons
          .search(manifestUrl, {
            kind: media.kind,
            imdbId,
            season: media.season,
            episode: media.episode,
            hash,
            size: media.size,
            fileName: media.fileName,
          })
          .then((result) => {
            if (!result) return [];
            providers.push(result.name);
            return result.hits.map((hit) => ({
              key: stableKey('addon', hit.url),
              provider: result.name,
              language: hit.language,
              release: hit.label,
              downloads: null,
              hashMatch: false,
              hearingImpaired: false,
              forced: false,
              ref: { provider: 'addon' as const, url: hit.url },
            }));
          })
          .catch((error: unknown) => {
            providers.push(fallbackName);
            return fail(fallbackName)(error);
          }),
      );
    }

    const found = (await Promise.all(tasks)).flat();
    if (!imdbId && this.settings.get().subtitleAddonUrls.length > 0 && !this.openSubtitles.enabled)
      notices.push('Titre non identifié (identifiant IMDb inconnu) : extensions non interrogées.');
    return { candidates: rank(found, languages), providers, notices };
  }

  async download(ref: OnlineSubtitleRef): Promise<{ data: Buffer; fileName: string | null }> {
    if (ref.provider === 'opensubtitles') return this.openSubtitles.download(ref.fileId);
    return { data: await this.addons.download(ref.url), fileName: ref.url };
  }

  /** Identifiant IMDb du titre : connu, sinon demandé une fois à TMDB puis gardé. */
  private async imdbId(title: TitleRow | null): Promise<string | null> {
    if (!title) return null;
    if (title.imdb_id) return title.imdb_id;
    if (title.tmdb_id === null) return null;
    try {
      const ids = await this.tmdb.externalIds(
        title.kind === 'movie' ? 'movie' : 'tv',
        title.tmdb_id,
      );
      const imdb = ids.imdb_id?.trim() || null;
      if (imdb) this.titles.setImdbId(title.id, imdb);
      return imdb;
    } catch (error) {
      this.logger.debug({ err: errorMessage(error) }, 'Identifiant IMDb indisponible');
      return null;
    }
  }

  private async hash(media: OnlineSubtitleMedia): Promise<string | null> {
    if (!media.read || media.size === null) return null;
    const key = `${media.cacheKey}:${media.size}`;
    const cached = this.hashes.get(key);
    if (cached !== undefined) return cached;
    const hash = await openSubtitlesHash(media.size, media.read).catch((error: unknown) => {
      this.logger.debug({ err: errorMessage(error) }, 'Empreinte OpenSubtitles impossible');
      return null;
    });
    this.hashes.set(key, hash);
    return hash;
  }
}

/**
 * Ordre d'affichage : langues dans l'ordre de préférence ; dans chaque langue, d'abord les
 * sous-titres faits pour ce fichier, puis complets avant « forcés », puis les plus téléchargés.
 * Les doublons (même fichier proposé par deux services) sont retirés.
 */
export function rank(
  candidates: OnlineSubtitleCandidate[],
  languages: string[],
): OnlineSubtitleCandidate[] {
  const order = (language: string | null) => {
    const index = language ? languages.indexOf(language) : -1;
    return index >= 0 ? index : languages.length;
  };
  const seen = new Set<string>();
  const perLanguage = new Map<string, number>();
  return candidates
    .filter((candidate) => order(candidate.language) < languages.length)
    .sort(
      (a, b) =>
        order(a.language) - order(b.language) ||
        Number(b.hashMatch) - Number(a.hashMatch) ||
        Number(a.forced) - Number(b.forced) ||
        Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
        (b.downloads ?? -1) - (a.downloads ?? -1),
    )
    .filter((candidate) => {
      if (seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      const language = candidate.language ?? '';
      const count = perLanguage.get(language) ?? 0;
      if (count >= MAX_PER_LANGUAGE) return false;
      perLanguage.set(language, count + 1);
      return true;
    });
}
