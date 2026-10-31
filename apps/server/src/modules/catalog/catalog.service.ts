import type {
  CatalogQuery,
  CatalogSectionStatus,
  EpisodeFiles,
  GenreCount,
  HomeFeed,
  MediaAvailability,
  Page,
  RemoteFile,
  SeasonEntry,
  TitleDetails,
  TitleKind,
  TitleSummary,
} from '@lumiere/shared';
import { BadRequestError, NotFoundError, errorMessage } from '../../core/errors';
import type { EventBus } from '../../core/event-bus';
import type { Logger } from '../../core/logger';
import { searchTokens } from '../../core/text';
import type { EpisodeRef } from '../../domain/episode-parser';
import { compareByQuality } from '../../domain/file-selection';
import { parseRelease } from '../../domain/release-parser';
import {
  emptyAvailability,
  type AvailabilityService,
  type TitleCopy,
} from '../availability/availability.service';
import type { MetadataService } from '../metadata/metadata.service';
import type { SettingsService } from '../settings/settings.service';
import { remoteBaseName } from '../source/remote-path';
import type { AddonFile, AddonResult } from '../source/stremio/stremio-addon';
import { parseVirtualPath } from '../source/stremio/virtual-path';
import type { AddonCatalog, SeasonOutline } from './addon-catalog';
import { imageUrl, toTitleSummary } from './presenters';
import type { TmdbCatalog } from './tmdb-catalog';
import type { CatalogSectionsRepository, TitleRow, TitlesRepository } from './titles.repository';

const KINDS: TitleKind[] = ['movie', 'series'];

/** Fichier à présenter : proposé par une extension, ou copie déjà connue. */
interface FileEntry {
  name: string;
  path: string;
  size: number | null;
  label: string | null;
}

/**
 * Catalogue : les titres viennent des listes et de la recherche de TMDB, leurs fichiers des
 * extensions Stremio configurées (demandés à l'ouverture d'un film, ou à la lecture et au
 * téléchargement d'un épisode).
 */
