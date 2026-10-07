import type {
  CatalogMode,
  CatalogQuery,
  CatalogSectionStatus,
  EpisodeEntry,
  EpisodeFiles,
  GenreCount,
  HomeFeed,
  MediaAvailability,
  Page,
  RemoteFile,
  RemoteSubtitle,
  SeasonEntry,
  TitleDetails,
  TitleKind,
  TitleSummary,
} from '@lumiere/shared';
import { mapWithConcurrency } from '../../core/async';
import { BadRequestError, NotFoundError, errorMessage } from '../../core/errors';
import type { EventBus } from '../../core/event-bus';
import type { Logger } from '../../core/logger';
import { normalizeText, prettifyTitle, searchTokens, sortKey } from '../../core/text';
import type { EpisodeRef } from '../../domain/episode-parser';
import { compareByQuality } from '../../domain/file-selection';
import {
  classifyFile,
  guessSubtitleLanguage,
  isSampleFile,
  stripExtension,
} from '../../domain/media-files';
import { parseRelease } from '../../domain/release-parser';
import { parseFolderTitle } from '../../domain/title-parser';
import { emptyAvailability, type AvailabilityService } from '../availability/availability.service';
import type { MetadataService } from '../metadata/metadata.service';
import type { TmdbSeason } from '../metadata/tmdb.client';
import type { SettingsService } from '../settings/settings.service';
import { remoteBaseName, remoteParent } from '../source/remote-path';
import type { RemoteEntry, SourceClient } from '../source/source-client';
import type { AddonFile, AddonResult } from '../source/stremio/stremio-addon';
import { parseVirtualPath } from '../source/stremio/virtual-path';
import type { AddonCatalog, SeasonOutline } from './addon-catalog';
import { imageUrl, toTitleSummary } from './presenters';
import {
  groupSeries,
  type FolderListing,
  type GroupedEpisode,
  type GroupedSeason,
} from './series-structure';
import type { SourceResolver } from './source-resolver';
import type { TmdbCatalog } from './tmdb-catalog';
import type {
  CatalogSectionsRepository,
  TitleRow,
  TitleUpsert,
  TitlesRepository,
} from './titles.repository';

const KINDS: TitleKind[] = ['movie', 'series'];

const isVideo = (entry: RemoteEntry) =>
  !entry.isDirectory && classifyFile(entry.name) === 'video' && !isSampleFile(entry.name);

