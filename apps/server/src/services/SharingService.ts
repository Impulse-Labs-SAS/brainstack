// The one place that answers "can this user read or write this path".
//
// An owner can always read and write their own vault; anyone else needs a
// grant in folder_shares. See docs/Sharing-design.md §6.
//
// Grants are per folder, not per note, so a share keeps covering notes created
// after it was handed out.

import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';

const { folderShares, folderShareInvites, shareBlocks, shareRequests, users } = pgSchema;

/** How long a share an assistant asked for waits for the owner. */
const SHARE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Pending requests one owner may have at once; an assistant cannot pile them up. */
const MAX_PENDING_SHARE_REQUESTS = 20;

/** What a grant allows. Ordered: 'write' implies 'read'. */
export type SharePermission = 'read' | 'write';

export interface SharingServiceOptions {
  db: PgDb;
  now?: () => number;
}

export interface SharedRoot {
  folderPath: string;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerEmail: string;
  permission: SharePermission;
  grantedAt: number;
}

export interface ShareMember {
  shareId: string;
  folderPath: string;
  userId: string;
  email: string;
  displayName: string | null;
  permission: SharePermission;
  grantedAt: number;
}

/** Normalise a logical path to folder_path form: no leading or trailing slash. */
export function normalizeFolderPath(input: string): string {
  return input.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
}