export class CatalogService {
  private readonly refreshes = new Map<TitleKind, Promise<CatalogSectionStatus>>();
  /** Sections dont la popularité manquante a déjà été rattrapée depuis le démarrage. */
  private readonly popularityChecked = new Set<TitleKind>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly titles: TitlesRepository,
    private readonly sections: CatalogSectionsRepository,
    private readonly settings: SettingsService,
    private readonly metadata: MetadataService,
    private readonly availability: AvailabilityService,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly tmdbCatalog: TmdbCatalog,
    private readonly addon: AddonCatalog,
  ) {
    sections.resetInterrupted();
    // Clé TMDB ajoutée ou remplacée (premier lancement…), ou catalogue agrandi : catalogue
    // importé sans attendre.
    let tmdbKey = settings.getTmdbApiKey();
    settings.onChange((next, previous) => {
      const key = settings.getTmdbApiKey();
      const keyChanged = key !== tmdbKey;
      tmdbKey = key;
      if (key && (keyChanged || next.catalogSize > previous.catalogSize))
        for (const kind of KINDS) this.refreshInBackground(kind);
    });
  }

  // -------------------------------------------------------------------------
  // Import depuis TMDB
  // -------------------------------------------------------------------------

  start(): void {
    this.timer = setInterval(() => void this.refreshIfStale(), 10 * 60_000);
    this.timer.unref();
    void this.refreshIfStale();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(kind: TitleKind): CatalogSectionStatus {
    const status = this.sections.get(kind);
    return this.refreshes.has(kind) ? { ...status, state: 'refreshing' } : status;
  }

  statuses(): CatalogSectionStatus[] {
    return KINDS.map((kind) => this.status(kind));
  }

  async refreshIfStale(): Promise<void> {
    const hours = this.settings.get().catalogRefreshHours;
    for (const kind of KINDS) {
      const status = this.status(kind);
      const age = status.lastRefreshAt ? Date.now() - Date.parse(status.lastRefreshAt) : Infinity;
      // Catalogue antérieur au tri par popularité : ses titres n'en ont pas encore (une fois
      // par démarrage, pour ne pas boucler si TMDB n'en fournit pas).
      let missingPopularity = false;
      if (
        status.lastRefreshAt &&
        this.metadata.isEnabled() &&
        !this.popularityChecked.has(kind) &&
        !this.titles.hasPopularity(kind)
      ) {
        this.popularityChecked.add(kind);
        missingPopularity = true;
      }
      const stale =
        !status.lastRefreshAt || missingPopularity || (hours > 0 && age > hours * 3600_000);
      if (stale) {
        await this.refresh(kind).catch((error) =>
          this.logger.warn(
            { kind, err: errorMessage(error) },
            'Actualisation du catalogue impossible',
          ),
        );
      }
    }
  }

  refreshInBackground(kind: TitleKind): void {
    this.refresh(kind).catch((error) =>
      this.logger.warn({ kind, err: errorMessage(error) }, 'Actualisation du catalogue impossible'),
    );
  }

  refresh(kind: TitleKind): Promise<CatalogSectionStatus> {
    const pending = this.refreshes.get(kind);
    if (pending) return pending;
    const promise = this.runRefresh(kind).finally(() => this.refreshes.delete(kind));
    this.refreshes.set(kind, promise);
    return promise;
  }

  private async runRefresh(kind: TitleKind): Promise<CatalogSectionStatus> {
    const previous = this.sections.get(kind);
    this.events.publish({ type: 'catalog.updated', status: { ...previous, state: 'refreshing' } });
    const started = Date.now();
    try {
      if (!this.metadata.isEnabled()) {
        throw new Error(
          'Le catalogue vient de TMDB : ajoutez une clé TMDB (Paramètres → Sous-titres et clés), gratuite.',
        );
      }
      const seen = await this.tmdbCatalog.importLists(kind);
      const status: CatalogSectionStatus = {
        kind,
        state: 'idle',
        count: this.titles.count(kind),
        lastRefreshAt: new Date().toISOString(),
        lastError: null,
      };
      this.sections.save(status);
      this.events.publish({ type: 'catalog.updated', status });
      this.metadata.kick();
      this.logger.info(
        { kind, seen, total: status.count, ms: Date.now() - started },
        'Catalogue TMDB actualisé',
      );
      return status;
    } catch (error) {
      const status: CatalogSectionStatus = {
        ...previous,
        state: 'error',
        lastError: errorMessage(error),
      };
      this.sections.save(status);
      this.events.publish({ type: 'catalog.updated', status });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Consultation
  // -------------------------------------------------------------------------

  summaries(rows: TitleRow[]): TitleSummary[] {
    const counts = this.titles.libraryCounts(rows.map((row) => row.id));
    const enabled = this.metadata.isEnabled();
    return rows.map((row) => toTitleSummary(row, enabled, counts.get(row.id) ?? 0));
  }

  async search(query: CatalogQuery): Promise<Page<TitleSummary>> {
    const text = query.q?.trim() ?? '';
    if (text.length >= 2 && (query.page ?? 1) === 1 && this.metadata.isEnabled()) {
      // La recherche couvre tous les films et séries de TMDB, pas seulement les listes.
      await this.tmdbCatalog
        .search(text, query.kind)
        .catch((error) =>
          this.logger.warn({ err: errorMessage(error), query: text }, 'Recherche TMDB impossible'),
        );
    }
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 40));
    const { rows, total } = this.titles.search({
      kind: query.kind,
      tokens: query.q ? searchTokens(query.q) : [],
      genre: query.genre,
      sort: query.sort ?? 'popular',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items: this.summaries(rows), page, pageSize, total, hasMore: page * pageSize < total };
  }

  home(): HomeFeed {
    return {
      featured: this.summaries(this.titles.featured(8)),
      popularMovies: this.summaries(this.titles.popular('movie', 24)),
      popularSeries: this.summaries(this.titles.popular('series', 24)),
      sections: this.statuses(),
    };
  }

  genres(kind?: TitleKind): GenreCount[] {
    return this.titles.genres(kind);
  }

  getRow(id: number): TitleRow {
    const row = this.titles.findById(id);
    if (!row) throw new NotFoundError('Titre introuvable.');
    return row;
  }

  private baseDetails(row: TitleRow): TitleDetails {
    const [summary] = this.summaries([row]);
    return {
      ...(summary as TitleSummary),
      remotePath: row.remote_path,
      originalTitle: row.original_title,
      tagline: row.tagline,
      runtime: row.runtime,
      releaseDate: row.release_date,
      tmdbId: row.tmdb_id,
      imdbId: row.imdb_id,
      metadataStatus: this.metadata.isEnabled() ? row.metadata_status : 'disabled',
      files: [],
      seasons: [],
      sourceNotice: null,
    };
  }

  /**
   * Fiche d'un titre : ce qui est sur le disque (ou en cours de téléchargement). Aucune source
   * n'est interrogée à l'ouverture : les versions d'un film sont demandées aux extensions par
   * `movieVersions`, celles d'un épisode par `episodeFiles`, quand on choisit de télécharger.
   */
  async details(id: number): Promise<TitleDetails> {
    const row = await this.metadata.ensure(this.getRow(id));
    if (row.kind === 'movie') {
      const fresh = this.titles.findById(id) ?? row;
      return { ...this.baseDetails(fresh), files: this.copyFiles(this.movieCopies(fresh)) };
    }
    let notice: string | null = null;
    try {
      // Rattache la série à son dossier virtuel (copies déjà téléchargées ou regardées).
      await this.addon.contentId(row);
    } catch (error) {
      notice = errorMessage(error);
    }
    const fresh = this.titles.findById(id) ?? row;
    let seasons: SeasonEntry[] = [];
    try {
      seasons = await this.seasons(fresh);
    } catch (error) {
      notice ??= `Saisons indisponibles : ${errorMessage(error)}`;
    }
    return { ...this.baseDetails(fresh), seasons, sourceNotice: notice };
  }

  /** Versions proposées par les extensions, avec leur état (téléchargée, en cours…). */
  private offeredFiles(files: AddonFile[], ref?: EpisodeRef): RemoteFile[] {
    const entries: FileEntry[] = files
      .map((file) => ({ name: file.fileName, path: file.path, size: file.size, label: file.label }))
      .sort(compareByQuality);
    const availability = this.availability.forRemotePaths(entries.map((entry) => entry.path));
    return entries.map((entry) => toRemoteFile(entry, availability.get(entry.path), ref));
  }

  /** Copies d'un titre présentées comme des fichiers (meilleure qualité d'abord). */
  private copyFiles(copies: TitleCopy[], ref?: EpisodeRef): RemoteFile[] {
    const entries = copies.map((copy) => ({ ...copy, label: null })).sort(compareByQuality);
    const availability = this.availability.forRemotePaths(
      entries.filter((copy) => !copy.localFile).map((copy) => copy.path),
    );
    return entries.map((copy) =>
      toRemoteFile(
        copy,
        copy.localFile ? this.availability.localAvailability(copy) : availability.get(copy.path),
        ref ??
          (copy.season !== null && copy.episode !== null
            ? { season: copy.season, episode: copy.episode, episodeEnd: null }
            : undefined),
      ),
    );
  }

  /**
   * Copies d'un film : celles rattachées au titre, et celles de son dossier d'extension
   * (téléchargements plus anciens que le rattachement par titre).
   */
  private movieCopies(row: TitleRow): TitleCopy[] {
    const copies = this.availability.titleCopies(row.id);
    const folder = this.addon.knownFolder(row);
    const known = new Set(copies.map((copy) => copy.path));
    for (const path of folder ? this.availability.knownPathsUnder(folder) : []) {
      if (known.has(path) || !parseVirtualPath(path)?.fileName) continue;
      copies.push(remoteCopy(path));
    }
    return copies;
  }

  /**
   * Copies des épisodes d'une série : rattachées au titre, ou dans son dossier d'extension
   * (y compris les épisodes regardés en streaming, pour leur état « vu »).
   */
  private seriesCopies(row: TitleRow): TitleCopy[] {
    const copies = this.availability
      .titleCopies(row.id)
      .filter((copy) => copy.season !== null && copy.episode !== null);
    const folder = this.addon.knownFolder(row);
    const known = new Set(copies.map((copy) => copy.path));
    for (const path of folder ? this.availability.knownPathsUnder(folder, { watched: true }) : []) {
      const ref = parseVirtualPath(path);
      if (known.has(path) || !ref?.fileName || ref.season === null || ref.episode === null)
        continue;
      copies.push({ ...remoteCopy(path), season: ref.season, episode: ref.episode });
    }
    return copies;
  }

  /** Saisons TMDB ; les fichiers d'un épisode sont ses copies connues (téléchargées, regardées). */
  private async seasons(row: TitleRow): Promise<SeasonEntry[]> {
    const outlines = await this.addon.seasons(row);
    const byEpisode = new Map<string, TitleCopy[]>();
    for (const copy of this.seriesCopies(row)) {
      const key = `${copy.season}x${copy.episode}`;
      byEpisode.set(key, [...(byEpisode.get(key) ?? []), copy]);
    }
    return outlines.map((season) => ({
      key: `s${season.number}`,
      number: season.number,
      name: season.name,
      posterUrl: imageUrl(season.posterPath, 'w342'),
      overview: season.overview,
      episodes: season.episodes.map((episode) => {
        const ref = { season: episode.season, episode: episode.episode, episodeEnd: null };
        return {
          key: `s${episode.season}e${episode.episode}`,
          ...ref,
          title: episode.title ?? `Épisode ${episode.episode}`,
          overview: episode.overview,
          stillUrl: imageUrl(episode.stillPath, 'w300'),
          airDate: episode.airDate,
          runtime: episode.runtime,
          files: this.copyFiles(byEpisode.get(`${episode.season}x${episode.episode}`) ?? [], ref),
        };
      }),
    }));
  }

  private requireSeries(id: number): TitleRow {
    const row = this.getRow(id);
    if (row.kind !== 'series') throw new BadRequestError('Ce titre n’est pas une série.');
    return row;
  }

  /** Versions d'un film proposées par les extensions, avec leur état (une demande de liens). */
  async movieVersions(id: number): Promise<EpisodeFiles> {
    const row = this.getRow(id);
    if (row.kind !== 'movie') throw new BadRequestError('Ce titre n’est pas un film.');
    let result: AddonResult = { files: [], notice: null, limited: false };
    try {
      result = await this.addon.movieFiles(row);
    } catch (error) {
      result = { ...result, notice: errorMessage(error) };
    }
    return { files: this.offeredFiles(result.files), notice: result.notice };
  }

  /** Versions d'un film proposées par les extensions (une demande de liens). */
  async movieFiles(row: TitleRow): Promise<AddonFile[]> {
    const result = await this.addon.movieFiles(row);
    if (result.files.length === 0) {
      throw new NotFoundError(
        result.notice ?? 'Aucune extension Stremio ne propose de fichier pour ce film.',
      );
    }
    return result.files;
  }

  /** Versions d'un épisode proposées par les extensions (une demande de liens). */
  async episodeFiles(
    id: number,
    season: number,
    episode: number,
  ): Promise<EpisodeFiles & { limited: boolean }> {
    const row = this.requireSeries(id);
    const result = await this.addon.episodeFiles(row, season, episode);
    return {
      files: this.offeredFiles(result.files, { season, episode, episodeEnd: null }),
      notice: result.notice,
      limited: result.limited,
    };
  }

  /** Copies d'un épisode déjà téléchargées ou en file (sans demande de liens). */
  async episodeCopies(id: number, season: number, episode: number): Promise<string[]> {
    const row = this.requireSeries(id);
    const folder = await this.addon.episodeFolder(row, season, episode);
    const copies = this.availability
      .titleCopies(id)
      .filter((copy) => copy.season === season && copy.episode === episode)
      .map((copy) => copy.path);
    return [...(folder ? this.availability.knownPathsUnder(folder) : []), ...copies];
  }

  /** Saisons et épisodes (TMDB) d'une série. */
  episodeOutline(id: number): Promise<SeasonOutline[]> {
    return this.addon.seasons(this.requireSeries(id));
  }

  nextEpisode(
    row: TitleRow,
    season: number,
    episode: number,
  ): Promise<{ season: number; episode: number } | null> {
    return this.addon.nextEpisode(row, season, episode);
  }
}

/** Copie connue par son seul chemin distant (dossier d'extension). */
function remoteCopy(path: string): TitleCopy {
  return {
    path,
    name: remoteBaseName(path),
    size: null,
    season: null,
    episode: null,
    localFile: null,
    libraryItemId: null,
  };
}

function toRemoteFile(
  entry: FileEntry,
  availability: MediaAvailability | undefined,
  ref?: EpisodeRef,
): RemoteFile {
  return {
    name: entry.name,
    path: entry.path,
    size: entry.size,
    modifiedAt: null,
    release: parseRelease(entry.name).info,
    season: ref?.season ?? null,
    episode: ref?.episode ?? null,
    episodeEnd: ref?.episodeEnd ?? null,
    availability: availability ?? emptyAvailability(),
    label: entry.label,
  };
}
