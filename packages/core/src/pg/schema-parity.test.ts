// Keeps `schema.ts` and `migrations.ts` describing the same database.
//
// Two things define the schema and neither one checks the other. `migrations.ts`
// is what actually runs against Neon; `schema.ts` is what `drizzle-kit` diffs to
// write the *next* migration. If they drift, the generator starts proposing
// nonsense — dropping a column that only the migrations know about, adding a
// foreign key that has been there all along — and the damage lands in
// production, not here.
//
// So: apply each of them to its own empty Postgres and compare what came out.
// PGlite is real Postgres, so this compares real catalogs, not two parsers'
// opinions about SQL.
//
// When this fails, one side changed and the other did not. Almost always the
// fix is `pnpm db:generate` after editing `schema.ts` — see README-ish note at
// the top of `migrations.ts`.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

import { runPgMigrations, type PgDb } from './client.js';

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'drizzle');

/** The bookkeeping table is ours, not the schema's, so it never takes part. */
const BOOKKEEPING = '_brainstack_migrations';

let handWritten: PgDb;
let generated: PgDb;

beforeAll(async () => {
  handWritten = drizzle(new PGlite()) as unknown as PgDb;
  await runPgMigrations(handWritten);

  generated = drizzle(new PGlite()) as unknown as PgDb;
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  expect(files.length, 'drizzle-kit has never been run: try pnpm db:generate').toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
    // drizzle-kit separates statements with this marker precisely because the
    // serverless drivers send one statement per round trip.
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await generated.execute(sql.raw(trimmed));
    }
  }
}, 120_000);

async function rows(db: PgDb, query: ReturnType<typeof sql>): Promise<string[]> {
  const result = await db.execute(query);
  return (result.rows as { d: string }[]).map((r) => r.d);
}

const columnsQuery = sql`
  SELECT table_name || '.' || column_name || ' ' || data_type ||
         CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
         COALESCE(' DEFAULT ' || column_default, '') AS d
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name <> ${BOOKKEEPING}
  ORDER BY 1`;

/**
 * Grouped by shape rather than by name: Postgres names a constraint declared
 * inline differently than one drizzle-kit names explicitly, and a foreign key
 * is the same foreign key either way.
 */
const constraintsQuery = sql`
  SELECT tc.table_name || ' ' || tc.constraint_type || ' (' ||
         string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) || ')' AS d
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  WHERE tc.table_schema = 'public' AND tc.table_name <> ${BOOKKEEPING}
  GROUP BY tc.table_name, tc.constraint_type, tc.constraint_name
  ORDER BY 1`;

const indexesQuery = sql`
  SELECT tablename || ': ' || indexdef AS d FROM pg_indexes
  WHERE schemaname = 'public' AND tablename <> ${BOOKKEEPING}
  ORDER BY 1`;

const checksQuery = sql`
  SELECT rel.relname || ' CHECK ' || pg_get_constraintdef(con.oid) AS d
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public' AND con.contype = 'c'
  ORDER BY 1`;

/** `notes.body_tsv`: the search vector has to be computed identically by both. */
const generatedColumnsQuery = sql`
  SELECT table_name || '.' || column_name || ' := ' ||
         regexp_replace(generation_expression, '\s+', ' ', 'g') AS d
  FROM information_schema.columns
  WHERE table_schema = 'public' AND is_generated = 'ALWAYS'
  ORDER BY 1`;

describe('schema.ts and migrations.ts describe the same database', () => {
  it('has the same columns', async () => {
    expect(await rows(generated, columnsQuery)).toEqual(await rows(handWritten, columnsQuery));
  });

  it('has the same keys and unique constraints', async () => {
    expect(await rows(generated, constraintsQuery)).toEqual(
      await rows(handWritten, constraintsQuery),
    );
  });

  it('has the same indexes', async () => {
    // Index names are compared too: a missing name means a migration created it
    // under a different one, and dropping it later would silently miss.
    expect(await rows(generated, indexesQuery)).toEqual(await rows(handWritten, indexesQuery));
  });

  it('has the same check constraints', async () => {
    expect(await rows(generated, checksQuery)).toEqual(await rows(handWritten, checksQuery));
  });

  it('computes the search vector identically', async () => {
    const both = await rows(handWritten, generatedColumnsQuery);
    expect(both, 'the tsvector column vanished').not.toHaveLength(0);
    expect(await rows(generated, generatedColumnsQuery)).toEqual(both);
  });
});
