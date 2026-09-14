// Postgres client for BrainStack.
//
// Any Postgres will do; the connection string decides how to reach it.
//
//  - Neon (`*.neon.tech`) goes over its HTTP driver (`@neondatabase/serverless`):
//    each query is one stateless HTTPS round trip, which is what makes it work
//    inside a serverless function without connection storms on cold start.
//  - Everything else — the Postgres in docker-compose, a managed one, a local
//    install — goes over node-postgres, a TCP pool held for the life of the
//    process.
//
// Both hand back the same Drizzle query API. The rest of the code only ever
// sees `PgDb`, and the test suite runs every query on a third driver (PGlite),
// so a query that only works on one of them does not get through.

import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { pgMigrations, type PgMigration } from './migrations.js';
import * as schema from './schema.js';

/**
 * The store's database handle.
 *
 * Typed as the Neon HTTP database because that is the narrowest of the drivers
 * in use: no interactive transactions, no `batch` outside it. Code written
 * against it runs unchanged on node-postgres and PGlite, which is what makes
 * the casts to it below safe.
 */
export type PgDb = NeonHttpDatabase<typeof schema>;

export interface BrainStackPgDatabase {
  db: PgDb;
  /** Release the connection pool, if there is one. Safe to call once, at shutdown. */
  close(): Promise<void>;
}

const MIGRATIONS_TABLE = '_brainstack_migrations';

export type PgDriver = 'neon-http' | 'node-postgres';

/**
 * Which driver a connection string gets.
 *
 * Only Neon's own hostnames go over HTTP: that transport does not exist
 * anywhere else. A string that does not parse as a URL is left to
 * node-postgres, which accepts more shapes than `URL` does and will say
 * precisely what is wrong with it.
 */
export function pgDriverFor(connectionString: string): PgDriver {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    return 'node-postgres';
  }
  return hostname.endsWith('.neon.tech') ? 'neon-http' : 'node-postgres';
}

/** Open a Drizzle client over whichever driver the connection string calls for. */
export function openPgDatabase(connectionString: string): BrainStackPgDatabase {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to open the Postgres store');
  }

  if (pgDriverFor(connectionString) === 'neon-http') {
    // Nothing to close: there is no pool, every query is its own request.
    const db = drizzleNeonHttp(neon(connectionString), { schema });
    return { db, close: async () => {} };
  }

  const pool = new pg.Pool({ connectionString });
  const db = drizzleNodePg(pool, { schema }) as unknown as PgDb;
  return { db, close: () => pool.end() };
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
