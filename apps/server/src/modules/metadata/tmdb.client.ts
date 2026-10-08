import { ConcurrencyLimiter, sleep } from '../../core/async';
import { AppError, UpstreamError, errorMessage } from '../../core/errors';

export interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  vote_count?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbSearchResponse {
  results: TmdbSearchResult[];
  total_results: number;
}

/** Élément d'une liste TMDB (tendances, populaires…) ou d'un résultat de recherche. */
export interface TmdbListItem extends TmdbSearchResult {
  overview?: string | null;
  genre_ids?: number[];
  vote_average?: number | null;
  adult?: boolean;
}

export interface TmdbListResponse {
  page: number;
  results: TmdbListItem[];
  total_pages: number;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbMovie {
  id: number;
  title: string;
  original_title: string;
  overview: string | null;
  tagline: string | null;
  runtime: number | null;
  release_date: string | null;
  genres: TmdbGenre[];
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  vote_count: number | null;
  popularity?: number | null;
}

export interface TmdbSeasonSummary {
  season_number: number;
  episode_count: number;
  name: string;
  air_date: string | null;
  poster_path: string | null;
  overview?: string | null;
}

export interface TmdbTvShow {
  id: number;
  name: string;
  original_name: string;
  seasons?: TmdbSeasonSummary[];
  overview: string | null;
  tagline: string | null;
  episode_run_time: number[];
  first_air_date: string | null;
  genres: TmdbGenre[];
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  vote_count: number | null;
  popularity?: number | null;
}

export interface TmdbEpisode {
  episode_number: number;
  name: string;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
}

export interface TmdbSeason {
  season_number: number;
  name: string;
  overview: string | null;
  poster_path: string | null;
  episodes: TmdbEpisode[];
}

/** Erreur d'authentification TMDB (clé absente ou invalide). */
export class TmdbAuthError extends AppError {
  constructor(message = 'Clé TMDB absente ou invalide.') {
    super(401, 'TMDB_UNAUTHORIZED', message);
  }
}

/** Client minimal de l'API v3 de The Movie Database. */
export class TmdbClient {
  private readonly limiter = new ConcurrencyLimiter(6);

  constructor(
    private readonly getApiKey: () => string | null,
    private readonly baseUrl: string,
  ) {}

  searchMovie(query: string, year: number | null, language: string): Promise<TmdbSearchResponse> {
    return this.get('/search/movie', {
      query,
      year: year ?? undefined,
      language,
      include_adult: 'false',
    });
  }

  searchTv(query: string, year: number | null, language: string): Promise<TmdbSearchResponse> {
    return this.get('/search/tv', {
      query,
      first_air_date_year: year ?? undefined,
      language,
      include_adult: 'false',
    });
  }

  /**
   * Liste TMDB : `/trending/movie/week`, `/movie/popular`, `/tv/top_rated`…, ou
   * `/discover/movie` avec ses filtres (`sort_by`, `vote_count.gte`…).
   */
  list(
    path: string,
    language: string,
    page = 1,
    filters: Record<string, string | number> = {},
  ): Promise<TmdbListResponse> {
    return this.get(path, { ...filters, language, page });
  }

  genres(kind: 'movie' | 'tv', language: string): Promise<{ genres: TmdbGenre[] }> {
    return this.get(`/genre/${kind}/list`, { language });
  }

  movie(id: number, language: string): Promise<TmdbMovie> {
    return this.get(`/movie/${id}`, { language });
  }

  tv(id: number, language: string): Promise<TmdbTvShow> {
    return this.get(`/tv/${id}`, { language });
  }

  /** Identifiants externes (IMDb « tt… ») d'un film ou d'une série. */
  externalIds(kind: 'movie' | 'tv', id: number): Promise<{ imdb_id?: string | null }> {
    return this.get(`/${kind}/${id}/external_ids`, {});
  }

  season(tvId: number, seasonNumber: number, language: string): Promise<TmdbSeason> {
    return this.get(`/tv/${tvId}/season/${seasonNumber}`, { language });
  }

  /** Vérifie qu'une clé est valide (utilisé par l'écran des paramètres). */
  async validateKey(): Promise<boolean> {
    try {
      await this.get('/configuration', {});
      return true;
    } catch (error) {
      if (error instanceof TmdbAuthError) return false;
      throw error;
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const key = this.getApiKey();
    if (!key) throw new TmdbAuthError('Aucune clé TMDB configurée.');
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    // Jeton « lecture » v4 (JWT) ou clé API v3.
    if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);

    return this.limiter.run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        } catch (error) {
          if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw new UpstreamError(`TMDB injoignable : ${errorMessage(error)}`);
        }
        if (response.status === 401) throw new TmdbAuthError();
        if (response.status === 429 && attempt < 3) {
          const retryAfter = Number(response.headers.get('retry-after') ?? 1);
          await sleep(Math.min(10, Math.max(1, retryAfter)) * 1000);
          continue;
        }
        if (response.status === 404)
          throw new AppError(404, 'TMDB_NOT_FOUND', 'Introuvable sur TMDB.');
        if (!response.ok)
          throw new UpstreamError(`TMDB a répondu ${response.status}`, response.status);
        return (await response.json()) as T;
      }
    });
  }
}
