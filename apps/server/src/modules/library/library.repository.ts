import type { LibraryKind } from '@lumiere/shared';
import type { Db } from '../../infra/database/database';

export interface LibraryRow {
  id: number;
  kind: LibraryKind;
  title_id: number | null;
  title: string;
  season: number | null;
  episode: number | null;
  year: number | null;
  file_path: string;
  file_name: string;
  size_bytes: number;
  remote_path: string | null;
  added_at: string;
}

export type NewLibraryItem = Omit<LibraryRow, 'id' | 'added_at'> & { added_at?: string };

export class LibraryRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): LibraryRow | undefined {
    return this.db.prepare('SELECT * FROM library_items WHERE id = ?').get(id) as
      LibraryRow | undefined;
  }

  findByRemotePath(remotePath: string): LibraryRow | undefined {
    return this.db
      .prepare('SELECT * FROM library_items WHERE remote_path = ? ORDER BY id DESC LIMIT 1')
      .get(remotePath) as LibraryRow | undefined;
  }

  list(): LibraryRow[] {
    return this.db
      .prepare('SELECT * FROM library_items ORDER BY added_at DESC, id DESC')
      .all() as LibraryRow[];
  }

  listByTitle(titleId: number): LibraryRow[] {
    return this.db
      .prepare('SELECT * FROM library_items WHERE title_id = ? ORDER BY season, episode, file_name')
      .all(titleId) as LibraryRow[];
  }

  /** Épisodes d'une même série présents localement (pour l'enchaînement automatique). */
  listEpisodes(title: string, titleId: number | null): LibraryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM library_items
         WHERE kind = 'episode' AND (title_id = ? OR (title_id IS NULL AND title = ?))
         ORDER BY season, episode, file_name`,
      )
      .all(titleId, title) as LibraryRow[];
  }

  upsert(item: NewLibraryItem): LibraryRow {
    return this.db
      .prepare(
        `INSERT INTO library_items (kind, title_id, title, season, episode, year, file_path, file_name,
                                    size_bytes, remote_path, added_at)
         VALUES (@kind, @title_id, @title, @season, @episode, @year, @file_path, @file_name,
                 @size_bytes, @remote_path, @added_at)
         ON CONFLICT (file_path) DO UPDATE SET
           kind = excluded.kind, title_id = COALESCE(excluded.title_id, library_items.title_id),
           title = excluded.title, season = excluded.season, episode = excluded.episode,
           year = excluded.year, size_bytes = excluded.size_bytes,
           remote_path = COALESCE(excluded.remote_path, library_items.remote_path)
         RETURNING *`,
      )
      .get({ ...item, added_at: item.added_at ?? new Date().toISOString() }) as LibraryRow;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
  }

  filePaths(): Set<string> {
    return new Set(
      this.db.prepare('SELECT file_path FROM library_items').pluck().all() as string[],
    );
  }
}