/** True when `relPath` is inside `folderPath`, or is it. */
export function pathFallsUnder(relPath: string, folderPath: string): boolean {
  const a = normalizeFolderPath(relPath);
  const b = normalizeFolderPath(folderPath);
  if (b === '') return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`);
}

export class SharingService {
  constructor(private readonly opts: SharingServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async canRead(userId: string, ownerId: string, relPath: string): Promise<boolean> {
    if (userId === ownerId) return true;
    return (await this.findGrantForPath(userId, ownerId, relPath)) !== null;
  }

  /**
   * Async because it has to ask the database now.
   *
   * Sharing was read-only, so this could answer `userId === ownerId` without a
   * query. A grant can carry write since 0007, and a permission nobody looks
   * up is not a permission.
   */
  async canWrite(userId: string, ownerId: string, relPath: string): Promise<boolean> {
    if (userId === ownerId) return true;
    const grant = await this.findGrantForPath(userId, ownerId, relPath);
    return grant?.permission === 'write';
  }

  async assertCanRead(userId: string, ownerId: string, relPath: string): Promise<void> {
    if (!(await this.canRead(userId, ownerId, relPath))) {
      throw new AppError('no read access to this path', 'FORBIDDEN', 403);
    }
  }

  async assertCanWrite(userId: string, ownerId: string, relPath: string): Promise<void> {
    if (!(await this.canWrite(userId, ownerId, relPath))) {
      throw new AppError('no write access to this path', 'FORBIDDEN', 403);
    }
  }

  /**
   * The folder somebody shared with me that this path was probably meant for.
   *
   * A write names a path and nothing else, so "impulse-labs/nota.md" is read
   * against the caller's own vault — even when the only `impulse-labs` they
   * have ever seen belongs to somebody else. The write then succeeds against a
   * folder of the same name that it quietly creates, and the note lands in a
   * private copy nobody else can see. Silence is the whole problem: the person
   * writing believes they contributed to the shared folder.
   *
   * So before a write to one's own vault goes through, the path is compared
   * against the shared roots. A match means the request is ambiguous, and
   * ambiguity here has to be answered with a question rather than a guess.
   *
   * Null when the path collides with nothing, which is the common case.
   */
  async findShadowedShare(userId: string, relPath: string): Promise<SharedRoot | null> {
    for (const root of await this.listSharedRoots(userId)) {
      if (pathFallsUnder(relPath, root.folderPath)) return root;
    }
    return null;
  }

  /**
   * Refuse a write whose path names a shared folder without saying whose.
   *
   * Only for writes aimed at the caller's own vault. Once a request names an
   * `ownerId` there is nothing to disambiguate, and whether it is allowed is
   * `canWrite`'s question, not this one's.
   *
   * `sharedRoots` is threadable so a caller already holding the list — the tRPC
   * context memoises it per request — does not fetch it again.
   */
  async assertNotShadowingShare(
    userId: string,
    relPath: string,
    sharedRoots?: SharedRoot[],
  ): Promise<void> {
    const roots = sharedRoots ?? (await this.listSharedRoots(userId));
    const hit = roots.find((r) => pathFallsUnder(relPath, r.folderPath));
    if (!hit) return;

    const owner = hit.ownerDisplayName ?? hit.ownerEmail;
    throw new AppError(
      `"${hit.folderPath}" is a folder ${owner} shared with you, so this path is ambiguous. ` +
        `To write in the shared folder, pass ownerId="${hit.ownerId}". To write in your own ` +
        `vault, pass your own id as ownerId — or leave the shared folder under Settings → ` +
        `Sharing if you never wanted it.`,
      'FORBIDDEN',
      403,
    );
  }

  /** Folders other people shared with me. */
  async listSharedRoots(userId: string): Promise<SharedRoot[]> {
    const rows = await this.opts.db
      .select({
        folderPath: folderShares.folderPath,
        ownerId: folderShares.ownerId,
        displayName: users.displayName,
        email: users.email,
        permission: folderShares.permission,
        grantedAt: folderShares.grantedAt,
      })
      .from(folderShares)
      .innerJoin(users, eq(users.id, folderShares.ownerId))
      .where(eq(folderShares.sharedWithUserId, userId))
      .orderBy(desc(folderShares.grantedAt));

    return rows.map((r) => ({
      folderPath: r.folderPath,
      ownerId: r.ownerId,
      ownerDisplayName: r.displayName,
      ownerEmail: r.email,
      permission: r.permission,
      grantedAt: Number(r.grantedAt),
    }));
  }

  /** The people I shared with, groupable by folder. */
  async listMyShares(ownerId: string): Promise<ShareMember[]> {
    const rows = await this.opts.db
      .select({
        shareId: folderShares.id,
        folderPath: folderShares.folderPath,
        userId: folderShares.sharedWithUserId,
        email: users.email,
        displayName: users.displayName,
        permission: folderShares.permission,
        grantedAt: folderShares.grantedAt,
      })
      .from(folderShares)
      .innerJoin(users, eq(users.id, folderShares.sharedWithUserId))
      .where(eq(folderShares.ownerId, ownerId))
      .orderBy(folderShares.folderPath, desc(folderShares.grantedAt));

    return rows.map((r) => ({
      shareId: r.shareId,
      folderPath: r.folderPath,
      userId: r.userId,
      email: r.email,
      displayName: r.displayName,
      permission: r.permission,
      grantedAt: Number(r.grantedAt),
    }));
  }

  /**
   * Create a direct grant. Idempotent: granting the same folder to the same
   * person twice returns the existing id rather than a second row.
   */
  async grant(params: {
    ownerId: string;
    sharedWithUserId: string;
    folderPath: string;
    grantedBy: string;
    permission?: SharePermission;
  }): Promise<string> {
    const folderPath = normalizeFolderPath(params.folderPath);
    if (folderPath === '') {
      throw new AppError("you can't share the root of your vault; share a folder instead", 'INVALID_INPUT', 400);
    }
    if (params.ownerId === params.sharedWithUserId) {
      throw new AppError("you can't share a folder with yourself", 'INVALID_INPUT', 400);
    }
    const permission = params.permission ?? 'read';

    // A share lands in someone else's vault uninvited. Whoever left one of
    // yours and said "no more" is not reached again until they say otherwise.
    const [blocked] = await this.opts.db
      .select({ userId: shareBlocks.userId })
      .from(shareBlocks)
      .where(
        and(
          eq(shareBlocks.userId, params.sharedWithUserId),
          eq(shareBlocks.blockedOwnerId, params.ownerId),
        ),
      )
      .limit(1);
    if (blocked) {
      throw new AppError('this person is not accepting shares from you', 'FORBIDDEN', 403);
    }

    // One statement: the unique index deduplicates, and re-granting — which is
    // how the permission is changed — updates the row in place. A lookup and a
    // separate update could lose to a revoke landing between them.
    const [row] = await this.opts.db
      .insert(folderShares)
      .values({
        id: nanoid(),
        folderPath,
        ownerId: params.ownerId,
        sharedWithUserId: params.sharedWithUserId,
        permission,
        grantedAt: this.now(),
        grantedBy: params.grantedBy,
      })
      .onConflictDoUpdate({
        target: [folderShares.folderPath, folderShares.ownerId, folderShares.sharedWithUserId],
        set: { permission, grantedAt: this.now(), grantedBy: params.grantedBy },
      })
      .returning({ id: folderShares.id });

    if (!row) throw new AppError('could not create share', 'INTERNAL', 500);
    return row.id;
  }

  /**
   * Revoke a grant, and with it the invites that could hand it straight back.
   *
   * Deleting the row alone was not enough: a link invite is deliberately
   * reusable, so anyone still holding the URL — including the person who was
   * just removed — could accept it again and be back in. Taking someone out of
   * a folder has to mean they are out.
   *
   * Two kinds of invite die here:
   *
   *  - every live link invite for the folder, because a link names nobody and
   *    there is no way to keep it working for the others without also keeping
   *    it working for the person removed;
   *  - the pending email invite addressed to that person, which would otherwise
   *    still be sitting in their inbox.
   *
   * People who already accepted keep their access; only the way back in closes.
   * To keep inviting, the owner issues a new link.
   *
   * Grants on folders nested inside go too: removing someone from `proj`
   * while a grant on `proj/sub` kept them writing there is not removing them.
   *
   * No-op when there is nothing to revoke.
   */
  async revoke(params: {
    ownerId: string;
    sharedWithUserId: string;
    folderPath: string;
  }): Promise<void> {
    const folderPath = normalizeFolderPath(params.folderPath);
    await this.deleteGrantsUnder(params.ownerId, params.sharedWithUserId, folderPath);

    // The invites that would hand the folder, or one inside it, straight back:
    // every link invite and this person's email invites. Matched in memory —
    // share paths never go through LIKE, where a folder named `a_b` would
    // also reach `aXb`.
    const live = await this.opts.db
      .select({ id: folderShareInvites.id, folderPath: folderShareInvites.folderPath })
      .from(folderShareInvites)
      .where(
        and(
          eq(folderShareInvites.ownerId, params.ownerId),
          isNull(folderShareInvites.revokedAt),
          or(
            eq(folderShareInvites.mode, 'link'),
            sql`${folderShareInvites.inviteeEmail} = (
                  SELECT ${users.email} FROM ${users} WHERE ${users.id} = ${params.sharedWithUserId}
                )`,
          ),
        ),
      );
    const doomed = live.filter((i) => pathFallsUnder(i.folderPath, folderPath)).map((i) => i.id);
    if (doomed.length === 0) return;
    await this.opts.db
      .update(folderShareInvites)
      .set({ revokedAt: this.now() })
      .where(inArray(folderShareInvites.id, doomed));
  }

  /**
   * Follow a folder that was renamed or moved within its owner's vault.
   *
   * The counterpart to `revokeUnder`, and deliberately the opposite outcome. A
   * folder moved into another vault stops being the owner's, so the grant on it
   * dies; a folder renamed is the same folder in the same brain, so the grant
   * moves with it. Doing nothing was the worst of both: the recipient lost the
   * access silently and kept an empty root in their tree pointing at the old
   * name.
   *
   * Grants nested inside come along, keeping their depth — a share on
   * `Gondor/App` becomes one on `Archivo/Gondor/App`.
   *
   * Nobody gains access here. Every grant keeps its owner, its recipient and
   * its permission, and only the path it names changes.
   */
  async reparentUnder(params: { ownerId: string; from: string; to: string }): Promise<number> {
    const from = normalizeFolderPath(params.from);
    const to = normalizeFolderPath(params.to);
    if (from === '' || to === '' || from === to) return 0;

    const rows = await this.opts.db
      .select({
        id: folderShares.id,
        folderPath: folderShares.folderPath,
        sharedWithUserId: folderShares.sharedWithUserId,
        permission: folderShares.permission,
      })
      .from(folderShares)
      .where(eq(folderShares.ownerId, params.ownerId));

    // In memory, like everywhere else here: a folder name may contain LIKE's
    // pattern characters, and moving a grant that should have stayed is access
    // pointed at the wrong folder.
    // No early return when this is empty: a folder can have an invite out and
    // no grant yet, and that invite has to follow the folder too.
    const moving = rows.filter((r) => pathFallsUnder(r.folderPath, from));

    const rename = (folderPath: string): string =>
      folderPath === from ? to : `${to}${folderPath.slice(from.length)}`;

    for (const row of moving) {
      const folderPath = rename(row.folderPath);

      // A move can merge into a folder that already exists, so the destination
      // may already be shared with this same person. Two rows cannot name it —
      // the unique index says so — and the widest permission is the one that
      // was already in force, which is how `findGrantForPath` reads a stack of
      // grants anyway.
      const clash = rows.find(
        (r) =>
          r.id !== row.id &&
          r.folderPath === folderPath &&
          r.sharedWithUserId === row.sharedWithUserId,
      );

      if (clash) {
        if (clash.permission !== 'write' && row.permission === 'write') {
          await this.opts.db
            .update(folderShares)
            .set({ permission: 'write' })
            .where(eq(folderShares.id, clash.id));
        }
        await this.opts.db.delete(folderShares).where(eq(folderShares.id, row.id));
        continue;
      }

      await this.opts.db
        .update(folderShares)
        .set({ folderPath })
        .where(eq(folderShares.id, row.id));
    }

    // Pending invites follow too. One names the folder the owner picked when
    // inviting, and accepting it after a rename should land where the folder
    // went rather than grant a path that is no longer there.
    const invites = await this.opts.db
      .select({ id: folderShareInvites.id, folderPath: folderShareInvites.folderPath })
      .from(folderShareInvites)
      .where(
        and(eq(folderShareInvites.ownerId, params.ownerId), isNull(folderShareInvites.revokedAt)),
      );

    for (const invite of invites.filter((i) => pathFallsUnder(i.folderPath, from))) {
      await this.opts.db
        .update(folderShareInvites)
        .set({ folderPath: rename(invite.folderPath) })
        .where(eq(folderShareInvites.id, invite.id));
    }

    return moving.length;
  }

  /**
   * Drop every grant on a folder that no longer exists, and on everything that
   * was nested inside it.
   *
   * Called when a folder is deleted or moved into another vault — the two ways
   * a path can stop being a place in this owner's brain. Nothing else cleaned
   * up after those, so the grant outlived the folder: the recipient kept a root
   * in their tree that could never have contents, and the owner kept a member
   * listed on a folder they no longer had. A move across vaults is where this
   * showed, because it empties the source and leaves the row pointing at it.
   *
   * Live invites for those paths die too, for the reason `revoke` explains: an
   * invite is a way back in, and a link invite is reusable. Keeping one alive
   * would mean a grant could be handed out again on a path that is gone, and
   * then quietly cover a *new* folder if the owner ever reused the name.
   *
   * Not a permission decision — whoever made the folder disappear was already
   * allowed to. This only stops the grant from outliving what it was about.
   */
  async revokeUnder(params: { ownerId: string; folderPath: string }): Promise<number> {
    const folderPath = normalizeFolderPath(params.folderPath);
    if (folderPath === '') return 0;

    // Matched in memory, like `findGrantForPath` and for the same reason: a
    // folder name may contain LIKE's pattern characters, and revoking too
    // widely would silently cut access to a folder that is still there.
    const rows = await this.opts.db
      .select({ id: folderShares.id, folderPath: folderShares.folderPath })
      .from(folderShares)
      .where(eq(folderShares.ownerId, params.ownerId));

    const doomed = rows.filter((r) => pathFallsUnder(r.folderPath, folderPath)).map((r) => r.id);
    if (doomed.length > 0) {
      await this.opts.db.delete(folderShares).where(inArray(folderShares.id, doomed));
    }

    const invites = await this.opts.db
      .select({ id: folderShareInvites.id, folderPath: folderShareInvites.folderPath })
      .from(folderShareInvites)
      .where(
        and(eq(folderShareInvites.ownerId, params.ownerId), isNull(folderShareInvites.revokedAt)),
      );

    const doomedInvites = invites
      .filter((r) => pathFallsUnder(r.folderPath, folderPath))
      .map((r) => r.id);
    if (doomedInvites.length > 0) {
      await this.opts.db
        .update(folderShareInvites)
        .set({ revokedAt: this.now() })
        .where(inArray(folderShareInvites.id, doomedInvites));
    }

    return doomed.length;
  }

  /**
   * Leave a folder somebody shared with you, and anything of theirs nested in
   * it. With `block`, refuse every share from that person from now on.
   *
   * A share is granted without asking the recipient, so the recipient needs a
   * way out: without one, anybody with an account could share a folder named
   * like one of yours — `Inbox` — and every write you made there without an
   * owner would be refused as ambiguous, with nothing you could do about it.
   */
  async leave(params: {
    userId: string;
    ownerId: string;
    folderPath: string;
    block?: boolean;
  }): Promise<void> {
    await this.deleteGrantsUnder(params.ownerId, params.userId, normalizeFolderPath(params.folderPath));
    if (params.block) await this.block(params.userId, params.ownerId);
  }

  /** Refuse every share from `ownerId`, and leave the ones already given. */
  async block(userId: string, ownerId: string): Promise<void> {
    if (userId === ownerId) return;
    await this.opts.db
      .insert(shareBlocks)
      .values({ userId, blockedOwnerId: ownerId, createdAt: this.now() })
      .onConflictDoNothing();
    await this.opts.db
      .delete(folderShares)
      .where(and(eq(folderShares.ownerId, ownerId), eq(folderShares.sharedWithUserId, userId)));
  }

  async unblock(userId: string, ownerId: string): Promise<void> {
    await this.opts.db
      .delete(shareBlocks)
      .where(and(eq(shareBlocks.userId, userId), eq(shareBlocks.blockedOwnerId, ownerId)));
  }

  /** The people a user refuses shares from. */
  async listBlocked(
    userId: string,
  ): Promise<Array<{ ownerId: string; email: string; displayName: string | null; since: number }>> {
    const rows = await this.opts.db
      .select({
        ownerId: shareBlocks.blockedOwnerId,
        email: users.email,
        displayName: users.displayName,
        since: shareBlocks.createdAt,
      })
      .from(shareBlocks)
      .innerJoin(users, eq(users.id, shareBlocks.blockedOwnerId))
      .where(eq(shareBlocks.userId, userId))
      .orderBy(desc(shareBlocks.createdAt));
    return rows.map((r) => ({ ...r, since: Number(r.since) }));
  }

  /** Every grant from `ownerId` to `userId` at or under `folderPath`, matched in memory. */
  private async deleteGrantsUnder(
    ownerId: string,
    userId: string,
    folderPath: string,
  ): Promise<void> {
    const rows = await this.opts.db
      .select({ id: folderShares.id, folderPath: folderShares.folderPath })
      .from(folderShares)
      .where(and(eq(folderShares.ownerId, ownerId), eq(folderShares.sharedWithUserId, userId)));
    const doomed = rows.filter((r) => pathFallsUnder(r.folderPath, folderPath)).map((r) => r.id);
    if (doomed.length > 0) {
      await this.opts.db.delete(folderShares).where(inArray(folderShares.id, doomed));
    }
  }

  /**
   * Ask, on the owner's behalf, to share a folder — what an assistant does
   * instead of granting. Nothing is shared until the owner approves it in the
   * web app with a signed-in session.
   *
   * An assistant reads text other people wrote (a folder shared *with* the
   * user is someone else's writing), so "share this with x@y" may not come
   * from the user at all. A grant is the one action that hands another
   * account a way in, so it is the one that waits for a person.
   *
   * Asking again for the same folder and address updates the request.
   */
  async requestShare(params: {
    ownerId: string;
    folderPath: string;
    email: string;
    permission?: SharePermission;
    requestedBy?: string | null;
  }): Promise<{ id: string; expiresAt: number }> {
    const folderPath = normalizeFolderPath(params.folderPath);
    if (folderPath === '') {
      throw new AppError("you can't share the root of your vault; share a folder instead", 'INVALID_INPUT', 400);
    }
    const email = params.email.trim().toLowerCase();
    const now = this.now();
    const expiresAt = now + SHARE_REQUEST_TTL_MS;

    const pending = await this.listShareRequests(params.ownerId);
    const same = pending.find((r) => r.folderPath === folderPath && r.email === email);
    if (same) {
      await this.opts.db
        .update(shareRequests)
        .set({ permission: params.permission ?? 'read', createdAt: now, expiresAt })
        .where(eq(shareRequests.id, same.id));
      return { id: same.id, expiresAt };
    }
    if (pending.length >= MAX_PENDING_SHARE_REQUESTS) {
      throw new AppError(
        'too many share requests are waiting for approval; ask the user to review them first',
        'RATE_LIMITED',
        429,
      );
    }

    const id = nanoid();
    await this.opts.db.insert(shareRequests).values({
      id,
      ownerId: params.ownerId,
      folderPath,
      email,
      permission: params.permission ?? 'read',
      requestedBy: params.requestedBy ?? null,
      createdAt: now,
      expiresAt,
    });
    return { id, expiresAt };
  }

  /** Requests still waiting for this owner, newest first. */
  async listShareRequests(ownerId: string): Promise<
    Array<{
      id: string;
      folderPath: string;
      email: string;
      permission: SharePermission;
      requestedBy: string | null;
      createdAt: number;
      expiresAt: number;
    }>
  > {
    const rows = await this.opts.db
      .select()
      .from(shareRequests)
      .where(and(eq(shareRequests.ownerId, ownerId), gt(shareRequests.expiresAt, this.now())))
      .orderBy(desc(shareRequests.createdAt));
    return rows.map((r) => ({
      id: r.id,
      folderPath: r.folderPath,
      email: r.email,
      permission: r.permission,
      requestedBy: r.requestedBy,
      createdAt: Number(r.createdAt),
      expiresAt: Number(r.expiresAt),
    }));
  }

  /**
   * Remove a pending request and hand it back, for the caller to act on.
   * Claimed in one statement, so approving twice at once acts once.
   */
  async takeShareRequest(
    ownerId: string,
    id: string,
  ): Promise<{ folderPath: string; email: string; permission: SharePermission } | null> {
    const [row] = await this.opts.db
      .delete(shareRequests)
      .where(
        and(
          eq(shareRequests.id, id),
          eq(shareRequests.ownerId, ownerId),
          gt(shareRequests.expiresAt, this.now()),
        ),
      )
      .returning({
        folderPath: shareRequests.folderPath,
        email: shareRequests.email,
        permission: shareRequests.permission,
      });
    return row ?? null;
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Grants are matched in memory rather than with a LIKE, because a folder name
   * can contain the pattern characters and a share must not widen by accident.
   */
  private async findGrantForPath(
    userId: string,
    ownerId: string,
    relPath: string,
  ): Promise<{ folderPath: string; permission: SharePermission } | null> {
    const rows = await this.opts.db
      .select({ folderPath: folderShares.folderPath, permission: folderShares.permission })
      .from(folderShares)
      .where(and(eq(folderShares.sharedWithUserId, userId), eq(folderShares.ownerId, ownerId)));

    // A folder and something under it can both be shared, at different levels.
    // The widest permission wins, so a write grant on a subfolder is not
    // cancelled by a read grant on its parent.
    let best: { folderPath: string; permission: SharePermission } | null = null;
    for (const r of rows) {
      if (!pathFallsUnder(relPath, r.folderPath)) continue;
      const grant = { folderPath: r.folderPath, permission: r.permission };
      if (grant.permission === 'write') return grant;
      best ??= grant;
    }
    return best;
  }
}
