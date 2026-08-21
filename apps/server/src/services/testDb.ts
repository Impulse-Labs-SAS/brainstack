// In-process Postgres for tests.
//
// PGlite is genuine Postgres compiled to WASM, so the migrations, the tsvector
// column and every query run for real — the only difference from Neon is the
// transport. Mocking the database instead would test nothing that matters here.
//
// Booting an instance costs ~2s, so suites create one per file and call
// `reset()` between tests rather than paying that per test.

import { PGlite } from '@electric-sql/pglite';
import { runPgMigrations, type PgDb } from '@brainstack/core/pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

export interface TestDatabase {
  db: PgDb;
  /** Empty every table, leaving the schema in place. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

// `notes` cascades into links and tags; `users` cascades into sessions,
// api_keys, shares, invites and every auth token. Truncating the roots with
// CASCADE covers the rest.
const ROOT_TABLES = ['notes', 'users', 'magic_link_tokens', 'api_keys', 'oauth_states'];

/** Fresh, migrated, isolated database. Call `close()` when the suite ends. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  // The services are typed against the Neon HTTP driver; PGlite speaks the same
  // Drizzle query API, so the cast is safe and keeps the real SQL under test.
  const db = drizzle(client) as unknown as PgDb;
  await runPgMigrations(db);

  return {
    db,
    reset: async () => {
      await db.execute(sql.raw(`TRUNCATE ${ROOT_TABLES.join(', ')} CASCADE`));
    },
    close: async () => {
      await client.close();
    },
  };
}
