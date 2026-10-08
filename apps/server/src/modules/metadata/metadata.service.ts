import type { TitleKind } from '@lumiere/shared';
import { InFlight, sleep } from '../../core/async';
import { errorMessage } from '../../core/errors';
import type { EventBus } from '../../core/event-bus';
import type { Logger } from '../../core/logger';
import { normalizeText, stripBracketedTags } from '../../core/text';
import type { KeyValueCache } from '../../infra/database/database';
import type { TitleMetadata, TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { SettingsService } from '../settings/settings.service';
import {
  TmdbAuthError,
  type TmdbClient,
  type TmdbSearchResult,
  type TmdbSeason,
} from './tmdb.client';

const SEASON_TTL_MS = 3 * 24 * 3600_000;
const ERROR_RETRY_MS = 3600_000;

function yearOf(date: string | null | undefined): number | null {
  const year = Number((date ?? '').slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : null;
}

/** Choisit le résultat de recherche TMDB le plus plausible (titre exact, année, popularité). */
export function pickBestMatch(
  results: TmdbSearchResult[],
  title: string,
  year: number | null,
): TmdbSearchResult | null {
  const wanted = normalizeText(title);
  let best: { result: TmdbSearchResult; score: number } | null = null;
  results.slice(0, 10).forEach((result, index) => {
    const names = [result.title ?? result.name, result.original_title ?? result.original_name]
      .filter((name): name is string => !!name)
      .map(normalizeText);
    let score = 0;
    if (names.includes(wanted)) score += 5;
    else if (names.some((name) => name.includes(wanted) || wanted.includes(name))) score += 2;
    const resultYear = yearOf(result.release_date ?? result.first_air_date);
    if (year && resultYear) {
      if (resultYear === year) score += 4;
      else if (Math.abs(resultYear - year) === 1) score += 2;
      else score -= 3;
    }
    score += Math.min(1.5, Math.log10((result.vote_count ?? 0) + 1) / 2);
    score -= index * 0.1;
    if (!best || score > best.score) best = { result, score };
  });
  const winner = best as { result: TmdbSearchResult; score: number } | null;
  if (!winner) return null;
  return winner.score >= 2 || (year === null && results[0] === winner.result)
    ? winner.result
    : null;
}

/** Enrichit les titres du catalogue avec TMDB (affiches, résumés, genres, épisodes). */
export class MetadataService {
  private readonly inflight = new InFlight<number, TitleRow>();
  private running = false;
  private wakeUp: (() => void) | null = null;
  private authWarningShown = false;

  constructor(
    private readonly titles: TitlesRepository,
    private readonly tmdb: TmdbClient,
    private readonly settings: SettingsService,
    private readonly cache: KeyValueCache,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {
    let previousKey = settings.getTmdbApiKey();
    settings.onChange((next, previous) => {
      const key = settings.getTmdbApiKey();
      if (next.metadataLanguage !== previous.metadataLanguage) titles.resetMetadata();
      if (key !== previousKey) {
        previousKey = key;
        this.authWarningShown = false;
        titles.resetMetadata();
      }
      this.kick();
    });
  }

  isEnabled(): boolean {
    return this.settings.getTmdbApiKey() !== null;
  }

  /** Garantit que les métadonnées d'un titre ont été recherchées (au plus une requête en vol par titre). */
  async ensure(row: TitleRow, options: { force?: boolean } = {}): Promise<TitleRow> {
    if (!this.isEnabled()) return row;
    if (!options.force) {
      if (row.metadata_status === 'matched' || row.metadata_status === 'not_found') return row;
      if (
        row.metadata_status === 'error' &&
        row.metadata_updated_at &&
        Date.now() - Date.parse(row.metadata_updated_at) < ERROR_RETRY_MS
      ) {
        return row;
      }
    }
    return this.inflight.run(row.id, () => this.resolve(row));
  }

  async ensureById(id: number): Promise<TitleRow | undefined> {
    const row = this.titles.findById(id);
    return row ? this.ensure(row) : undefined;
  }

  /** Détails d'une saison (titres et vignettes des épisodes), mis en cache 3 jours. */
  async season(row: TitleRow, seasonNumber: number): Promise<TmdbSeason | null> {
    if (!this.isEnabled() || row.kind !== 'series' || row.tmdb_id === null) return null;
    const language = this.settings.get().metadataLanguage;
    const key = `tmdb:tv:${row.tmdb_id}:season:${seasonNumber}:${language}`;
    const cached = this.cache.get<TmdbSeason>(key);
    if (cached) return cached;
    try {
      const season = await this.tmdb.season(row.tmdb_id, seasonNumber, language);
      this.cache.set(key, season, SEASON_TTL_MS);
      return season;
    } catch (error) {
      this.logger.debug(
        { err: errorMessage(error), tvId: row.tmdb_id, seasonNumber },
        'Saison TMDB indisponible',
      );
      return null;
    }
  }

  /** Démarre l'enrichissement progressif du catalogue en arrière-plan. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.kick();
  }

  kick(): void {
    this.wakeUp?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (!this.isEnabled()) {
        await this.idle(10 * 60_000);
        continue;
      }
      const retryBefore = new Date(Date.now() - ERROR_RETRY_MS).toISOString();
      const batch = this.titles.pendingMetadata(10, retryBefore);
      if (batch.length === 0) {
        await this.idle(10 * 60_000);
        continue;
      }
      for (const row of batch) {
        if (!this.running || !this.isEnabled()) break;
        await this.ensure(row, { force: row.metadata_status === 'error' });
        await sleep(300);
      }
    }
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = () => {
        this.wakeUp = null;
        done();
      };
    });
  }

  private async resolve(row: TitleRow): Promise<TitleRow> {
    const language = this.settings.get().metadataLanguage;
    try {
      // Titre venu de TMDB : son identifiant est connu, inutile de le rechercher par nom.
      const metadata =
        row.origin === 'tmdb' && row.tmdb_id !== null
          ? await this.byId(row.kind, row.tmdb_id, language)
          : await this.lookup(row.kind, stripBracketedTags(row.parsed_title), row.year, language);
      if (metadata) this.titles.updateMetadata(row.id, metadata);
      else this.titles.setMetadataStatus(row.id, 'not_found', language);
    } catch (error) {
      if (error instanceof TmdbAuthError) {
        if (!this.authWarningShown) {
          this.authWarningShown = true;
          this.logger.warn('Clé TMDB refusée : vérifiez-la dans les paramètres.');
        }
      } else {
        this.logger.debug(
          { err: errorMessage(error), title: row.parsed_title },
          'Recherche TMDB échouée',
        );
      }
      this.titles.setMetadataStatus(row.id, 'error', language);
    }
    this.events.publish({ type: 'metadata.updated', titleId: row.id });
    return this.titles.findById(row.id) ?? row;
  }

  private async lookup(
    kind: TitleKind,
    title: string,
    year: number | null,
    language: string,
  ): Promise<TitleMetadata | null> {
    const search = (withYear: number | null) =>
      kind === 'movie'
        ? this.tmdb.searchMovie(title, withYear, language)
        : this.tmdb.searchTv(title, withYear, language);

    let match = pickBestMatch((await search(year)).results, title, year);
    if (!match && year !== null) match = pickBestMatch((await search(null)).results, title, year);
    if (!match) return null;
    return this.byId(kind, match.id, language);
  }

  /** Détails TMDB complets d'un titre dont l'identifiant est connu. */
  private async byId(kind: TitleKind, id: number, language: string): Promise<TitleMetadata> {
    if (kind === 'movie') {
      const movie = await this.tmdb.movie(id, language);
      let overview = movie.overview?.trim() || null;
      if (!overview && !language.startsWith('en')) {
        overview = (await this.tmdb.movie(id, 'en-US')).overview?.trim() || null;
      }
      return {
        status: 'matched',
        language,
        tmdbId: movie.id,
        tmdbTitle: movie.title,
        originalTitle: movie.original_title,
        overview,
        tagline: movie.tagline?.trim() || null,
        posterPath: movie.poster_path,
        backdropPath: movie.backdrop_path,
        rating: movie.vote_count ? movie.vote_average : null,
        voteCount: movie.vote_count,
        popularity: movie.popularity ?? null,
        genres: movie.genres.map((genre) => genre.name),
        runtime: movie.runtime || null,
        releaseDate: movie.release_date || null,
        metaSearchText: normalizeText(`${movie.title} ${movie.original_title}`),
      };
    }

    const show = await this.tmdb.tv(id, language);
    let overview = show.overview?.trim() || null;
    if (!overview && !language.startsWith('en')) {
      overview = (await this.tmdb.tv(id, 'en-US')).overview?.trim() || null;
    }
    return {
      status: 'matched',
      language,
      tmdbId: show.id,
      tmdbTitle: show.name,
      originalTitle: show.original_name,
      overview,
      tagline: show.tagline?.trim() || null,
      posterPath: show.poster_path,
      backdropPath: show.backdrop_path,
      rating: show.vote_count ? show.vote_average : null,
      voteCount: show.vote_count,
      popularity: show.popularity ?? null,
      genres: show.genres.map((genre) => genre.name),
      runtime: show.episode_run_time[0] ?? null,
      releaseDate: show.first_air_date || null,
      metaSearchText: normalizeText(`${show.name} ${show.original_name}`),
    };
  }
}
