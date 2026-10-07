import { mapWithConcurrency } from '../../core/async';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { KeyValueCache } from '../../infra/database/database';
import type { MetadataService } from '../metadata/metadata.service';
import type { TmdbClient, TmdbSeason, TmdbSeasonSummary } from '../metadata/tmdb.client';
import type { SettingsService } from '../settings/settings.service';
import type { AddonResult, StremioAddon } from '../source/stremio/stremio-addon';
import { isVirtualPath, virtualFolder } from '../source/stremio/virtual-path';
import type { TitleRow, TitlesRepository } from './titles.repository';

/**
 * Catalogue alimenté par une extension Stremio : les titres viennent de TMDB, les fichiers de
 * l'extension. L'identifiant IMDb d'un titre (attendu par l'extension) est demandé une fois
 * à TMDB puis gardé. Les saisons et épisodes d'une série viennent de TMDB ; les liens d'un
 * épisode ne sont demandés à l'extension qu'au moment de le lire ou de le télécharger.
 */

const SEASONS_TTL_MS = 24 * 3600_000;

export interface EpisodeOutline {
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
  runtime: number | null;
}

export interface SeasonOutline {
  number: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodes: EpisodeOutline[];
}

export class AddonCatalog {
  constructor(
    private readonly titles: TitlesRepository,
    private readonly tmdb: TmdbClient,
    private readonly metadata: MetadataService,
    private readonly addon: StremioAddon,
    private readonly settings: SettingsService,
    private readonly cache: KeyValueCache,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.addon.enabled;
  }

  /** Identifiant du titre pour l'extension (null si elle ne peut pas le chercher). */
  async contentId(row: TitleRow): Promise<string | null> {
    if (row.tmdb_id === null) return null;
    let imdb = row.imdb_id;
    if (!imdb) {
      try {
        const ids = await this.tmdb.externalIds(row.kind === 'movie' ? 'movie' : 'tv', row.tmdb_id);
        imdb = ids.imdb_id?.trim() || null;
        if (imdb) this.titles.setImdbId(row.id, imdb);
      } catch (error) {
        this.logger.debug({ err: errorMessage(error) }, 'Identifiant IMDb indisponible');
      }
    }
    const id = await this.addon.contentId(row.kind, { imdb, tmdb: row.tmdb_id });
    if (id) this.attach(row, id);
    return id;
  }

  /**
   * Rattache le titre à son dossier virtuel : téléchargements, reprises et bibliothèque
   * retrouvent ainsi leur titre par le chemin de leurs fichiers. Le nom de dossier
   * (« Titre (Année) ») reste celui des téléchargements.
   */
  private attach(row: TitleRow, id: string): void {
    const folder = virtualFolder(row.kind, id);
    if (row.remote_path === folder) return;
    const owner = this.titles.findByRemotePath(folder);
    if (owner && owner.id !== row.id) return;
    this.titles.setSource(row.id, {
      status: row.source_status === 'missing' ? 'unknown' : row.source_status,
      remotePath: folder,
    });
  }

  /** Dossier virtuel du titre s'il est déjà connu (sans requête). */
  knownFolder(row: TitleRow): string | null {
    return isVirtualPath(row.remote_path) ? row.remote_path : null;
  }

  /** Dossier virtuel d'un épisode (préfixe de ses fichiers). */
  async episodeFolder(row: TitleRow, season: number, episode: number): Promise<string | null> {
    const known = this.knownFolder(row);
    const folder =
      known ?? (await this.contentId(row).then((id) => (id ? virtualFolder('series', id) : null)));
    return folder ? `${folder}${season}x${episode}/` : null;
  }

  /** Versions d'un film proposées par l'extension. */
  async movieFiles(row: TitleRow): Promise<AddonResult> {
    const id = await this.contentId(row);
    if (!id) {
      return {
        files: [],
        notice: 'L’extension ne peut pas chercher ce titre (identifiant IMDb inconnu).',
        limited: false,
      };
    }
    const result = await this.addon.files({ kind: 'movie', id });
    // Une limite atteinte ne dit rien de la présence du film.
    if (result.files.length > 0 || !result.limited)
      this.titles.setSource(row.id, {
        status: result.files.length > 0 ? 'present' : 'missing',
        note: null,
      });
    return result;
  }

  /** Versions d'un épisode proposées par l'extension. */
  async episodeFiles(row: TitleRow, season: number, episode: number): Promise<AddonResult> {
    const id = await this.contentId(row);
    if (!id) {
      return {
        files: [],
        notice: 'L’extension ne peut pas chercher ce titre (identifiant IMDb inconnu).',
        limited: false,
      };
    }
    const result = await this.addon.files({ kind: 'series', id, season, episode });
    if (result.files.length > 0 && row.source_status !== 'present')
      this.titles.setSource(row.id, { status: 'present', note: null });
    return result;
  }

  /**
   * Saisons et épisodes d'une série d'après TMDB : sans les épisodes spéciaux (sauf s'il n'y a
   * qu'eux) ni les épisodes pas encore diffusés.
   */
  async seasons(row: TitleRow): Promise<SeasonOutline[]> {
    if (row.tmdb_id === null) return [];
    const language = this.settings.get().metadataLanguage;
    const key = `addon:seasons:${row.tmdb_id}:${language}`;
    let summaries = this.cache.get<TmdbSeasonSummary[]>(key);
    if (!summaries) {
      summaries = (await this.tmdb.tv(row.tmdb_id, language)).seasons ?? [];
      this.cache.set(key, summaries, SEASONS_TTL_MS);
    }
    const regular = summaries.filter((season) => season.season_number > 0);
    const kept = (regular.length > 0 ? regular : summaries).filter(
      (season) => season.episode_count > 0,
    );
    const details = await mapWithConcurrency(kept, 3, (season) =>
      this.metadata.season(row, season.season_number),
    );
    const today = new Date().toISOString().slice(0, 10);
    const outlines = kept.map((summary, index) => {
      const season: TmdbSeason | null = details[index] ?? null;
      const numbers = season?.episodes.length
        ? season.episodes
            .filter((item) => !item.air_date || item.air_date <= today)
            .map((item) => item.episode_number)
        : Array.from({ length: summary.episode_count }, (_, item) => item + 1);
      return {
        number: summary.season_number,
        name: summary.name || `Saison ${summary.season_number}`,
        overview: season?.overview?.trim() || summary.overview?.trim() || null,
        posterPath: season?.poster_path ?? summary.poster_path,
        episodes: numbers.map((number) => {
          const info = season?.episodes.find((item) => item.episode_number === number);
          return {
            season: summary.season_number,
            episode: number,
            title: info?.name?.trim() || null,
            overview: info?.overview?.trim() || null,
            stillPath: info?.still_path ?? null,
            airDate: info?.air_date ?? null,
            runtime: info?.runtime ?? null,
          };
        }),
      };
    });
    return outlines.filter((season) => season.episodes.length > 0);
  }

  /** Épisode qui suit (même saison, sinon début de la suivante). */
  async nextEpisode(
    row: TitleRow,
    season: number,
    episode: number,
  ): Promise<{ season: number; episode: number } | null> {
    const seasons = await this.seasons(row);
    const episodes = seasons.flatMap((item) => item.episodes);
    const index = episodes.findIndex((item) => item.season === season && item.episode === episode);
    const next = index >= 0 ? episodes[index + 1] : undefined;
    return next ? { season: next.season, episode: next.episode } : null;
  }
}
