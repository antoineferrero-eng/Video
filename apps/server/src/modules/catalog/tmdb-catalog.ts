import type { TitleKind } from '@lumiere/shared';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { folderCandidates } from '../../domain/folder-names';
import type { KeyValueCache } from '../../infra/database/database';
import type { TmdbClient, TmdbListItem } from '../metadata/tmdb.client';
import type { SettingsService } from '../settings/settings.service';
import type { TitlesRepository, TmdbTitleUpsert } from './titles.repository';

/**
 * Catalogue construit à partir de TMDB : titres populaires, tendances, à l'affiche, mieux
 * notés, et toute recherche. Les fichiers de chaque titre sont demandés aux extensions
 * Stremio (voir AddonCatalog).
 */

// « Populaires » en premier et sur 10 pages (200 titres) : c'est l'ordre du site de TMDB.
const LISTS: Record<TitleKind, Array<{ path: string; pages: number }>> = {
  movie: [
    { path: '/movie/popular', pages: 10 },
    { path: '/trending/movie/week', pages: 3 },
    { path: '/movie/now_playing', pages: 2 },
    { path: '/movie/top_rated', pages: 2 },
  ],
  series: [
    { path: '/tv/popular', pages: 10 },
    { path: '/trending/tv/week', pages: 3 },
    { path: '/tv/on_the_air', pages: 1 },
    { path: '/tv/top_rated', pages: 2 },
  ],
};

const GENRES_TTL_MS = 7 * 24 * 3600_000;
/**
 * Préfixe des chemins provisoires des titres (le chemin d'un titre est unique) : remplacé par
 * son dossier virtuel à la première demande aux extensions.
 */
const PLACEHOLDER_ROOT: Record<TitleKind, string> = { movie: '/movies/', series: '/tvs/' };
const SEARCH_TTL_MS = 3600_000;

function yearOf(date: string | null | undefined): number | null {
  const year = Number((date ?? '').slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : null;
}

export class TmdbCatalog {
  constructor(
    private readonly titles: TitlesRepository,
    private readonly tmdb: TmdbClient,
    private readonly settings: SettingsService,
    private readonly cache: KeyValueCache,
    private readonly logger: Logger,
  ) {}

  /** Importe les listes TMDB d'une section ; renvoie le nombre de titres vus. */
  async importLists(kind: TitleKind): Promise<number> {
    const language = this.settings.get().metadataLanguage;
    const genres = await this.genreNames(kind, language);
    const seen = new Set<number>();
    await this.eachListItem(kind, language, (item) => {
      if (seen.has(item.id)) return;
      if (this.importItem(kind, item, genres, language) !== null) seen.add(item.id);
    });
    return seen.size;
  }

  private async eachListItem(
    kind: TitleKind,
    language: string,
    visit: (item: TmdbListItem) => void,
  ): Promise<void> {
    for (const list of LISTS[kind]) {
      for (let page = 1; page <= list.pages; page += 1) {
        const response = await this.tmdb.list(list.path, language, page);
        for (const item of response.results) visit(item);
        if (page >= response.total_pages) break;
      }
    }
  }

  /**
   * Recherche TMDB (films et/ou séries) : les résultats rejoignent le catalogue pour être
   * trouvés par la recherche locale. Résultats mis en cache une heure par requête.
   */
  async search(query: string, kind?: TitleKind): Promise<void> {
    const language = this.settings.get().metadataLanguage;
    const kinds: TitleKind[] = kind ? [kind] : ['movie', 'series'];
    for (const current of kinds) {
      const key = `tmdb:search:${current}:${language}:${query.trim().toLowerCase()}`;
      if (this.cache.get<boolean>(key)) continue;
      const genres = await this.genreNames(current, language);
      const response =
        current === 'movie'
          ? await this.tmdb.searchMovie(query, null, language)
          : await this.tmdb.searchTv(query, null, language);
      for (const item of response.results.slice(0, 20) as TmdbListItem[])
        this.importItem(current, item, genres, language);
      this.cache.set(key, true, SEARCH_TTL_MS);
    }
  }

  private importItem(
    kind: TitleKind,
    item: TmdbListItem,
    genres: Map<number, string>,
    language: string,
  ): number | null {
    if (item.adult) return null;
    const title = (kind === 'movie' ? item.title : item.name)?.trim();
    if (!title) return null;
    const originalTitle = (kind === 'movie' ? item.original_title : item.original_name) ?? null;
    const releaseDate = (kind === 'movie' ? item.release_date : item.first_air_date) || null;
    const year = yearOf(releaseDate);
    const folderName =
      folderCandidates({
        kind,
        titles: [originalTitle ?? '', title],
        year,
        limit: 1,
      })[0] ?? title;
    const upsert: TmdbTitleUpsert = {
      kind,
      tmdbId: item.id,
      title,
      originalTitle,
      year,
      releaseDate,
      overview: item.overview?.trim() || null,
      posterPath: item.poster_path ?? null,
      backdropPath: item.backdrop_path ?? null,
      rating: item.vote_count ? (item.vote_average ?? null) : null,
      voteCount: item.vote_count ?? null,
      popularity: item.popularity ?? null,
      genres: (item.genre_ids ?? [])
        .map((id) => genres.get(id))
        .filter((name): name is string => !!name),
      language,
      remotePath: `${PLACEHOLDER_ROOT[kind]}${folderName}/`,
      folderName,
    };
    try {
      return this.titles.upsertTmdb(upsert);
    } catch (error) {
      this.logger.debug({ err: errorMessage(error), tmdbId: item.id }, 'Titre TMDB ignoré');
      return null;
    }
  }

  private async genreNames(kind: TitleKind, language: string): Promise<Map<number, string>> {
    const key = `tmdb:genres:${kind}:${language}`;
    let genres = this.cache.get<Array<{ id: number; name: string }>>(key);
    if (!genres) {
      genres = (await this.tmdb.genres(kind === 'movie' ? 'movie' : 'tv', language)).genres;
      this.cache.set(key, genres, GENRES_TTL_MS);
    }
    return new Map(genres.map((genre) => [genre.id, genre.name]));
  }
}
