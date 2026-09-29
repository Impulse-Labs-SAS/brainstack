// Claiming the notes that predate ownership.
//
// `notes.owner_id` arrived after there were already notes, so some rows have
// none. A note nobody owns is listed by nobody, so it has to be assigned before
// it silently disappears from the tree.
//
// Every stored path starts with its owner's id, so an unowned row names its own
// owner and nothing has to be guessed. A row whose first segment is not a user
// cannot be claimed, and neither can a row whose path lies outside the owner it
// already has: both are invisible to everyone. They are left untouched and
// reported, once, at error level — hiding them quietly is the one thing this
// must not do.
//
// Idempotent: it runs on boot, and does nothing once there is nothing to claim.
//
// See docs/Sharing-design.md §4.1.

import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { and, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

const { notes, users } = pgSchema;

/** How many of the notes nobody can see are named in the log. */
const SAMPLE_SIZE = 5;

export interface OwnerBackfillResult {
  notesUpdated: number;
  skipped: boolean;
  reason?: 'no-nulls';
  /** Notes no vault shows, because no owner could be read from their path. */
  unattributed: number;
}

export interface BackfillOptions {
  logger: Logger;
}

export async function backfillOwnerId(
  db: PgDb,
  opts: BackfillOptions,
): Promise<OwnerBackfillResult> {
  const [counts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notes)
    .where(isNull(notes.ownerId));

  let notesUpdated = 0;
  if (Number(counts?.count ?? 0) > 0) {
    // Only rows whose first segment is an account: anything else would break
    // the foreign key, and a failed boot hides the notes just as well.
    const updated = await db
      .update(notes)
      .set({ ownerId: sql`split_part(${notes.path}, '/', 1)` })
      .where(
        and(
          isNull(notes.ownerId),
          sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = split_part(${notes.path}, '/', 1))`,
        ),
      )
      .returning({ path: notes.path });
    notesUpdated = updated.length;
    if (notesUpdated > 0) {
      opts.logger.info({ notesUpdated }, 'backfilled owner_id from path prefix');
    }
  }

  const unattributed = await reportUnattributed(db, opts.logger);

  if (Number(counts?.count ?? 0) === 0) {
    return { notesUpdated: 0, skipped: true, reason: 'no-nulls', unattributed };
  }
  return { notesUpdated, skipped: false, unattributed };
}

/**
 * Notes that no vault lists: no owner, or a path that does not start with the
 * owner they have. A database written by a build that stored unprefixed paths
 * holds nothing else. Compared with `left()` rather than `LIKE`, so an id is
 * never read as a pattern.
 */
async function reportUnattributed(db: PgDb, logger: Logger): Promise<number> {
  const stray = sql`(${notes.ownerId} IS NULL OR left(${notes.path}, length(${notes.ownerId}) + 1) <> ${notes.ownerId} || '/')`;

  const [counts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notes)
    .where(stray);
  const count = Number(counts?.count ?? 0);
  if (count === 0) return 0;

  const sample = await db
    .select({ path: notes.path })
    .from(notes)
    .where(stray)
    .orderBy(notes.path)
    .limit(SAMPLE_SIZE);

  logger.error(
    { count, sample: sample.map((r) => r.path) },
    'notes whose path does not start with an owning user id are invisible to every account; ' +
      'move each one under "<userId>/" and set owner_id to that user',
  );
  return count;
}