export class CatalogService {
  private readonly refreshes = new Map<TitleKind, Promise<CatalogSectionStatus>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly titles: TitlesRepository,
    private readonly sections: CatalogSectionsRepository,
    private readonly source: SourceClient,
    private readonly settings: SettingsService,
    private readonly metadata: MetadataService,
    private readonly availability: AvailabilityService,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly tmdbCatalog: TmdbCatalog,
    private readonly resolver: SourceResolver,
    private readonly addon: AddonCatalog,
  ) {
    sections.resetInterrupted();
    settings.onChange((next, previous) => {
      const addonToggled = (next.stremioAddonUrl === '') !== (previous.stremioAddonUrl === '');
      const sourceChanged =
        addonToggled ||
        next.sourceBaseUrl !== previous.sourceBaseUrl ||
        next.catalogSource !== previous.catalogSource;
      if (sourceChanged || next.moviesPath !== previous.moviesPath)
        this.refreshInBackground('movie');
      if (sourceChanged || next.seriesPath !== previous.seriesPath)
        this.refreshInBackground('series');
    });
  }

  /**
   * Extension Stremio active : le catalogue vient de TMDB et les fichiers de l'extension
   * (la source n'est plus lue directement).
   */
  get addonMode(): boolean {
    return this.addon.enabled;
  }

  /**
   * Le catalogue vient-il de TMDB (extension Stremio, choix, ou repli automatique quand la
   * liste complète de la source est illisible) ? La recherche interroge alors aussi TMDB.
   */
  tmdbActive(kind?: TitleKind): boolean {
    if (!this.metadata.isEnabled()) return false;
    if (this.addon.enabled) return true;
    const source = this.settings.get().catalogSource;
    if (source !== 'auto') return source === 'tmdb';
    return KINDS.filter((item) => !kind || item === kind).some(
      (item) => this.status(item).mode === 'tmdb',
    );
  }

  // -------------------------------------------------------------------------
  // Synchronisation avec la source
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

  sectionPath(kind: TitleKind): string {
    const settings = this.settings.get();
    return kind === 'movie' ? settings.moviesPath : settings.seriesPath;
  }

  status(kind: TitleKind): CatalogSectionStatus {
    const status = this.sections.get(kind, this.sectionPath(kind));
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
      // Extension activée ou désactivée depuis la dernière actualisation.
      const modeChanged = this.addon.enabled ? status.mode !== 'addon' : status.mode === 'addon';
      const stale =
        !status.lastRefreshAt ||
        status.path !== this.sectionPath(kind) ||
        modeChanged ||
        (hours > 0 && age > hours * 3600_000);
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
    const path = this.sectionPath(kind);
    const previous = this.sections.get(kind, path);
    this.events.publish({
      type: 'catalog.updated',
      status: { ...previous, path, state: 'refreshing' },
    });
    // Extension Stremio : catalogue TMDB, la liste de la source n'est pas lue.
    if (this.addon.enabled) return this.refreshFromTmdb(kind, path, previous, null, 'addon');
    const source = this.settings.get().catalogSource;
    if (source === 'tmdb') return this.refreshFromTmdb(kind, path, previous, null, 'tmdb');
    try {
      return await this.refreshFromListing(kind, path, previous);
    } catch (error) {
      // Repli : la liste complète est illisible (trop volumineuse, bloquée…) → TMDB.
      if (source === 'auto' && this.metadata.isEnabled())
        return this.refreshFromTmdb(kind, path, previous, error, 'tmdb');
      throw error;
    }
  }

  private async refreshFromTmdb(
    kind: TitleKind,
    path: string,
    previous: CatalogSectionStatus,
    listingError: unknown,
    mode: Exclude<CatalogMode, 'listing'>,
  ): Promise<CatalogSectionStatus> {
    const started = Date.now();
    try {
      if (!this.metadata.isEnabled()) {
        throw new Error(
          mode === 'addon'
            ? 'Avec l’extension Stremio, le catalogue vient de TMDB : ajoutez une clé TMDB (Paramètres → Métadonnées), gratuite.'
            : 'Le catalogue TMDB nécessite une clé TMDB (Paramètres → Métadonnées), gratuite.',
        );
      }
      const seen = await this.tmdbCatalog.importLists(kind);
      const reason = listingError
        ? `La liste complète de ${path} n’a pas pu être lue (${errorMessage(listingError).slice(0, 180)}). `
        : '';
      const note =
        mode === 'addon'
          ? 'Catalogue issu de TMDB : les fichiers sont demandés à l’extension Stremio à l’ouverture d’un film, ou à la lecture et au téléchargement d’un épisode.'
          : `${reason}Catalogue issu de TMDB : chaque titre est cherché sur la source à l’ouverture de sa fiche.`;
      const status: CatalogSectionStatus = {
        kind,
        path,
        state: 'idle',
        count: this.titles.count(kind),
        lastRefreshAt: new Date().toISOString(),
        lastError: null,
        mode,
        note,
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
        path,
        state: 'error',
        lastError: errorMessage(error),
        mode,
        note: null,
      };
      this.sections.save(status);
      this.events.publish({ type: 'catalog.updated', status });
      throw error;
    }
  }

  private async refreshFromListing(
    kind: TitleKind,
    path: string,
    previous: CatalogSectionStatus,
  ): Promise<CatalogSectionStatus> {
    const started = Date.now();
    try {
      const listing = await this.source.list(path, { force: true });
      const items = this.toUpserts(kind, listing.entries);
      if (items.length === 0) {
        throw new Error(
          listing.entries.length === 0
            ? `Aucune entrée reconnue dans ${listing.url} (format de listing inattendu ?)`
            : `Aucun titre exploitable dans ${listing.url}`,
        );
      }
      const seenAt = new Date().toISOString();
      const { total, removed } = this.titles.syncSection(kind, items, seenAt);
      const status: CatalogSectionStatus = {
        kind,
        path,
        state: 'idle',
        count: total,
        lastRefreshAt: seenAt,
        lastError: null,
        mode: 'listing',
        note: null,
      };
      this.sections.save(status);
      this.events.publish({ type: 'catalog.updated', status });
      this.metadata.kick();
      this.logger.info(
        { kind, total, removed, format: listing.format, ms: Date.now() - started },
        'Catalogue actualisé',
      );
      return status;
    } catch (error) {
      const status: CatalogSectionStatus = {
        ...previous,
        path,
        state: 'error',
        lastError: errorMessage(error),
        mode: 'listing',
        note: null,
      };
      if (this.settings.get().catalogSource === 'listing' || !this.metadata.isEnabled()) {
        this.sections.save(status);
        this.events.publish({ type: 'catalog.updated', status });
      }
      throw error;
    }
  }

  private toUpserts(kind: TitleKind, entries: RemoteEntry[]): TitleUpsert[] {
    const items: TitleUpsert[] = [];
    for (const entry of entries) {
      let parsed: { title: string; year: number | null };
      if (entry.isDirectory) {
        parsed = parseFolderTitle(entry.name);
      } else if (kind === 'movie' && isVideo(entry)) {
        const release = parseRelease(entry.name);
        parsed = { title: prettifyTitle(release.title), year: release.year };
      } else {
        continue;
      }
      if (!parsed.title) continue;
      items.push({
        kind,
        remotePath: entry.path,
        folderName: entry.name,
        isFile: !entry.isDirectory,
        title: parsed.title,
        year: parsed.year,
        searchText: normalizeText(`${parsed.title} ${entry.name}`),
        sortKey: sortKey(parsed.title),
        modifiedAt: entry.modifiedAt,
        size: entry.size,
      });
    }
    return items;
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
    if (text.length >= 2 && (query.page ?? 1) === 1 && this.tmdbActive(query.kind)) {
      // Catalogue TMDB : la recherche couvre tous les films et séries, pas seulement les listes.
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
      sort: query.sort ?? 'recent',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items: this.summaries(rows), page, pageSize, total, hasMore: page * pageSize < total };
  }

  home(): HomeFeed {
    const featured = this.titles.featured(8);
    if (featured.length < 3) {
      const ids = new Set(featured.map((row) => row.id));
      for (const row of [...this.titles.recent('movie', 6), ...this.titles.recent('series', 4)]) {
        if (featured.length >= 6) break;
        if (!ids.has(row.id)) featured.push(row);
      }
    }
    return {
      featured: this.summaries(featured),
      recentMovies: this.summaries(this.titles.recent('movie', 24)),
      recentSeries: this.summaries(this.titles.recent('series', 24)),
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
      metadataStatus: this.metadata.isEnabled() ? row.metadata_status : 'disabled',
      files: [],
      subtitles: [],
      seasons: [],
      sourceTried: [],
      sourceNotice: null,
      streamsOnDemand: false,
    };
  }

  async details(id: number): Promise<TitleDetails> {
    if (this.addon.enabled) return this.addonDetails(id);
    // Titre venu de TMDB : son dossier est cherché sur la source à la première ouverture.
    const row = await this.resolver.ensure(await this.metadata.ensure(this.getRow(id)));
    const base = this.baseDetails(row);
    if (row.source_status === 'missing') return { ...base, sourceTried: parseTried(row) };
    if (row.kind === 'movie') {
      const { files, subtitles } = await this.movieFiles(row);
      return { ...base, files, subtitles };
    }
    return { ...base, seasons: await this.seasons(row) };
  }

  // -------------------------------------------------------------------------
  // Extension Stremio
  // -------------------------------------------------------------------------

  /**
   * Fiche en mode extension : les versions d'un film sont demandées à l'extension à
   * l'ouverture ; les épisodes d'une série viennent de TMDB, et leurs fichiers ne sont
   * demandés qu'à la lecture ou au téléchargement (pour ménager la limite de liens).
   */
  private async addonDetails(id: number): Promise<TitleDetails> {
    const row = await this.metadata.ensure(this.getRow(id));
    if (row.kind === 'movie') {
      let result: AddonResult = { files: [], notice: null, limited: false };
      try {
        result = await this.addon.movieFiles(row);
      } catch (error) {
        result = { ...result, notice: errorMessage(error) };
      }
      const fresh = this.titles.findById(id) ?? row;
      return {
        ...this.baseDetails(fresh),
        files: this.addonFiles(result.files, this.addon.knownFolder(fresh)),
        sourceNotice: result.notice,
      };
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
      seasons = await this.addonSeasons(fresh);
    } catch (error) {
      notice ??= `Saisons indisponibles : ${errorMessage(error)}`;
    }
    return { ...this.baseDetails(fresh), seasons, sourceNotice: notice, streamsOnDemand: true };
  }

  /** Fichiers proposés par l'extension, complétés des copies déjà téléchargées. */
  private addonFiles(files: AddonFile[], folder: string | null, ref?: EpisodeRef): RemoteFile[] {
    const offered = new Set(files.map((file) => file.path));
    const known = folder
      ? this.availability
          .knownPathsUnder(folder)
          .filter((path) => !offered.has(path) && parseVirtualPath(path)?.fileName)
      : [];
    const entries = [
      ...files.map((file) => ({
        name: file.fileName,
        path: file.path,
        size: file.size,
        label: file.label,
      })),
      ...known.map((path) => ({ name: remoteBaseName(path), path, size: null, label: null })),
    ].sort(compareByQuality);
    const availability = this.availability.forRemotePaths(entries.map((entry) => entry.path));
    return entries.map((entry) => ({
      ...toRemoteFile(
        {
          name: entry.name,
          path: entry.path,
          isDirectory: false,
          size: entry.size,
          modifiedAt: null,
        },
        availability.get(entry.path),
        ref,
      ),
      label: entry.label,
    }));
  }

  /** Saisons TMDB ; les fichiers d'un épisode sont ses copies connues (téléchargées, regardées). */
  private async addonSeasons(row: TitleRow): Promise<SeasonEntry[]> {
    const outlines = await this.addon.seasons(row);
    const folder = this.addon.knownFolder(row);
    const known = folder ? this.availability.knownPathsUnder(folder, { watched: true }) : [];
    const byEpisode = new Map<string, string[]>();
    for (const path of known) {
      const ref = parseVirtualPath(path);
      if (!ref?.fileName || ref.season === null || ref.episode === null) continue;
      const key = `${ref.season}x${ref.episode}`;
      byEpisode.set(key, [...(byEpisode.get(key) ?? []), path]);
    }
    const availability = this.availability.forRemotePaths(known);
    return outlines.map((season) => ({
      key: `s${season.number}`,
      number: season.number,
      name: season.name,
      path: null,
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
          files: (byEpisode.get(`${episode.season}x${episode.episode}`) ?? [])
            .map((path) => ({
              name: remoteBaseName(path),
              path,
              isDirectory: false,
              size: null,
              modifiedAt: null,
            }))
            .sort(compareByQuality)
            .map((entry) => toRemoteFile(entry, availability.get(entry.path), ref)),
        };
      }),
    }));
  }

  private requireAddonSeries(id: number): TitleRow {
    const row = this.getRow(id);
    if (row.kind !== 'series') throw new BadRequestError('Ce titre n’est pas une série.');
    if (!this.addon.enabled)
      throw new BadRequestError(
        'Aucune extension Stremio n’est configurée (Paramètres → Extension Stremio).',
      );
    return row;
  }

  /** Versions d'un épisode proposées par l'extension (une demande de liens). */
  async episodeFiles(
    id: number,
    season: number,
    episode: number,
  ): Promise<EpisodeFiles & { limited: boolean }> {
    const row = this.requireAddonSeries(id);
    const result = await this.addon.episodeFiles(row, season, episode);
    const folder = await this.addon.episodeFolder(this.titles.findById(id) ?? row, season, episode);
    return {
      files: this.addonFiles(result.files, folder, { season, episode, episodeEnd: null }),
      notice: result.notice,
      limited: result.limited,
    };
  }

  /** Copies d'un épisode déjà téléchargées ou en file (sans demande de liens). */
  async episodeCopies(id: number, season: number, episode: number): Promise<string[]> {
    const row = this.requireAddonSeries(id);
    const folder = await this.addon.episodeFolder(row, season, episode);
    return folder ? this.availability.knownPathsUnder(folder) : [];
  }

  /** Saisons et épisodes (TMDB) d'une série en mode extension. */
  episodeOutline(id: number): Promise<SeasonOutline[]> {
    return this.addon.seasons(this.requireAddonSeries(id));
  }

  nextEpisode(
    row: TitleRow,
    season: number,
    episode: number,
  ): Promise<{ season: number; episode: number } | null> {
    return this.addon.nextEpisode(row, season, episode);
  }

  // -------------------------------------------------------------------------
  // Fichiers sur la source
  // -------------------------------------------------------------------------

  /** Fichiers vidéo (et sous-titres) d'un film. */
  async movieEntries(row: TitleRow): Promise<{ videos: RemoteEntry[]; subtitles: RemoteEntry[] }> {
    if (this.addon.enabled) {
      const result = await this.addon.movieFiles(row);
      if (result.files.length === 0) {
        throw new NotFoundError(
          result.notice ?? 'L’extension Stremio ne propose aucun fichier pour ce film.',
        );
      }
      return {
        videos: result.files.map((file) => ({
          name: file.fileName,
          path: file.path,
          isDirectory: false,
          size: file.size,
          modifiedAt: null,
        })),
        subtitles: [],
      };
    }
    let entries: RemoteEntry[];
    if (row.is_file) {
      const listing = await this.source
        .list(remoteParent(row.remote_path) ?? '/')
        .catch(() => null);
      const stem = stripExtension(row.folder_name).toLowerCase();
      const self = listing?.entries.find((entry) => entry.path === row.remote_path);
      entries = [
        self ?? {
          name: row.folder_name,
          path: row.remote_path,
          isDirectory: false,
          size: row.remote_size,
          modifiedAt: row.remote_modified_at,
        },
        ...(listing?.entries.filter(
          (entry) =>
            classifyFile(entry.name) === 'subtitle' && entry.name.toLowerCase().startsWith(stem),
        ) ?? []),
      ];
    } else {
      const listing = await this.source.list(row.remote_path);
      entries = listing.entries;
      if (!entries.some(isVideo)) {
        // Certaines releases sont rangées dans un sous-dossier supplémentaire.
        const nested = await mapWithConcurrency(
          entries.filter((entry) => entry.isDirectory).slice(0, 10),
          3,
          (dir) =>
            this.source
              .list(dir.path)
              .then((sub) => sub.entries)
              .catch(() => [] as RemoteEntry[]),
        );
        entries = [...entries, ...nested.flat()];
      }
    }
    return {
      videos: entries.filter(isVideo),
      subtitles: entries.filter(
        (entry) => !entry.isDirectory && classifyFile(entry.name) === 'subtitle',
      ),
    };
  }

  private async movieFiles(
    row: TitleRow,
  ): Promise<{ files: RemoteFile[]; subtitles: RemoteSubtitle[] }> {
    const { videos, subtitles } = await this.movieEntries(row);
    const availability = this.availability.forRemotePaths(videos.map((video) => video.path));
    return {
      files: [...videos]
        .sort(compareByQuality)
        .map((video) => toRemoteFile(video, availability.get(video.path))),
      subtitles: subtitles.map((subtitle) => ({
        name: subtitle.name,
        path: subtitle.path,
        language: guessSubtitleLanguage(subtitle.name),
      })),
    };
  }

  /** Structure distante d'une série (dossiers de saison explorés en parallèle). */
  async seriesStructure(row: TitleRow): Promise<GroupedSeason[]> {
    const root = await this.source.list(row.remote_path);
    const dirs = root.entries.filter((entry) => entry.isDirectory).slice(0, 80);
    const folders: FolderListing[] = await mapWithConcurrency(dirs, 4, async (dir) => {
      let entries = (await this.source.list(dir.path).catch(() => null))?.entries ?? [];
      if (!entries.some(isVideo)) {
        const nested = await mapWithConcurrency(
          entries.filter((entry) => entry.isDirectory).slice(0, 30),
          3,
          (sub) =>
            this.source
              .list(sub.path)
              .then((listing) => listing.entries)
              .catch(() => [] as RemoteEntry[]),
        );
        entries = [...entries, ...nested.flat()];
      }
      return { dir, entries };
    });
    return groupSeries(root.entries, folders);
  }

  private async seasons(row: TitleRow): Promise<SeasonEntry[]> {
    const structure = await this.seriesStructure(row);
    const paths = structure.flatMap((season) =>
      season.episodes.flatMap((episode) => episode.files.map((file) => file.path)),
    );
    const availability = this.availability.forRemotePaths(paths);
    const numbers = structure
      .map((season) => season.number)
      .filter((number): number is number => number !== null);
    const tmdbSeasons = new Map<number, TmdbSeason | null>();
    await mapWithConcurrency(numbers, 3, async (number) => {
      tmdbSeasons.set(number, await this.metadata.season(row, number));
    });

    return structure.map((season) => {
      const tmdb = season.number !== null ? tmdbSeasons.get(season.number) : null;
      return {
        key: season.key,
        number: season.number,
        name: season.name,
        path: season.path,
        posterUrl: imageUrl(tmdb?.poster_path, 'w342'),
        overview: tmdb?.overview?.trim() || null,
        episodes: season.episodes.map((episode) =>
          toEpisodeEntry(episode, tmdb ?? null, availability),
        ),
      };
    });
  }
}

