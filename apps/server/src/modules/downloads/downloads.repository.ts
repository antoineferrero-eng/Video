import type { DownloadKind, DownloadStatus } from '@lumiere/shared';
import type { Db } from '../../infra/database/database';

export interface DownloadRow {
  id: number;
  kind: DownloadKind;
  status: DownloadStatus;
  title_id: number | null;
  title: string;
  subtitle: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  remote_path: string;
  file_name: string;
  target_path: string;
  total_bytes: number | null;
  downloaded_bytes: number;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  library_item_id: number | null;
}

export type NewDownload = Pick<
  DownloadRow,
  | 'kind'
  | 'title_id'
  | 'title'
  | 'subtitle'
  | 'season'
  | 'episode'
  | 'year'
  | 'remote_path'
  | 'file_name'
  | 'target_path'
  | 'total_bytes'
>;

type MutableFields = Partial<Omit<DownloadRow, 'id' | 'created_at'>>;

const ACTIVE_STATUSES = `('queued', 'downloading', 'paused')`;

export class DownloadsRepository {
  constructor(private readonly db: Db) {}

  insert(download: NewDownload): DownloadRow {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `INSERT INTO downloads (kind, status, title_id, title, subtitle, season, episode, year, remote_path,
                                file_name, target_path, total_bytes, downloaded_bytes, created_at, updated_at)
         VALUES (@kind, 'queued', @title_id, @title, @subtitle, @season, @episode, @year, @remote_path,
                 @file_name, @target_path, @total_bytes, 0, @now, @now)
         RETURNING *`,
      )
      .get({ ...download, now }) as DownloadRow;
  }

  findById(id: number): DownloadRow | undefined {
    return this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as
      DownloadRow | undefined;
  }

  findActiveByRemotePath(remotePath: string): DownloadRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM downloads WHERE remote_path = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
      )
      .get(remotePath) as DownloadRow | undefined;
  }

  /** Ordre d'affichage : en cours, en attente, en pause, échecs, puis terminés (plus récents d'abord). */
  list(): DownloadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM downloads ORDER BY
           CASE status WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2
                       WHEN 'failed' THEN 3 ELSE 4 END,
           CASE WHEN status IN ('completed', 'canceled') THEN COALESCE(completed_at, updated_at) END DESC,
           id ASC`,
      )
      .all() as DownloadRow[];
  }

  nextQueued(excludeIds: number[]): DownloadRow | undefined {
    const exclusion =
      excludeIds.length > 0 ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(
        `SELECT * FROM downloads WHERE status = 'queued' ${exclusion} ORDER BY id ASC LIMIT 1`,
      )
      .get(...excludeIds) as DownloadRow | undefined;
  }

  update(id: number, fields: MutableFields): DownloadRow | undefined {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    const assignments = [...entries.map(([key]) => `${key} = @${key}`), 'updated_at = @updated_at'];
    return this.db
      .prepare(`UPDATE downloads SET ${assignments.join(', ')} WHERE id = @id RETURNING *`)
      .get({ ...Object.fromEntries(entries), id, updated_at: new Date().toISOString() }) as
      DownloadRow | undefined;
  }

  saveProgress(id: number, downloaded: number, total: number | null): void {
    this.db
      .prepare(
        'UPDATE downloads SET downloaded_bytes = ?, total_bytes = ?, updated_at = ? WHERE id = ?',
      )
      .run(downloaded, total, new Date().toISOString(), id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  deleteFinished(): number {
    return this.db.prepare(`DELETE FROM downloads WHERE status IN ('completed', 'canceled')`).run()
      .changes;
  }

  /** Au démarrage, les téléchargements interrompus repassent en file d'attente (reprise automatique). */
  resetInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE downloads SET status = 'queued', updated_at = ? WHERE status = 'downloading'`,
      )
      .run(new Date().toISOString()).changes;
  }

  countByStatus(): Record<DownloadStatus, number> {
    const counts: Record<DownloadStatus, number> = {
      queued: 0,
      downloading: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM downloads GROUP BY status')
      .all() as Array<{
      status: DownloadStatus;
      count: number;
    }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  idsByStatus(statuses: DownloadStatus[]): number[] {
    return this.db
      .prepare(
        `SELECT id FROM downloads WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`,
      )
      .pluck()
      .all(...statuses) as number[];
  }
}
