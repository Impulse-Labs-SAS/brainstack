// Neon Postgres client for BrainStack.
//
// Uses the HTTP driver (`@neondatabase/serverless`) rather than a TCP pool:
// each query is one stateless HTTPS round trip, which is what makes this work
// inside a serverless function without connection storms on cold start.

import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import { pgMigrations, type PgMigration } from './migrations.js';
import * as schema from './schema.js';

export type PgDb = NeonHttpDatabase<typeof schema>;

export interface BrainStackPgDatabase {
  db: PgDb;
}

const MIGRATIONS_TABLE = '_brainstack_migrations';

/** Open a Neon-backed Drizzle client. Cheap to call — there is no pool to warm. */
export function openPgDatabase(connectionString: string): BrainStackPgDatabase {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to open the Postgres store');
  }
  const client = neon(connectionString);
  return { db: drizzle(client, { schema }) };
}

/**
 * Apply pending migrations in declaration order.
 *
 * Runs statement by statement without an enclosing transaction: the Neon HTTP
 * driver has no interactive transactions. Every statement is idempotent, so a
 * run interrupted halfway is safe to repeat.
 */
export async function runPgMigrations(
  db: PgDb,
  list: readonly PgMigration[] = pgMigrations,
): Promise<string[]> {
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`),
  );

  const rows = await db.execute<{ name: string }>(sql.raw(`SELECT name FROM ${MIGRATIONS_TABLE}`));
  const applied = new Set(rows.rows.map((r) => r.name));

  const ran: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.name)) continue;
    for (const statement of migration.statements) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(
      sql`INSERT INTO _brainstack_migrations (name, applied_at)
          VALUES (${migration.name}, ${Date.now()})
          ON CONFLICT (name) DO NOTHING`,
    );
    ran.push(migration.name);
  }
  return ran;
}

/**
 * Bring the schema up to date once per database handle.
 *
 * Called on the way into every request so a fresh deployment builds its own
 * schema: the alternative was an admin endpoint, which needed a credential of
 * its own, which had to exist before the database did — a bootstrap key no
 * amount of key management inside the app could ever replace.
 *
 * The work happens once per process, not once per request: the promise is
 * cached against the handle, so warm requests await something already settled.
 * Concurrent instances racing on a cold start is fine — every statement is
 * idempotent and the ledger insert takes ON CONFLICT DO NOTHING.
 *
 * A failure is not cached. The next request retries rather than leaving the
 * instance permanently convinced the schema is broken.
 */
const schemaReady = new WeakMap<PgDb, Promise<void>>();

export function ensurePgSchema(db: PgDb): Promise<void> {
  let pending = schemaReady.get(db);
  if (!pending) {
    pending = runPgMigrations(db)
      .then(() => undefined)
      .catch((err: unknown) => {
        schemaReady.delete(db);
        throw err;
      });
    schemaReady.set(db, pending);
  }
  return pending;
}