function parseTried(row: TitleRow): string[] {
  try {
    const value = JSON.parse(row.source_note ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toRemoteFile(
  entry: RemoteEntry,
  availability: MediaAvailability | undefined,
  ref?: EpisodeRef,
): RemoteFile {
  return {
    name: entry.name,
    path: entry.path,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    release: parseRelease(entry.name).info,
    season: ref?.season ?? null,
    episode: ref?.episode ?? null,
    episodeEnd: ref?.episodeEnd ?? null,
    availability: availability ?? emptyAvailability(),
    label: null,
  };
}

function episodeFallbackTitle(episode: GroupedEpisode): string {
  if (episode.episode === null) return stripExtension(episode.files[0]?.name ?? 'Épisode');
  return episode.episodeEnd
    ? `Épisodes ${episode.episode}-${episode.episodeEnd}`
    : `Épisode ${episode.episode}`;
}

function toEpisodeEntry(
  episode: GroupedEpisode,
  tmdb: TmdbSeason | null,
  availability: Map<string, MediaAvailability>,
): EpisodeEntry {
  const info =
    episode.episode !== null
      ? tmdb?.episodes.find((item) => item.episode_number === episode.episode)
      : undefined;
  return {
    key: episode.key,
    season: episode.season,
    episode: episode.episode,
    episodeEnd: episode.episodeEnd,
    title: info?.name?.trim() || episodeFallbackTitle(episode),
    overview: info?.overview?.trim() || null,
    stillUrl: imageUrl(info?.still_path, 'w300'),
    airDate: info?.air_date ?? null,
    runtime: info?.runtime ?? null,
    files: [...episode.files]
      .sort(compareByQuality)
      .map((file) => toRemoteFile(file, availability.get(file.path), episode)),
  };
}
