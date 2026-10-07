import type { Db } from '../../infra/database/database';

export interface ProgressRow {
  media_key: string;
  title_id: number | null;
  library_item_id: number | null;
  remote_path: string | null;
  title: string;
  subtitle: string | null;
  position: number;
  duration: number | null;
  completed: number;
  updated_at: string;
}

export class ProgressRepository {
  constructor(private readonly db: Db) {}

  get(mediaKey: string): ProgressRow | undefined {
    return this.db.prepare('SELECT * FROM watch_progress WHERE media_key = ?').get(mediaKey) as
      ProgressRow | undefined;
  }

  upsert(row: Omit<ProgressRow, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO watch_progress (media_key, title_id, library_item_id, remote_path, title, subtitle,
                                     position, duration, completed, updated_at)
         VALUES (@media_key, @title_id, @library_item_id, @remote_path, @title, @subtitle,
                 @position, @duration, @completed, @updated_at)
         ON CONFLICT (media_key) DO UPDATE SET
           title_id = COALESCE(excluded.title_id, watch_progress.title_id),
           library_item_id = COALESCE(excluded.library_item_id, watch_progress.library_item_id),
           remote_path = COALESCE(excluded.remote_path, watch_progress.remote_path),
           title = excluded.title, subtitle = excluded.subtitle, position = excluded.position,
           duration = COALESCE(excluded.duration, watch_progress.duration),
           completed = excluded.completed, updated_at = excluded.updated_at`,
      )
      .run({ ...row, updated_at: new Date().toISOString() });
  }

  /** Lectures entamées, les plus récentes d'abord. */
  inProgress(limit: number): ProgressRow[] {
    return this.db
      .prepare(
        `SELECT * FROM watch_progress WHERE completed = 0 AND position >= 15
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as ProgressRow[];
  }

  delete(mediaKey: string): void {
    this.db.prepare('DELETE FROM watch_progress WHERE media_key = ?').run(mediaKey);
  }
}
