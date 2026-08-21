// Claiming the notes that predate ownership.
//
// `notes.owner_id` arrived after there were already notes, so some rows have
// none. A note nobody owns is listed by nobody, so it has to be assigned before
// it silently disappears from the tree.
//
// Idempotent: it runs on boot, and does nothing once there is nothing to claim.
//
// See docs/Sharing-design.md §4.1.

import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

const { notes, users } = pgSchema;

export interface OwnerBackfillResult {
  notesUpdated: number;
  skipped: boolean;
  reason?: 'no-nulls' | 'no-users' | 'multiple-users-in-self-host';
}

export interface BackfillOptions {
  deployment: 'self-host' | 'hosted';
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

  if (Number(counts?.count ?? 0) === 0) {
    return { notesUpdated: 0, skipped: true, reason: 'no-nulls' };
  }

  if (opts.deployment === 'hosted') {
    // Hosted stores the owner as the first path segment, so an unowned row can
    // name its own owner. Nothing has to be guessed.
    const updated = await db
      .update(notes)
      .set({ ownerId: sql`split_part(${notes.path}, '/', 1)` })
      .where(isNull(notes.ownerId))
      .returning({ path: notes.path });

    opts.logger.info({ notesUpdated: updated.length }, 'backfilled owner_id from path prefix');
    return { notesUpdated: updated.length, skipped: false };
  }

  // Self-host: one user owns everything. Two would make it a guess, and
  // guessing who owns a note is not something to do silently.
  const rows = await db.select({ id: users.id }).from(users).limit(2);

  if (rows.length === 0) {
    // Deferred rather than failed: the first signup will own them.
    return { notesUpdated: 0, skipped: true, reason: 'no-users' };
  }
  if (rows.length > 1) {
    opts.logger.warn(
      'self-host database has more than one user; leaving unowned notes alone',
    );
    return { notesUpdated: 0, skipped: true, reason: 'multiple-users-in-self-host' };
  }

  const owner = rows[0]!.id;
  const updated = await db
    .update(notes)
    .set({ ownerId: owner })
    .where(isNull(notes.ownerId))
    .returning({ path: notes.path });

  opts.logger.info({ notesUpdated: updated.length, owner }, 'backfilled owner_id');
  return { notesUpdated: updated.length, skipped: false };
}
