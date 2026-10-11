// Housekeeping: rows whose only purpose has expired.
//
// Sessions, reset and verification links, OAuth codes, states and tokens all
// carry an expiry, and nothing deleted them once it passed. Anyone can create
// some of them without an account (a reset request, a Google sign-in start,
// an OAuth registration), so on a self-hosted box the tables grew for as long
// as someone kept asking, with nothing to tell the person running it.
//
// Run at boot and every hour by the long-lived server; the Netlify function
// runs it on each cold start. Every statement is a plain indexed delete, safe
// to run concurrently and to repeat.

import { and, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Logger } from 'pino';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

const {
  emailVerificationTokens,
  folderShareInvites,
  magicLinkTokens,
  oauthAuthorizationCodes,
  oauthStates,
  oauthTokens,
  passwordResetTokens,
  sessions,
  shareRequests,
} = pgSchema;

/** Revoked OAuth tokens are kept this long, so a replay is still recognised as one. */
const REVOKED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PurgeResult {
  deleted: number;
}

export async function purgeExpired(
  db: PgDb,
  opts: { now?: number; logger?: Logger } = {},
): Promise<PurgeResult> {
  const now = opts.now ?? Date.now();
  let deleted = 0;
  const count = async (rows: Promise<unknown[]>): Promise<void> => {
    deleted += (await rows).length;
  };

  await count(db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id }));
  await count(
    db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, now))
      .returning({ id: passwordResetTokens.id }),
  );
  await count(
    db
      .delete(emailVerificationTokens)
      .where(lt(emailVerificationTokens.expiresAt, now))
      .returning({ id: emailVerificationTokens.id }),
  );
  await count(
    db.delete(magicLinkTokens).where(lt(magicLinkTokens.expiresAt, now)).returning({ id: magicLinkTokens.id }),
  );
  await count(
    db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).returning({ state: oauthStates.state }),
  );
  await count(
    db
      .delete(oauthAuthorizationCodes)
      .where(lt(oauthAuthorizationCodes.expiresAt, now))
      .returning({ id: oauthAuthorizationCodes.id }),
  );
  await count(
    db
      .delete(oauthTokens)
      .where(
        or(
          lt(oauthTokens.expiresAt, now - REVOKED_GRACE_MS),
          and(isNotNull(oauthTokens.revokedAt), lt(oauthTokens.revokedAt, now - REVOKED_GRACE_MS)),
        ),
      )
      .returning({ id: oauthTokens.id }),
  );
  await count(
    db
      .delete(folderShareInvites)
      // An accepted invite is the record of how someone got in; only the ones
      // that lapsed unused go.
      .where(and(lt(folderShareInvites.expiresAt, now), isNull(folderShareInvites.acceptedAt)))
      .returning({ id: folderShareInvites.id }),
  );

  await count(
    db.delete(shareRequests).where(lt(shareRequests.expiresAt, now)).returning({ id: shareRequests.id }),
  );

  if (deleted > 0) opts.logger?.info({ deleted }, 'purged expired sessions, links and tokens');
  return { deleted };
}
