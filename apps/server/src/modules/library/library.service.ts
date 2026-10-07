import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { LibraryItem, LibraryKind, LibraryScanResult } from '@lumiere/shared';
import { NotFoundError } from '../../core/errors';
import type { EventBus } from '../../core/event-bus';
import { isPathInside, removeEmptyParents } from '../../core/fs';
import type { Logger } from '../../core/logger';
import { prettifyTitle } from '../../core/text';
import { parseEpisode, parseSeasonFolder } from '../../domain/episode-parser';
import { classifyFile, isSampleFile } from '../../domain/media-files';
import { parseRelease } from '../../domain/release-parser';
import { parseFolderTitle } from '../../domain/title-parser';
import {
  mediaKeyForFile,
  mediaKeyForRemote,
  type AvailabilityService,
} from '../availability/availability.service';
import { backdropUrlFor, displayTitle, posterUrlFor } from '../catalog/presenters';
import type { TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { MetadataService } from '../metadata/metadata.service';
import type { SettingsService } from '../settings/settings.service';
import type { LibraryRepository, LibraryRow, NewLibraryItem } from './library.repository';

export const MOVIES_DIR = 'Films';
export const SERIES_DIR = 'Séries';
export const OTHER_DIR = 'Autres';

export function mediaKeyForLibraryRow(row: Pick<LibraryRow, 'remote_path' | 'file_path'>): string {
  return row.remote_path ? mediaKeyForRemote(row.remote_path) : mediaKeyForFile(row.file_path);
}

/** Fichiers téléchargés (ou déposés) dans le dossier de la bibliothèque. */
export class LibraryService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly titles: TitlesRepository,
    private readonly metadata: MetadataService,
    private readonly availability: AvailabilityService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  list(): LibraryItem[] {
    const rows = this.repository.list();
    const titleIds = [
      ...new Set(rows.map((row) => row.title_id).filter((id): id is number => id !== null)),
    ];
    const titles = new Map(this.titles.findByIds(titleIds).map((title) => [title.id, title]));
    return rows.map((row) =>
      this.toItem(row, row.title_id !== null ? titles.get(row.title_id) : undefined),
    );
  }

  get(id: number): LibraryItem {
    const row = this.getRow(id);
    return this.toItem(row, row.title_id !== null ? this.titles.findById(row.title_id) : undefined);
  }

  getRow(id: number): LibraryRow {
    const row = this.repository.findById(id);
    if (!row) throw new NotFoundError('Élément de bibliothèque introuvable.');
    return row;
  }

  findRow(id: number): LibraryRow | undefined {
    return this.repository.findById(id);
  }

  findByRemotePath(remotePath: string): LibraryRow | undefined {
    return this.repository.findByRemotePath(remotePath);
  }

  findEpisode(titleId: number, season: number, episode: number): LibraryRow | undefined {
    return this.repository.findEpisode(titleId, season, episode);
  }

  listEpisodes(row: LibraryRow): LibraryRow[] {
    return this.repository.listEpisodes(row.title, row.title_id);
  }

  add(item: NewLibraryItem): LibraryRow {
    const row = this.repository.upsert(item);
    this.events.publish({ type: 'library.changed' });
    return row;
  }

  async remove(id: number, deleteFile: boolean): Promise<void> {
    const row = this.getRow(id);
    if (deleteFile) {
      const root = this.settings.get().downloadDir;
      await fsp.rm(row.file_path, { force: true });
      if (isPathInside(row.file_path, root))
        await removeEmptyParents(path.dirname(row.file_path), root);
    }
    this.repository.delete(id);
    this.events.publish({ type: 'library.changed' });
  }

  /**
   * Analyse le dossier de téléchargement : ajoute les vidéos inconnues (déposées à la main
   * ou base réinitialisée) et retire les entrées dont le fichier a disparu.
   */
  async scan(): Promise<LibraryScanResult> {
    const root = this.settings.get().downloadDir;
    const known = this.repository.filePaths();
    let added = 0;
    let removed = 0;

    const entries = await fsp
      .readdir(root, { recursive: true, withFileTypes: true })
      .catch(() => []);
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() && classifyFile(entry.name) === 'video' && !isSampleFile(entry.name),
      )
      .map((entry) => path.join(entry.parentPath, entry.name));

    for (const file of files) {
      if (known.has(file)) continue;
      const stats = await fsp.stat(file);
      this.repository.upsert(this.inferItem(root, file, stats.size));
      added += 1;
    }
    for (const row of this.repository.list()) {
      if (!fs.existsSync(row.file_path)) {
        this.repository.delete(row.id);
        removed += 1;
      }
    }
    if (added > 0 || removed > 0) this.events.publish({ type: 'library.changed' });
    this.logger.info({ added, removed }, 'Bibliothèque analysée');
    return { added, removed, total: this.repository.list().length };
  }

  /** Déduit titre/saison/épisode d'un fichier local à partir de son emplacement. */
  private inferItem(root: string, file: string, size: number): NewLibraryItem {
    const relative = path.relative(root, file).split(path.sep);
    const fileName = path.basename(file);
    const release = parseRelease(fileName);
    let kind: LibraryKind = 'other';
    let title = prettifyTitle(release.title || fileName);
    let year = release.year;
    let season: number | null = null;
    let episode: number | null = null;
    let titleRow: TitleRow | undefined;

    if (relative[0] === MOVIES_DIR && relative.length >= 3) {
      kind = 'movie';
      const folder = relative[1] as string;
      ({ title, year } = parseFolderTitle(folder));
      titleRow = this.titles.findByFolderName('movie', folder);
    } else if (relative[0] === SERIES_DIR && relative.length >= 3) {
      kind = 'episode';
      const folder = relative[1] as string;
      title = parseFolderTitle(folder).title;
      const seasonFolder = relative.length >= 4 ? parseSeasonFolder(relative[2] as string) : null;
      const ref = parseEpisode(fileName, seasonFolder);
      season = ref.season;
      episode = ref.episode;
      year = null;
      titleRow = this.titles.findByFolderName('series', folder);
    } else {
      const ref = parseEpisode(fileName);
      if (ref.episode !== null) {
        kind = 'episode';
        season = ref.season;
        episode = ref.episode;
      }
    }
    return {
      kind,
      title: titleRow ? displayTitle(titleRow) : title,
      title_id: titleRow?.id ?? null,
      season,
      episode,
      year,
      file_path: file,
      file_name: fileName,
      size_bytes: size,
      remote_path: null,
    };
  }

  private toItem(row: LibraryRow, title: TitleRow | undefined): LibraryItem {
    const enabled = this.metadata.isEnabled();
    return {
      id: row.id,
      kind: row.kind,
      titleId: row.title_id,
      title: title ? displayTitle(title) : row.title,
      season: row.season,
      episode: row.episode,
      year: row.year,
      fileName: row.file_name,
      filePath: row.file_path,
      size: row.size_bytes,
      addedAt: row.added_at,
      remotePath: row.remote_path,
      posterUrl: title ? posterUrlFor(title, enabled) : null,
      backdropUrl: title ? backdropUrlFor(title, enabled) : null,
      release: parseRelease(row.file_name).info,
      watch: this.availability.progressFor(mediaKeyForLibraryRow(row)),
      exists: fs.existsSync(row.file_path),
    };
  }
}
