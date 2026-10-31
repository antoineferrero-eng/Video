import type { DownloadStatus, MediaAvailability, WatchState } from '@lumiere/shared';
import type { Db } from '../../infra/database/database';

/** Clé de progression d'un média : le chemin distant fait foi (même clé en streaming et en local). */
export function mediaKeyForRemote(remotePath: string): string {
  return `remote:${remotePath}`;
}

export function mediaKeyForFile(filePath: string): string {
  return `file:${filePath}`;
}

/** Préfixe des fichiers déposés à la main dans la bibliothèque (sans chemin distant). */
export const LOCAL_ROOT = '/@bibliotheque/';

/** Copie d'un titre : téléchargée, en cours de téléchargement, ou déposée à la main. */
export interface TitleCopy {
  path: string;
  name: string;
  size: number | null;
  season: number | null;
  episode: number | null;
  /** Fichier local d'une copie déposée à la main (null : copie d'un fichier distant). */
  localFile: string | null;
  libraryItemId: number | null;
}

export function emptyAvailability(): MediaAvailability {
  return { download: null, libraryItemId: null, watch: null };
}

interface ProgressRow {
  media_key: string;
  position: number;
  duration: number | null;
  completed: number;
  updated_at: string;
}

export function toWatchState(row: ProgressRow | undefined): WatchState | null {
  if (!row) return null;
  return {
    position: row.position,
    duration: row.duration,
    completed: row.completed === 1,
    updatedAt: row.updated_at,
  };
}

const CHUNK = 400;

/** Agrège, pour un lot de fichiers distants, l'état de téléchargement, de bibliothèque et de visionnage. */
export class AvailabilityService {
  constructor(private readonly db: Db) {}

  forRemotePaths(paths: string[]): Map<string, MediaAvailability> {
    const result = new Map<string, MediaAvailability>();
    const unique = [...new Set(paths)];
    for (const path of unique) result.set(path, emptyAvailability());

    for (let offset = 0; offset < unique.length; offset += CHUNK) {
      const chunk = unique.slice(offset, offset + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');

      const downloads = this.db
        .prepare(
          `SELECT id, status, remote_path, downloaded_bytes, total_bytes FROM downloads
           WHERE remote_path IN (${placeholders}) AND status != 'canceled' ORDER BY id ASC`,
        )
        .all(...chunk) as Array<{
        id: number;
        status: DownloadStatus;
        remote_path: string;
        downloaded_bytes: number;
        total_bytes: number | null;
      }>;
      for (const row of downloads) {
        const entry = result.get(row.remote_path);
        if (!entry) continue;
        entry.download = {
          id: row.id,
          status: row.status,
          progress: row.total_bytes ? Math.min(1, row.downloaded_bytes / row.total_bytes) : null,
        };
      }

      const library = this.db
        .prepare(`SELECT id, remote_path FROM library_items WHERE remote_path IN (${placeholders})`)
        .all(...chunk) as Array<{ id: number; remote_path: string }>;
      for (const row of library) {
        const entry = result.get(row.remote_path);
        if (entry) entry.libraryItemId = row.id;
      }

      const progress = this.db
        .prepare(`SELECT * FROM watch_progress WHERE media_key IN (${placeholders})`)
        .all(...chunk.map(mediaKeyForRemote)) as ProgressRow[];
      for (const row of progress) {
        const entry = result.get(row.media_key.slice('remote:'.length));
        if (entry) entry.watch = toWatchState(row);
      }
    }
    return result;
  }

  /**
   * Chemins connus sous un préfixe (ex. le dossier d'un titre) : téléchargements,
   * bibliothèque et, si demandé, fichiers déjà regardés en streaming.
   */
  knownPathsUnder(prefix: string, options: { watched?: boolean } = {}): string[] {
    const like = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
    const watched = options.watched
      ? `UNION SELECT remote_path FROM watch_progress WHERE remote_path LIKE @like ESCAPE '\\'`
      : '';
    const rows = this.db
      .prepare(
        `SELECT remote_path FROM downloads
           WHERE remote_path LIKE @like ESCAPE '\\' AND status != 'canceled'
         UNION
         SELECT remote_path FROM library_items WHERE remote_path LIKE @like ESCAPE '\\'
         ${watched}`,
      )
      .all({ like }) as Array<{ remote_path: string }>;
    return rows.map((row) => row.remote_path);
  }

  /**
   * Copies d'un titre sur le disque ou en cours de téléchargement, quelle que soit leur
   * origine (extension Stremio, 1fichier, fichier déposé dans la bibliothèque) : c'est le
   * rattachement au titre qui fait foi, pas le chemin. Un fichier déposé à la main, sans
   * chemin distant, est désigné par `/@bibliotheque/<id>`.
   */
  titleCopies(titleId: number): TitleCopy[] {
    const rows = this.db
      .prepare(
        `SELECT remote_path, NULL AS library_id, NULL AS file_path, file_name, total_bytes AS size,
                season, episode
           FROM downloads WHERE title_id = @titleId AND status != 'canceled'
         UNION ALL
         SELECT remote_path, id, file_path, file_name, size_bytes, season, episode
           FROM library_items WHERE title_id = @titleId`,
      )
      .all({ titleId }) as Array<{
      remote_path: string | null;
      library_id: number | null;
      file_path: string | null;
      file_name: string;
      size: number | null;
      season: number | null;
      episode: number | null;
    }>;
    // Une copie téléchargée apparaît dans les deux tables : la bibliothèque passe en premier.
    const copies = new Map<string, TitleCopy>();
    rows.sort((a, b) => Number(a.library_id === null) - Number(b.library_id === null));
    for (const row of rows) {
      const path = row.remote_path ?? `${LOCAL_ROOT}${row.library_id}`;
      if (copies.has(path)) continue;
      copies.set(path, {
        path,
        name: row.file_name,
        size: row.size,
        season: row.season,
        episode: row.episode,
        localFile: row.remote_path === null ? row.file_path : null,
        libraryItemId: row.library_id,
      });
    }
    return [...copies.values()];
  }

  /** État d'une copie déposée à la main (sans chemin distant). */
  localAvailability(copy: TitleCopy): MediaAvailability {
    return {
      download: null,
      libraryItemId: copy.libraryItemId,
      watch: copy.localFile ? this.progressFor(mediaKeyForFile(copy.localFile)) : null,
    };
  }

  progressFor(mediaKey: string): WatchState | null {
    return toWatchState(
      this.db.prepare('SELECT * FROM watch_progress WHERE media_key = ?').get(mediaKey) as
        ProgressRow | undefined,
    );
  }
}
