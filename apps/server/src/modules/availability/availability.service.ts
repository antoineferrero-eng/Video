import type { DownloadStatus, MediaAvailability, WatchState } from '@lumiere/shared';
import type { Db } from '../../infra/database/database';

/** Clé de progression d'un média : le chemin distant fait foi (même clé en streaming et en local). */
export function mediaKeyForRemote(remotePath: string): string {
  return `remote:${remotePath}`;
}

export function mediaKeyForFile(filePath: string): string {
  return `file:${filePath}`;
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

  progressFor(mediaKey: string): WatchState | null {
    return toWatchState(
      this.db.prepare('SELECT * FROM watch_progress WHERE media_key = ?').get(mediaKey) as
        ProgressRow | undefined,
    );
  }
}
