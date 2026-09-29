// Re-derive every note's index rows from its stored text.
//
// For repairing what an older parser left behind — facets holding a date as
// its quoted JSON, checksums that ignored the frontmatter, links a move left
// pointing at where a note used to be. Ordinary writes keep the index right on
// their own; this is only for rows written before they did.
//
//   DATABASE_URL=... pnpm --filter @brainstack/server reindex
//
// Owners are claimed first, the same way boot does it: links resolve inside
// the owner's vault, so a note without one would be re-resolved against the
// wrong set of paths. Safe to run more than once. `updated_at` is not touched.

import { ensurePgSchema, openPgDatabase, PgNoteStore } from '@brainstack/core/pg';

import { loadConfig } from './config/env.js';
import { getLogger } from './lib/logger.js';
import { backfillOwnerId } from './services/OwnerBackfill.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = getLogger();

  const { db, close } = openPgDatabase(cfg.DATABASE_URL);
  try {
    await ensurePgSchema(db);
    await backfillOwnerId(db, { logger });
    const count = await new PgNoteStore(db).reindexAll();
    logger.info({ notes: count }, 'reindexed every note');
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  getLogger().error({ err }, 'reindex failed');
  process.exit(1);
});
