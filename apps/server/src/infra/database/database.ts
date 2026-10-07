import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { Logger } from '../../core/logger';
import { MIGRATIONS, type Migration } from './migrations';

/**
 * Base SQLite via le module intégré `node:sqlite` : aucune dépendance native à compiler,
 * l'installation fonctionne à l'identique sous Windows, macOS et Linux.
 *
 * Fine surcouche : mise en cache des requêtes préparées et typage souple des paramètres.
 */
export type SqlParams = Record<string, SQLInputValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class Statement {
  constructor(private readonly statement: StatementSync) {}

  get(...params: unknown[]): unknown {
    return this.statement.get(...(params as SQLInputValue[]));
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...(params as SQLInputValue[]));
  }

  run(...params: unknown[]): RunResult {
    const result = this.statement.run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
}

const STATEMENT_CACHE_SIZE = 500;

export class Database {
  private readonly statements = new Map<string, Statement>();

  constructor(private readonly connection: DatabaseSync) {}

  prepare(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= STATEMENT_CACHE_SIZE) this.statements.clear();
      statement = new Statement(this.connection.prepare(sql));
      this.statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  close(): void {
    this.statements.clear();
    if (this.connection.isOpen) this.connection.close();
  }
}

export type Db = Database;

function loadSqlite() {
  // Chargement à l'exécution (et non à l'import) : le filtre de l'avertissement
  // « module expérimental » installé par main.ts est alors déjà actif.
  return process.getBuiltinModule('node:sqlite');
}

/** Ouvre (ou crée) la base SQLite et applique les migrations manquantes. */
export function openDatabase(
  file: string,
  logger: Logger,
  migrations: Migration[] = MIGRATIONS,
): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new Database(new DatabaseSync(file));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  runMigrations(db, logger, migrations);
  return db;
}

/** Exécute `work` dans une transaction (validée en cas de succès, annulée sinon). */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction déjà annulée par SQLite.
    }
    throw error;
  }
}

/** Valeur scalaire de la première colonne de la première ligne. */
export function scalar<T>(db: Db, sql: string, ...params: unknown[]): T {
  const row = db.prepare(sql).get(...params) as Record<string, T> | undefined;
  return (row ? Object.values(row)[0] : undefined) as T;
}

function runMigrations(db: Db, logger: Logger, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(
      (row) => row.id,
    ),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
    });
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
