// Sqlite client for BrainStack.
// Opens a better-sqlite3 connection in WAL mode, runs migrations, and exposes
// a typed Drizzle client.

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { migrations, type Migration } from './migrations/index.js';
import * as schema from './schema.js';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export interface BrainStackDatabase {
  /** Raw better-sqlite3 handle. */
  sqlite: BetterSqlite3Database;
  /** Typed Drizzle client bound to the schema. */
  db: DrizzleDb;
  /** Close both clients. Safe to call multiple times. */
  close(): void;
}

const MIGRATIONS_TABLE = '_brainstack_migrations';

function ensureMigrationsTable(sqlite: BetterSqlite3Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function appliedMigrations(sqlite: BetterSqlite3Database): Set<string> {
  const rows = sqlite
    .prepare<unknown[], { name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)
    .all();
  return new Set(rows.map((r) => r.name));
}

function applyMigration(sqlite: BetterSqlite3Database, migration: Migration): void {
  const tx = sqlite.transaction(() => {
    sqlite.exec(migration.sql);
    sqlite
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
      .run(migration.name, Date.now());
  });
  tx();
}

/** Apply any pending migrations to the database, in declaration order. */
export function runMigrations(
  sqlite: BetterSqlite3Database,
  list: readonly Migration[] = migrations,
): void {
  ensureMigrationsTable(sqlite);
  const applied = appliedMigrations(sqlite);
  for (const migration of list) {
    if (applied.has(migration.name)) continue;
    applyMigration(sqlite, migration);
  }
}

export interface OpenDatabaseOptions {
  /** Skip running migrations on open. */
  skipMigrations?: boolean;
  /** Open the database in read-only mode. */
  readonly?: boolean;
}

/**
 * Open a BrainStack sqlite database at `filePath`. Use `':memory:'` for an
 * ephemeral in-memory database (handy for tests). WAL mode is enabled by
 * default; pending migrations are applied unless `skipMigrations` is set.
 */
export function openDatabase(
  filePath: string,
  options: OpenDatabaseOptions = {},
): BrainStackDatabase {
  const sqlite = new Database(filePath, { readonly: options.readonly ?? false });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');

  if (!options.skipMigrations) {
    runMigrations(sqlite);
  }

  const db = drizzle(sqlite, { schema });
  let closed = false;

  return {
    sqlite,
    db,
    close(): void {
      if (closed) return;
      closed = true;
      sqlite.close();
    },
  };
}
