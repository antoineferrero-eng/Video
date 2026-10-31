import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  DownloadItem,
  DownloadKind,
  DownloadList,
  DownloadStats,
  DownloadStatus,
  EnqueueResult,
} from '@lumiere/shared';
import { RateLimiter, sleep } from '../../core/async';
import { ConflictError, NotFoundError, errorMessage } from '../../core/errors';
import type { EventBus } from '../../core/event-bus';
import {
  ensureDir,
  fileSize,
  getDiskSpace,
  pathExists,
  sanitizeFileName,
  uniquePath,
} from '../../core/fs';
import type { Logger } from '../../core/logger';
import { formatBytes, formatEpisodeCode, prettifyTitle } from '../../core/text';
import { parseEpisode, parseSeasonFolder } from '../../domain/episode-parser';
import { pickPreferredFile } from '../../domain/file-selection';
import { classifyFile, isSampleFile } from '../../domain/media-files';
import { parseRelease } from '../../domain/release-parser';
import { isArchiveName } from '../archives/archive-entries';
import { entryDataOffset, extractEntry, fileReader, readZipEntries } from '../archives/zip';
import type { CatalogService } from '../catalog/catalog.service';
import { displayTitle, posterUrlFor } from '../catalog/presenters';
import type { TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { LibraryRow } from '../library/library.repository';
import type { LibraryService } from '../library/library.service';
import type { MetadataService } from '../metadata/metadata.service';
import type { SettingsService } from '../settings/settings.service';
import { normalizeRemotePath, remoteBaseName, remoteParent } from '../source/remote-path';
import type { SourceClient } from '../source/source-client';
import { parseVirtualPath, safeFileName } from '../source/stremio/virtual-path';
import type { DownloadRow, DownloadsRepository, NewDownload } from './downloads.repository';
import {
  EpisodeQueue,
  type BatchSummary,
  type EpisodeOutcome,
  type EpisodeTarget,
} from './episode-queue';
import { DownloadError, SegmentedTransfer, progressFile } from './segmented-transfer';
import { buildTargetPath } from './target-path';

const MAX_ATTEMPTS = 6;
const EMIT_INTERVAL_MS = 500;
const PERSIST_INTERVAL_MS = 3_000;
const SPEED_WINDOW_MS = 5_000;
const SAMPLE_INTERVAL_MS = 250;
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

interface ActiveDownload {
  id: number;
  controller: AbortController;
  stopReason: 'pause' | 'cancel' | 'shutdown' | null;
  downloaded: number;
  total: number | null;
  samples: Array<{ time: number; bytes: number }>;
  speed: number;
  lastEmit: number;
  lastPersist: number;
  lastDataAt: number;
  task: Promise<void>;
}

export interface EnqueueFile {
  path: string;
  titleId?: number | null;
  size?: number | null;
  /** Saison d'un épisode dont le nom ne la donne pas (saison cherchée sur un site). */
  season?: number | null;
}

/**
 * Moteur de téléchargement : file d'attente persistée en base, concurrence bornée,
 * reprise via les requêtes HTTP Range, nouvelles tentatives avec temporisation
 * exponentielle, limitation de débit globale et progression diffusée en temps réel.
 */
export class DownloadManager {
  private readonly active = new Map<number, ActiveDownload>();
  private readonly limiter = new RateLimiter();
  private statsTimer: NodeJS.Timeout | null = null;
  private lastStatsActive = -1;
  private stopping = false;
  /** Épisodes à demander aux extensions Stremio avant de les ajouter à la file. */
  private readonly episodes: EpisodeQueue;

  constructor(
    private readonly repository: DownloadsRepository,
    private readonly source: SourceClient,
    private readonly library: LibraryService,
    private readonly catalog: CatalogService,
    private readonly titles: TitlesRepository,
    private readonly metadata: MetadataService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {
    this.episodes = new EpisodeQueue(
      (titleId, target) => this.addAddonEpisode(titleId, target),
      (summary) => this.reportEpisodes(summary),
      logger,
    );
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  start(): void {
    const resumed = this.repository.resetInterrupted();
    if (resumed > 0) this.logger.info({ resumed }, 'Reprise des téléchargements interrompus');
    this.applySpeedLimit();
    this.settings.onChange((next, previous) => {
      if (next.maxDownloadSpeedKbps !== previous.maxDownloadSpeedKbps) this.applySpeedLimit();
      if (next.maxConcurrentDownloads !== previous.maxConcurrentDownloads) this.schedule();
    });
    this.statsTimer = setInterval(() => this.publishStats(), 1000);
    this.statsTimer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.episodes.stop();
    if (this.statsTimer) clearInterval(this.statsTimer);
    const tasks = [...this.active.values()].map((state) => {
      state.stopReason = 'shutdown';
      state.controller.abort();
      return state.task;
    });
    await Promise.race([Promise.allSettled(tasks), sleep(5000)]);
  }

  private applySpeedLimit(): void {
    this.limiter.setLimit(this.settings.get().maxDownloadSpeedKbps * 1024);
  }

  // -------------------------------------------------------------------------
  // Consultation
  // -------------------------------------------------------------------------

  list(): DownloadList {
    return { items: this.toItems(this.repository.list()), stats: this.stats() };
  }

  get(id: number): DownloadItem {
    return this.toItems([this.require(id)])[0] as DownloadItem;
  }

  stats(): DownloadStats {
    const counts = this.repository.countByStatus();
    let speed = 0;
    for (const state of this.active.values()) speed += state.speed;
    return {
      active: counts.downloading,
      queued: counts.queued,
      paused: counts.paused,
      failed: counts.failed,
      completed: counts.completed,
      speed: Math.round(speed),
    };
  }

  private require(id: number): DownloadRow {
    const row = this.repository.findById(id);
    if (!row) throw new NotFoundError('Téléchargement introuvable.');
    return row;
  }

  private toItems(rows: DownloadRow[]): DownloadItem[] {
    const ids = [
      ...new Set(rows.map((row) => row.title_id).filter((id): id is number => id !== null)),
    ];
    const titles = new Map(this.titles.findByIds(ids).map((title) => [title.id, title]));
    const enabled = this.metadata.isEnabled();
    return rows.map((row) => {
      const live = this.active.get(row.id);
      const downloaded = live?.downloaded ?? row.downloaded_bytes;
      const total = live?.total ?? row.total_bytes;
      const speed = live && row.status === 'downloading' ? Math.round(live.speed) : 0;
      const title = row.title_id !== null ? titles.get(row.title_id) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        titleId: row.title_id,
        title: row.title,
        subtitle: row.subtitle,
        season: row.season,
        episode: row.episode,
        fileName: row.file_name,
        remotePath: row.remote_path,
        targetPath: row.target_path,
        totalBytes: total,
        downloadedBytes: downloaded,
        speed,
        eta: speed > 0 && total ? Math.max(0, Math.round((total - downloaded) / speed)) : null,
        error: row.error,
        attempts: row.attempts,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        posterUrl: title ? posterUrlFor(title, enabled) : null,
        libraryItemId: row.library_item_id,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Ajout à la file
  // -------------------------------------------------------------------------

  enqueueFiles(files: EnqueueFile[]): EnqueueResult {
    const created: DownloadRow[] = [];
    const skipped: EnqueueResult['skipped'] = [];
    for (const file of files) {
      try {
        const remotePath = normalizeRemotePath(file.path);
        if (remotePath.endsWith('/')) {
          skipped.push({ path: file.path, reason: 'Un dossier ne peut pas être ajouté tel quel.' });
          continue;
        }
        if (this.repository.findActiveByRemotePath(remotePath)) {
          skipped.push({ path: file.path, reason: 'Déjà dans la file de téléchargement.' });
          continue;
        }
        if (this.library.findByRemotePath(remotePath)) {
          skipped.push({ path: file.path, reason: 'Déjà présent dans la bibliothèque.' });
          continue;
        }
        const title = file.titleId
          ? this.titles.findById(file.titleId)
          : this.titles.findContaining(remotePath);
        created.push(
          this.repository.insert(
            this.describe(remotePath, file.size ?? null, title, file.season ?? null),
          ),
        );
      } catch (error) {
        skipped.push({ path: file.path, reason: errorMessage(error) });
      }
    }
    for (const row of created) this.emit(row.id);
    this.schedule();
    return { created: this.toItems(created), skipped };
  }

  /**
   * Film : meilleure version selon les préférences. Série : un fichier par épisode (toute la
   * série, une saison, ou un épisode).
   */
  async enqueueTitle(
    titleId: number,
    season?: number | null,
    episode?: number | null,
  ): Promise<EnqueueResult> {
    const row = this.catalog.getRow(titleId);
    const { preferredQuality, preferredAudioLanguage } = this.settings.get();
    if (row.kind === 'movie') {
      const files = await this.catalog.movieFiles(row);
      const best = pickPreferredFile(
        files.map((file) => ({ name: file.fileName, path: file.path, size: file.size })),
        preferredQuality,
        preferredAudioLanguage,
      );
      if (!best) throw new NotFoundError('Aucun fichier vidéo pour ce film.');
      return this.enqueueFiles([{ path: best.path, size: best.size, titleId }]);
    }
    return this.enqueueAddonEpisodes(row, season ?? null, episode ?? null);
  }

  // -------------------------------------------------------------------------
  // Épisodes fournis par les extensions Stremio
  // -------------------------------------------------------------------------

  /**
   * Épisodes d'une série : un épisode est demandé tout de suite ; une saison ou une série
   * entière part dans la file des demandes (une à la fois, en arrière-plan), sans redemander
   * les épisodes déjà téléchargés.
   */
  private async enqueueAddonEpisodes(
    row: TitleRow,
    season: number | null,
    episode: number | null,
  ): Promise<EnqueueResult> {
    const outline = await this.catalog.episodeOutline(row.id);
    const targets: EpisodeTarget[] = outline
      .filter((item) => season === null || item.number === season)
      .flatMap((item) => item.episodes)
      .filter((item) => episode === null || item.episode === episode)
      .map((item) => ({ season: item.season, episode: item.episode }));
    if (targets.length === 0) throw new NotFoundError('Aucun épisode trouvé.');

    if (episode !== null) {
      const target = targets[0] as EpisodeTarget;
      const picked = await this.pickAddonEpisode(row.id, target);
      if ('reason' in picked) {
        return { created: [], skipped: [{ path: episodeCode(target), reason: picked.reason }] };
      }
      return this.enqueueFiles([picked.file]);
    }

    const skipped: EnqueueResult['skipped'] = [];
    const wanted: EpisodeTarget[] = [];
    for (const target of targets) {
      if (await this.hasEpisodeCopy(row.id, target)) {
        skipped.push({ path: episodeCode(target), reason: 'Épisode déjà téléchargé ou en file.' });
      } else {
        wanted.push(target);
      }
    }
    const label = season === null ? displayTitle(row) : `${displayTitle(row)} · saison ${season}`;
    const pending = this.episodes.add(row.id, label, wanted);
    if (wanted.length > 0 && pending === 0) {
      skipped.push({ path: label, reason: 'Ces épisodes sont déjà en cours d’ajout.' });
    }
    return { created: [], skipped, pending };
  }

  private async hasEpisodeCopy(titleId: number, target: EpisodeTarget): Promise<boolean> {
    if (this.library.findEpisode(titleId, target.season, target.episode)) return true;
    const copies = await this.catalog.episodeCopies(titleId, target.season, target.episode);
    return copies.length > 0;
  }

  /** Version préférée d'un épisode parmi celles que proposent les extensions (une demande). */
  private async pickAddonEpisode(
    titleId: number,
    target: EpisodeTarget,
  ): Promise<{ file: EnqueueFile; limited: boolean } | { reason: string; limited: boolean }> {
    if (await this.hasEpisodeCopy(titleId, target))
      return { reason: 'Épisode déjà téléchargé ou en file.', limited: false };
    const { files, notice, limited } = await this.catalog.episodeFiles(
      titleId,
      target.season,
      target.episode,
    );
    const { preferredQuality, preferredAudioLanguage } = this.settings.get();
    const best = pickPreferredFile(files, preferredQuality, preferredAudioLanguage);
    if (!best) {
      return {
        reason: notice ?? 'Aucune extension Stremio ne propose de fichier pour cet épisode.',
        limited,
      };
    }
    return { file: { path: best.path, size: best.size, titleId }, limited };
  }

  private async addAddonEpisode(titleId: number, target: EpisodeTarget): Promise<EpisodeOutcome> {
    const picked = await this.pickAddonEpisode(titleId, target);
    if ('reason' in picked)
      return { status: 'skipped', reason: picked.reason, limited: picked.limited };
    const result = this.enqueueFiles([picked.file]);
    if (result.created.length === 0) {
      return {
        status: 'skipped',
        reason: result.skipped[0]?.reason ?? 'Épisode ignoré.',
        limited: picked.limited,
      };
    }
    return { status: 'added', limited: picked.limited };
  }

  private reportEpisodes({ label, added, skipped, abandoned }: BatchSummary): void {
    const details: string[] = [];
    if (abandoned > 0) {
      details.push(
        `${abandoned} épisode${abandoned > 1 ? 's' : ''} non demandé${abandoned > 1 ? 's' : ''} : l’extension a atteint sa limite de liens, relancez le téléchargement plus tard.`,
      );
    }
    if (skipped.length > 0) {
      const codes = skipped.map((item) => item.code);
      details.push(
        `${codes.slice(0, 6).join(', ')}${codes.length > 6 ? '…' : ''} : ${skipped[0]?.reason ?? ''}`,
      );
    }
    this.events.publish({
      type: 'downloads.notice',
      level: added === 0 ? 'warning' : skipped.length > 0 || abandoned > 0 ? 'info' : 'success',
      message:
        added === 0
          ? `${label} : aucun épisode ajouté`
          : `${label} : ${added} épisode${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''} aux téléchargements`,
      description: details.join(' ') || null,
    });
  }

  private describe(
    remotePath: string,
    size: number | null,
    title: TitleRow | undefined,
    seasonHint: number | null = null,
  ): NewDownload {
    const fileName = remoteBaseName(remotePath);
    const release = parseRelease(fileName);
    const kind: DownloadKind =
      title?.kind === 'series' ? 'episode' : title?.kind === 'movie' ? 'movie' : 'file';
    const parentFolder = remoteBaseName(remoteParent(remotePath) ?? '');
    let ref = parseEpisode(fileName, parseSeasonFolder(parentFolder) ?? seasonHint);
    if (ref.season === null && seasonHint !== null) ref = { ...ref, season: seasonHint };
    const virtual = parseVirtualPath(remotePath);
    if (virtual?.season != null && virtual.episode != null) {
      // Fichier d'extension : l'épisode demandé fait foi (le nom du fichier peut être muet).
      const sameEpisode = ref.season === virtual.season && ref.episode === virtual.episode;
      ref = {
        season: virtual.season,
        episode: virtual.episode,
        episodeEnd: sameEpisode ? ref.episodeEnd : null,
      };
    }
    const isEpisode = kind === 'episode';
    const code = isEpisode ? formatEpisodeCode(ref.season, ref.episode, ref.episodeEnd) : null;
    const quality = [release.info.resolution, release.info.source].filter(Boolean).join(' ');
    const subtitle = [code, quality || null, release.info.languages.join(' ') || null]
      .filter(Boolean)
      .join(' · ');
    const titleFolder = title
      ? title.is_file
        ? `${title.parsed_title}${title.year ? ` (${title.year})` : ''}`
        : title.folder_name
      : null;
    return {
      kind,
      title_id: title?.id ?? null,
      title: title ? displayTitle(title) : prettifyTitle(release.title || fileName),
      subtitle: subtitle || null,
      season: isEpisode ? ref.season : null,
      episode: isEpisode ? ref.episode : null,
      year: title?.year ?? release.year,
      remote_path: remotePath,
      file_name: fileName,
      target_path: buildTargetPath(this.settings.get().downloadDir, {
        kind,
        remotePath,
        fileName,
        titleFolder,
        season: ref.season,
      }),
      total_bytes: size,
    };
  }

  // -------------------------------------------------------------------------
  // Contrôles
  // -------------------------------------------------------------------------

  pause(id: number): DownloadItem {
    const row = this.require(id);
    if (row.status === 'downloading') {
      const state = this.active.get(id);
      if (state) {
        state.stopReason = 'pause';
        state.controller.abort();
      }
      this.setStatus(id, 'paused');
    } else if (row.status === 'queued') {
      this.setStatus(id, 'paused');
    } else if (row.status !== 'paused') {
      throw new ConflictError('Ce téléchargement ne peut pas être mis en pause.');
    }
    return this.get(id);
  }

  resume(id: number): DownloadItem {
    const row = this.require(id);
    if (row.status === 'completed' || row.status === 'downloading' || row.status === 'queued')
      return this.get(id);
    this.repository.update(id, {
      status: 'queued',
      error: null,
      ...(row.status === 'paused' ? {} : { attempts: 0 }),
    });
    this.emit(id);
    this.schedule();
    return this.get(id);
  }

  async cancel(id: number): Promise<DownloadItem> {
    const row = this.require(id);
    if (row.status === 'completed') throw new ConflictError('Ce téléchargement est déjà terminé.');
    const state = this.active.get(id);
    if (state) {
      state.stopReason = 'cancel';
      state.controller.abort();
      await state.task;
    } else {
      await removePart(row.target_path);
      this.repository.update(id, {
        status: 'canceled',
        downloaded_bytes: 0,
        completed_at: new Date().toISOString(),
      });
      this.emit(id);
    }
    return this.get(id);
  }

  async remove(id: number, deleteFile: boolean): Promise<void> {
    const row = this.require(id);
    const state = this.active.get(id);
    if (state) {
      state.stopReason = 'cancel';
      state.controller.abort();
      await state.task;
    }
    if (row.status === 'completed') {
      if (deleteFile && row.library_item_id !== null) {
        await this.library.remove(row.library_item_id, true).catch(() => undefined);
      }
    } else {
      await removePart(row.target_path);
    }
    this.repository.delete(id);
    this.events.publish({ type: 'download.removed', id });
    this.publishStats(true);
  }

  pauseAll(): void {
    for (const id of this.repository.idsByStatus(['queued', 'downloading'])) this.pause(id);
  }

  resumeAll(): void {
    for (const id of this.repository.idsByStatus(['paused', 'failed'])) this.resume(id);
  }

  clearFinished(): number {
    const ids = this.repository.idsByStatus(['completed', 'canceled']);
    this.repository.deleteFinished();
    for (const id of ids) this.events.publish({ type: 'download.removed', id });
    this.publishStats(true);
    return ids.length;
  }

  private setStatus(id: number, status: DownloadStatus): void {
    this.repository.update(id, { status });
    this.emit(id);
  }

  // -------------------------------------------------------------------------
  // Exécution
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopping) return;
    const max = this.settings.get().maxConcurrentDownloads;
    while (this.active.size < max) {
      const next = this.repository.nextQueued([...this.active.keys()]);
      if (!next) break;
      this.startTask(next);
    }
  }

  private startTask(row: DownloadRow): void {
    const now = Date.now();
    const state: ActiveDownload = {
      id: row.id,
      controller: new AbortController(),
      stopReason: null,
      downloaded: row.downloaded_bytes,
      total: row.total_bytes,
      samples: [],
      speed: 0,
      lastEmit: 0,
      lastPersist: now,
      lastDataAt: now,
      task: Promise.resolve(),
    };
    this.active.set(row.id, state);
    this.repository.update(row.id, {
      status: 'downloading',
      started_at: row.started_at ?? new Date().toISOString(),
      error: null,
    });
    this.emit(row.id);
    state.task = this.run(state)
      .catch((error) =>
        this.logger.error(
          { id: row.id, err: errorMessage(error) },
          'Erreur inattendue du téléchargement',
        ),
      )
      .finally(() => {
        this.active.delete(row.id);
        this.emit(row.id);
        this.publishStats(true);
        this.schedule();
      });
  }

  private async run(state: ActiveDownload): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.transfer(state);
        await this.finalize(state);
        return;
      } catch (error) {
        if (state.controller.signal.aborted) {
          await this.handleStop(state);
          return;
        }
        attempt += 1;
        const row = this.repository.findById(state.id);
        if (!row) return;
        const message = errorMessage(error);
        const retryable = !(error instanceof DownloadError) || error.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          this.repository.update(state.id, {
            status: 'failed',
            error: message,
            attempts: row.attempts + 1,
            downloaded_bytes: state.downloaded,
            total_bytes: state.total,
          });
          this.logger.warn(
            { id: state.id, file: row.file_name, err: message },
            'Téléchargement en échec',
          );
          return;
        }
        this.repository.update(state.id, {
          error: `${message} — nouvelle tentative (${attempt}/${MAX_ATTEMPTS - 1})…`,
          attempts: row.attempts + 1,
        });
        this.emit(state.id);
        try {
          await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)), state.controller.signal);
        } catch {
          await this.handleStop(state);
          return;
        }
      }
    }
  }

  private async handleStop(state: ActiveDownload): Promise<void> {
    const row = this.repository.findById(state.id);
    if (!row) return;
    const reason = state.stopReason ?? 'pause';
    state.speed = 0;
    if (reason === 'cancel') {
      await removePart(row.target_path);
      this.repository.update(state.id, {
        status: 'canceled',
        downloaded_bytes: 0,
        error: null,
        completed_at: new Date().toISOString(),
      });
      state.downloaded = 0;
    } else {
      // Une reprise demandée pendant l'arrêt (pause puis reprise rapide) a priorité.
      const status: DownloadStatus =
        reason === 'pause' && row.status !== 'queued' ? 'paused' : 'queued';
      this.repository.update(state.id, {
        status,
        downloaded_bytes: state.downloaded,
        total_bytes: state.total,
      });
    }
  }

  /**
   * Télécharge vers le `.part` : en plusieurs morceaux simultanés quand l'hôte l'accepte et
   * que cela accélère (voir SegmentedTransfer), en reprenant ce qui est déjà reçu.
   */
  private async transfer(state: ActiveDownload): Promise<void> {
    const row = this.repository.findById(state.id);
    if (!row) throw new DownloadError('Téléchargement supprimé.', false);
    const partPath = `${row.target_path}.part`;
    await ensureDir(path.dirname(partPath));

    const transfer = new SegmentedTransfer({
      partPath,
      expectedTotal: row.total_bytes,
      signal: state.controller.signal,
      logger: this.logger,
      open: (start, end, signal, extra) =>
        this.source.openFile(row.remote_path, {
          start,
          end: end === null ? undefined : end - 1,
          signal,
          refreshLinks: !extra,
        }),
      remoteSize: async (signal) => {
        const head = await this.source.openFile(row.remote_path, { method: 'HEAD', signal });
        await head.body?.cancel().catch(() => undefined);
        return Number(head.headers.get('content-length')) || null;
      },
      throttle: (bytes, signal) => this.limiter.consume(bytes, signal),
      onTotal: async (total, remaining) => {
        state.total = total;
        this.repository.update(state.id, {
          total_bytes: total,
          downloaded_bytes: state.downloaded,
        });
        const disk = await getDiskSpace(path.dirname(partPath));
        if (disk && disk.free < remaining + DISK_MARGIN_BYTES) {
          throw new DownloadError(
            `Espace disque insuffisant (${formatBytes(remaining)} nécessaires).`,
            false,
          );
        }
      },
      onProgress: (downloaded, total) => {
        state.downloaded = downloaded;
        state.total = total;
        state.lastDataAt = Date.now();
        this.onProgress(state);
      },
    });
    try {
      const result = await transfer.run();
      state.downloaded = result.downloaded;
      state.total = result.total ?? result.downloaded;
    } finally {
      this.repository.saveProgress(state.id, state.downloaded, state.total);
    }
  }

  private async finalize(state: ActiveDownload): Promise<void> {
    const row = this.repository.findById(state.id);
    if (!row) return;
    const partPath = `${row.target_path}.part`;
    let finalPath = row.target_path;
    if (await pathExists(finalPath)) finalPath = await uniquePath(finalPath);
    await fsp.rename(partPath, finalPath);
    const size = (await fileSize(finalPath)) ?? state.downloaded;

    // Archive zip (saison complète…) : ses vidéos rejoignent la bibliothèque, l'archive part.
    let archiveError: string | null = null;
    if (isArchiveName(finalPath)) {
      try {
        const extracted = await this.extractArchive(row, finalPath, state.controller.signal);
        if (extracted.length > 0) {
          this.repository.update(state.id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            downloaded_bytes: size,
            total_bytes: size,
            target_path: extracted[0]?.file_path ?? finalPath,
            error: null,
            library_item_id: extracted[0]?.id ?? null,
          });
          state.downloaded = size;
          state.total = size;
          state.speed = 0;
          return;
        }
        archiveError = 'Archive sans vidéo : gardée telle quelle.';
      } catch (error) {
        if (state.controller.signal.aborted) throw error;
        archiveError = `Archive gardée telle quelle : ${errorMessage(error)}`;
        this.logger.warn({ id: state.id, err: errorMessage(error) }, 'Décompression impossible');
      }
    }

    const libraryRow = this.library.add({
      kind: row.kind === 'file' ? 'other' : row.kind,
      title_id: row.title_id,
      title: row.title,
      season: row.season,
      episode: row.episode,
      year: row.year,
      file_path: finalPath,
      file_name: path.basename(finalPath),
      size_bytes: size,
      remote_path: row.remote_path,
    });
    this.repository.update(state.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      downloaded_bytes: size,
      total_bytes: size,
      target_path: finalPath,
      error: archiveError,
      library_item_id: libraryRow.id,
    });
    state.downloaded = size;
    state.total = size;
    state.speed = 0;
    this.logger.info(
      { id: state.id, file: path.basename(finalPath), size },
      'Téléchargement terminé',
    );
  }

  /**
   * Décompresse une archive zip téléchargée à côté d'elle : vidéos ajoutées à la bibliothèque
   * (épisode lu dans leur nom, saison du téléchargement à défaut), sous-titres gardés à côté.
   * L'archive est supprimée une fois ses vidéos extraites.
   */
  private async extractArchive(
    row: DownloadRow,
    archive: string,
    signal: AbortSignal,
  ): Promise<LibraryRow[]> {
    const handle = await fsp.open(archive, 'r');
    const read = fileReader(handle);
    let entries: Array<{ entry: Awaited<ReturnType<typeof readZipEntries>>[number]; data: number }>;
    try {
      const listed = (await readZipEntries(read, (await handle.stat()).size)).filter(
        (entry) => classifyFile(entry.name) !== 'other' && !isSampleFile(entry.name),
      );
      entries = [];
      for (const entry of listed) entries.push({ entry, data: await entryDataOffset(read, entry) });
    } finally {
      await handle.close();
    }

    const folder = path.dirname(archive);
    const added: LibraryRow[] = [];
    for (const { entry, data } of entries) {
      const base = path.posix.basename(entry.name);
      const target = await uniquePath(path.join(folder, sanitizeFileName(base, 'video')));
      await extractEntry(archive, entry, data, target, signal);
      if (classifyFile(base) !== 'video') continue;
      const ref = parseEpisode(base, row.season);
      const isEpisode = row.kind === 'episode';
      added.push(
        this.library.add({
          kind: row.kind === 'file' ? 'other' : row.kind,
          title_id: row.title_id,
          title: row.title,
          season: isEpisode ? (ref.season ?? row.season) : null,
          episode: isEpisode ? ref.episode : null,
          year: row.year,
          file_path: target,
          file_name: path.basename(target),
          size_bytes: entry.size,
          remote_path: `${row.remote_path}/${safeFileName(base)}`,
        }),
      );
    }
    if (added.length > 0) {
      await fsp.rm(archive, { force: true });
      this.events.publish({
        type: 'downloads.notice',
        level: 'success',
        message: `${row.title} : ${added.length} vidéo${added.length > 1 ? 's' : ''} décompressée${added.length > 1 ? 's' : ''}`,
        description: row.file_name,
      });
    }
    this.logger.info({ id: row.id, videos: added.length }, 'Archive décompressée');
    return added;
  }

  // -------------------------------------------------------------------------
  // Progression et événements
  // -------------------------------------------------------------------------

  private onProgress(state: ActiveDownload): void {
    const now = Date.now();
    const lastSample = state.samples.at(-1);
    if (!lastSample || now - lastSample.time >= SAMPLE_INTERVAL_MS) {
      state.samples.push({ time: now, bytes: state.downloaded });
      while (state.samples.length > 2 && now - (state.samples[0]?.time ?? now) > SPEED_WINDOW_MS) {
        state.samples.shift();
      }
      const first = state.samples[0];
      if (first) {
        const elapsed = (now - first.time) / 1000;
        if (elapsed >= 0.5) state.speed = (state.downloaded - first.bytes) / elapsed;
      }
    }
    if (now - state.lastEmit >= EMIT_INTERVAL_MS) {
      state.lastEmit = now;
      this.emit(state.id);
    }
    if (now - state.lastPersist >= PERSIST_INTERVAL_MS) {
      state.lastPersist = now;
      this.repository.saveProgress(state.id, state.downloaded, state.total);
    }
  }

  private emit(id: number): void {
    const row = this.repository.findById(id);
    if (!row) return;
    const [item] = this.toItems([row]);
    if (item) this.events.publish({ type: 'download.updated', download: item });
  }

  private publishStats(force = false): void {
    const now = Date.now();
    for (const state of this.active.values()) {
      if (now - state.lastDataAt > 3000) state.speed = 0;
    }
    if (!force && this.active.size === 0 && this.lastStatsActive === 0) return;
    this.lastStatsActive = this.active.size;
    this.events.publish({ type: 'downloads.stats', stats: this.stats() });
  }
}

function episodeCode(target: EpisodeTarget): string {
  return formatEpisodeCode(target.season, target.episode) ?? `${target.episode}`;
}

/** Supprime un téléchargement inachevé : le `.part` et le suivi de ses morceaux. */
async function removePart(targetPath: string): Promise<void> {
  const partPath = `${targetPath}.part`;
  await fsp.rm(partPath, { force: true });
  await fsp.rm(progressFile(partPath), { force: true });
}
