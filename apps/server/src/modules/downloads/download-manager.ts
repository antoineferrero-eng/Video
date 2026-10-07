import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
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
import { ensureDir, fileSize, getDiskSpace, pathExists, uniquePath } from '../../core/fs';
import { parseContentRangeStart, parseContentRangeTotal } from '../../core/http-range';
import type { Logger } from '../../core/logger';
import { formatBytes, formatEpisodeCode, prettifyTitle } from '../../core/text';
import { parseEpisode, parseSeasonFolder } from '../../domain/episode-parser';
import { pickPreferredFile } from '../../domain/file-selection';
import { parseRelease } from '../../domain/release-parser';
import type { CatalogService } from '../catalog/catalog.service';
import { displayTitle, posterUrlFor } from '../catalog/presenters';
import type { TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { ExplorerService } from '../explorer/explorer.service';
import type { LibraryService } from '../library/library.service';
import type { MetadataService } from '../metadata/metadata.service';
import type { SettingsService } from '../settings/settings.service';
import { normalizeRemotePath, remoteBaseName, remoteParent } from '../source/remote-path';
import type { SourceClient } from '../source/source-client';
import type { DownloadRow, DownloadsRepository, NewDownload } from './downloads.repository';
import { buildTargetPath } from './target-path';

const MAX_ATTEMPTS = 6;
const STALL_TIMEOUT_MS = 60_000;
const EMIT_INTERVAL_MS = 500;
const PERSIST_INTERVAL_MS = 3_000;
const SPEED_WINDOW_MS = 5_000;
const SAMPLE_INTERVAL_MS = 250;
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** Erreur de transfert, avec indication de reprise possible. */
class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

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

  constructor(
    private readonly repository: DownloadsRepository,
    private readonly source: SourceClient,
    private readonly library: LibraryService,
    private readonly catalog: CatalogService,
    private readonly titles: TitlesRepository,
    private readonly explorer: ExplorerService,
    private readonly metadata: MetadataService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

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
        created.push(this.repository.insert(this.describe(remotePath, file.size ?? null, title)));
      } catch (error) {
        skipped.push({ path: file.path, reason: errorMessage(error) });
      }
    }
    for (const row of created) this.emit(row.id);
    this.schedule();
    return { created: this.toItems(created), skipped };
  }

  /** Film : meilleure version selon les préférences. Série : un fichier par épisode. */
  async enqueueTitle(titleId: number, season?: number | null): Promise<EnqueueResult> {
    const row = this.catalog.getRow(titleId);
    const { preferredQuality, preferredAudioLanguage } = this.settings.get();
    if (row.kind === 'movie') {
      const { videos } = await this.catalog.movieEntries(row);
      const best = pickPreferredFile(videos, preferredQuality, preferredAudioLanguage);
      if (!best) throw new NotFoundError('Aucun fichier vidéo pour ce film.');
      return this.enqueueFiles([{ path: best.path, size: best.size, titleId }]);
    }
    const structure = await this.catalog.seriesStructure(row);
    const seasons =
      season === undefined || season === null
        ? structure
        : structure.filter((item) => item.number === season);
    const files = seasons
      .flatMap((item) =>
        item.episodes.map((episode) =>
          pickPreferredFile(episode.files, preferredQuality, preferredAudioLanguage),
        ),
      )
      .filter((file): file is NonNullable<typeof file> => file !== null);
    if (files.length === 0) throw new NotFoundError('Aucun épisode trouvé.');
    return this.enqueueFiles(files.map((file) => ({ path: file.path, size: file.size, titleId })));
  }

  async enqueueFolder(folderPath: string): Promise<EnqueueResult> {
    const videos = await this.explorer.collectVideos(folderPath);
    if (videos.length === 0) throw new NotFoundError('Aucune vidéo trouvée dans ce dossier.');
    return this.enqueueFiles(videos.map((video) => ({ path: video.path, size: video.size })));
  }

  private describe(
    remotePath: string,
    size: number | null,
    title: TitleRow | undefined,
  ): NewDownload {
    const fileName = remoteBaseName(remotePath);
    const release = parseRelease(fileName);
    const kind: DownloadKind =
      title?.kind === 'series' ? 'episode' : title?.kind === 'movie' ? 'movie' : 'file';
    const parentFolder = remoteBaseName(remoteParent(remotePath) ?? '');
    const ref = parseEpisode(fileName, parseSeasonFolder(parentFolder));
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
      await fsp.rm(`${row.target_path}.part`, { force: true });
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
      await fsp.rm(`${row.target_path}.part`, { force: true });
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
      await fsp.rm(`${row.target_path}.part`, { force: true });
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

  private async transfer(state: ActiveDownload): Promise<void> {
    const row = this.repository.findById(state.id);
    if (!row) throw new DownloadError('Téléchargement supprimé.', false);
    const partPath = `${row.target_path}.part`;
    await ensureDir(path.dirname(partPath));

    let offset = (await fileSize(partPath)) ?? 0;
    if (row.total_bytes !== null && offset > row.total_bytes) {
      await fsp.truncate(partPath, 0);
      offset = 0;
    }
    state.downloaded = offset;
    if (row.total_bytes !== null && row.total_bytes > 0 && offset === row.total_bytes) return;

    const attempt = new AbortController();
    const signal = AbortSignal.any([state.controller.signal, attempt.signal]);
    const response = await this.source.openFile(row.remote_path, {
      start: offset > 0 ? offset : undefined,
      signal,
    });

    if (response.status === 416 && offset > 0) {
      await response.body?.cancel().catch(() => undefined);
      const head = await this.source.openFile(row.remote_path, { method: 'HEAD', signal });
      const remoteSize = Number(head.headers.get('content-length')) || null;
      if (remoteSize !== null && offset >= remoteSize) {
        if (offset > remoteSize) await fsp.truncate(partPath, remoteSize);
        state.downloaded = remoteSize;
        state.total = remoteSize;
        return;
      }
      await fsp.truncate(partPath, 0);
      throw new DownloadError('Reprise impossible : redémarrage depuis le début.', true);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404)
        throw new DownloadError('Fichier introuvable sur la source (404).', false);
      throw new DownloadError(
        `La source a répondu ${response.status}.`,
        response.status >= 500 || [403, 408, 425, 429].includes(response.status) || response.ok,
      );
    }

    let append = false;
    if (offset > 0) {
      if (
        response.status === 206 &&
        parseContentRangeStart(response.headers.get('content-range')) === offset
      ) {
        append = true;
      } else {
        // Le serveur a ignoré la plage demandée : on repart de zéro.
        offset = 0;
        state.downloaded = 0;
      }
    }
    const contentLength = Number(response.headers.get('content-length')) || null;
    const total =
      response.status === 206
        ? (parseContentRangeTotal(response.headers.get('content-range')) ??
          (contentLength !== null ? offset + contentLength : null))
        : contentLength;
    state.total = total;
    this.repository.update(state.id, { total_bytes: total, downloaded_bytes: offset });

    if (total !== null) {
      const disk = await getDiskSpace(path.dirname(partPath));
      if (disk && disk.free < total - offset + DISK_MARGIN_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new DownloadError(
          `Espace disque insuffisant (${formatBytes(total - offset)} nécessaires).`,
          false,
        );
      }
    }

    state.lastDataAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - state.lastDataAt > STALL_TIMEOUT_MS) {
        attempt.abort(
          new DownloadError('Transfert bloqué (aucune donnée reçue depuis 60 s).', true),
        );
      }
    }, 5_000);
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.limiter.consume(chunk.length, signal).then(
          () => {
            state.downloaded += chunk.length;
            state.lastDataAt = Date.now();
            this.onProgress(state);
            callback(null, chunk);
          },
          (error: unknown) => callback(error as Error),
        );
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        meter,
        fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
        { signal },
      );
    } catch (error) {
      if (attempt.signal.aborted && !state.controller.signal.aborted) throw attempt.signal.reason;
      throw error;
    } finally {
      clearInterval(watchdog);
      this.repository.saveProgress(state.id, state.downloaded, state.total);
    }

    if (state.total !== null && state.downloaded < state.total) {
      throw new DownloadError('Transfert incomplet, reprise…', true);
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
      error: null,
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
