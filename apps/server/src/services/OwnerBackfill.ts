// Backfill de owner_id en self-host. Asigna todas las notas/attachments
// con owner_id NULL al único user de la tabla `users`. Idempotente.
// En hosted no debería haber NULLs (las notas se crean con owner explícito);
// si hay, se loggean y se dejan para que un admin las reasigne.
//
// Ver docs/Sharing-design.md §4.1.

import type { BrainStackDatabase } from '@brainstack/core';
import type { Logger } from 'pino';

export interface OwnerBackfillResult {
  notesUpdated: number;
  attachmentsUpdated: number;
  skipped: boolean;
  reason?: 'no-nulls' | 'no-users' | 'multiple-users-in-self-host';
}

export interface BackfillOptions {
  deployment: 'self-host' | 'hosted';
  logger: Logger;
}

export function backfillOwnerId(
  bs: BrainStackDatabase,
  opts: BackfillOptions,
): OwnerBackfillResult {
  const counts = bs.sqlite
    .prepare<unknown[], { notes: number; attachments: number }>(
      `SELECT
         (SELECT COUNT(*) FROM notes WHERE owner_id IS NULL) AS notes,
         (SELECT COUNT(*) FROM attachments WHERE owner_id IS NULL) AS attachments`,
    )
    .get();
  const totalNulls = (counts?.notes ?? 0) + (counts?.attachments ?? 0);
  if (totalNulls === 0) {
    return { notesUpdated: 0, attachmentsUpdated: 0, skipped: true, reason: 'no-nulls' };
  }

  if (opts.deployment === 'hosted') {
    opts.logger.warn(
      { notesNull: counts?.notes ?? 0, attachmentsNull: counts?.attachments ?? 0 },
      'hosted deployment has rows with NULL owner_id; leaving for manual fix',
    );
    return { notesUpdated: 0, attachmentsUpdated: 0, skipped: true };
  }

  const userRows = bs.sqlite
    .prepare<unknown[], { id: string }>(`SELECT id FROM users LIMIT 2`)
    .all();
  if (userRows.length === 0) {
    return { notesUpdated: 0, attachmentsUpdated: 0, skipped: true, reason: 'no-users' };
  }
  if (userRows.length > 1) {
    opts.logger.warn(
      'self-host backfill skipped: more than one user in users table',
    );
    return {
      notesUpdated: 0,
      attachmentsUpdated: 0,
      skipped: true,
      reason: 'multiple-users-in-self-host',
    };
  }

  const ownerId = userRows[0].id;
  const tx = bs.sqlite.transaction(() => {
    const r1 = bs.sqlite
      .prepare('UPDATE notes SET owner_id = ? WHERE owner_id IS NULL')
      .run(ownerId);
    const r2 = bs.sqlite
      .prepare('UPDATE attachments SET owner_id = ? WHERE owner_id IS NULL')
      .run(ownerId);
    return { n: r1.changes, a: r2.changes };
  });
  const { n, a } = tx();

  opts.logger.info(
    { ownerId, notesUpdated: n, attachmentsUpdated: a },
    'self-host owner_id backfill complete',
  );
  return { notesUpdated: n, attachmentsUpdated: a, skipped: false };
}
