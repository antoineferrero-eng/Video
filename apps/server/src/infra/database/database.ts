import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../core/logger';
import { MIGRATIONS, type Migration } from './migrations';

export type Db = Database.Database;

/** Ouvre (ou crée) la base SQLite et applique les migrations manquantes. */
export function openDatabase(
  file: string,
  logger: Logger,
  migrations: Migration[] = MIGRATIONS,
): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db, logger, migrations);
  return db;
}

function runMigrations(db: Db, logger: Logger, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').pluck().all() as number[]);
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
    })();
    logger.info({ migration: migration.name }, 'Migration appliquée');
  }
}

/** Petit cache clé/valeur persistant (réponses TMDB, etc.). */
export class KeyValueCache {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value, expires_at FROM kv_cache WHERE key = ?').get(key) as
      { value: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM kv_cache WHERE key = ?').run(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare(
        `INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM kv_cache WHERE expires_at < ?').run(Date.now());
  }
}
