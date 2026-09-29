// Invitations to a shared folder.
//
// Two modes. An email invite names its recipient and is single-use: it only
// accepts for the address it was sent to. A link invite is a bearer token —
// whoever opens it gets access — and stays usable until it is revoked or
// expires, which is what makes it worth handing out in a chat.
//
// The token itself is never stored, only its hash, so a leaked database does
// not hand out folder access.

import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { AppError } from '../lib/errors.js';
import { generateToken, sha256 } from '../lib/tokens.js';

import type { EmailSender } from './EmailSender.js';
import {
  normalizeFolderPath,
  type SharePermission,
  type SharingService,
} from './SharingService.js';

const { folderShareInvites } = pgSchema;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteServiceOptions {
  db: PgDb;
  /** Null when the instance has no email: link invites still work. */
  email: EmailSender | null;
  sharing: SharingService;
  /**
   * Where this server answers. The accept link is an endpoint on it, not a
   * page on the web app.
   */
  publicOrigin: string;
  /** Prefix the API sits behind, e.g. `/api`. The accept link carries it. */
  apiBasePath?: string;
  ttlMs?: number;
  now?: () => number;
}

export interface CreatedInvite {
  inviteId: string;
  mode: 'email' | 'link';
  token: string;
  acceptUrl: string;
  expiresAt: number;
}

export interface AcceptResult {
  shareId: string;
  folderPath: string;
  ownerId: string;
}

export class InviteService {
  constructor(private readonly opts: InviteServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private ttl(): number {
    return this.opts.ttlMs ?? SEVEN_DAYS_MS;
  }

  /**
   * Where `GET /invite/accept/:token` actually answers: this server's origin,
   * plus the prefix the API sits behind. Pointed at the web app's origin
   * instead, the link lands on the frontend's 404 — the route only exists here.
   */
  private endpointBase(): string {
    return `${this.opts.publicOrigin.replace(/\/+$/, '')}${this.opts.apiBasePath ?? ''}`;
  }

  async create(params: {
    ownerId: string;
    folderPath: string;
    mode: 'email' | 'link';
    inviteeEmail?: string;
    permission?: SharePermission;
  }): Promise<CreatedInvite> {
    if (!this.opts.sharing.enabled) {
      throw new AppError('sharing is not available on this instance', 'NOT_FOUND', 404);
    }
    const folderPath = normalizeFolderPath(params.folderPath);
    if (!folderPath) {
      throw new AppError("you can't share the root of your vault; share a folder instead", 'INVALID_INPUT', 400);
    }
    if (params.mode === 'email' && !params.inviteeEmail) {
      throw new AppError('an email invitation needs the address to send it to', 'INVALID_INPUT', 400);
    }
    // Refused before the invite exists, so there is no pending invitation
    // nobody will ever receive.
    if (params.mode === 'email' && !this.opts.email) {
      throw new AppError(
        'this instance has no email configured; share a link invitation instead',
        'UNAVAILABLE',
        503,
      );
    }

    const token = generateToken(32);
    const id = nanoid();
    const now = this.now();
    const expiresAt = now + this.ttl();

    await this.opts.db.insert(folderShareInvites).values({
      id,
      folderPath,
      ownerId: params.ownerId,
      mode: params.mode,
      inviteeEmail: params.mode === 'email' ? (params.inviteeEmail ?? null) : null,
      permission: params.permission ?? 'read',
      tokenHash: sha256(token),
      expiresAt,
      createdAt: now,
    });

    const acceptUrl = `${this.endpointBase()}/invite/accept/${token}`;
    if (params.mode === 'email' && params.inviteeEmail && this.opts.email) {
      await this.opts.email.send({
        to: params.inviteeEmail,
        subject: 'A folder was shared with you on BrainStack',
        text:
          `Hi,\n\nYou were given access to the folder "${folderPath}" on BrainStack.\n` +
          `Accept the invitation by opening this link:\n\n${acceptUrl}\n\n` +
          `The link expires in 7 days.`,
        html:
          `<p>Hi,</p>` +
          `<p>You were given access to the folder <strong>${escapeHtml(folderPath)}</strong> on BrainStack.</p>` +
          `<p><a href="${acceptUrl}">Accept the invitation</a></p>` +
          `<p>The link expires in 7 days.</p>`,
      });
    }

    return { inviteId: id, mode: params.mode, token, acceptUrl, expiresAt };
  }

  /** Invites this owner created that are still open. */
  async listPending(ownerId: string): Promise<
    Array<{
      id: string;
      folderPath: string;
      mode: 'email' | 'link';
      inviteeEmail: string | null;
      permission: SharePermission;
      expiresAt: number;
      createdAt: number;
    }>
  > {
    if (!this.opts.sharing.enabled) return [];

    const rows = await this.opts.db
      .select({
        id: folderShareInvites.id,
        folderPath: folderShareInvites.folderPath,
        mode: folderShareInvites.mode,
        inviteeEmail: folderShareInvites.inviteeEmail,
        permission: folderShareInvites.permission,
        expiresAt: folderShareInvites.expiresAt,
        createdAt: folderShareInvites.createdAt,
      })
      .from(folderShareInvites)
      .where(
        and(
          eq(folderShareInvites.ownerId, ownerId),
          isNull(folderShareInvites.acceptedAt),
          isNull(folderShareInvites.revokedAt),
          gt(folderShareInvites.expiresAt, this.now()),
        ),
      )
      .orderBy(desc(folderShareInvites.createdAt));

    return rows.map((r) => ({
      ...r,
      expiresAt: Number(r.expiresAt),
      createdAt: Number(r.createdAt),
    }));
  }

  /** Revoking is scoped to the owner, so one cannot revoke another's invite. */
  async revoke(ownerId: string, inviteId: string): Promise<void> {
    if (!this.opts.sharing.enabled) return;
    await this.opts.db
      .update(folderShareInvites)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(folderShareInvites.id, inviteId),
          eq(folderShareInvites.ownerId, ownerId),
          isNull(folderShareInvites.revokedAt),
        ),
      );
  }

  async accept(params: {
    token: string;
    user: { id: string; email: string };
  }): Promise<AcceptResult> {
    if (!this.opts.sharing.enabled) {
      throw new AppError('sharing is not available on this instance', 'NOT_FOUND', 404);
    }

    const [row] = await this.opts.db
      .select()
      .from(folderShareInvites)
      .where(eq(folderShareInvites.tokenHash, sha256(params.token)))
      .limit(1);

    if (!row) throw new AppError('invitation not found', 'NOT_FOUND', 404);
    if (row.revokedAt != null) throw new AppError('invite revocada', 'FORBIDDEN', 403);
    if (Number(row.expiresAt) < this.now()) {
      throw new AppError('invite expirada', 'FORBIDDEN', 403);
    }

    if (row.mode === 'email') {
      if (row.acceptedAt != null) throw new AppError('this invitation was already accepted', 'FORBIDDEN', 403);
      if (!row.inviteeEmail || row.inviteeEmail.toLowerCase() !== params.user.email.toLowerCase()) {
        throw new AppError('this invitation is for a different email address', 'FORBIDDEN', 403);
      }
    }

    if (row.ownerId === params.user.id) {
      throw new AppError("you can't accept your own invitation", 'INVALID_INPUT', 400);
    }

    const shareId = await this.opts.sharing.grant({
      ownerId: row.ownerId,
      sharedWithUserId: params.user.id,
      folderPath: row.folderPath,
      grantedBy: row.ownerId,
      // What the owner chose when inviting, not what the default happens to be
      // by the time it is accepted.
      permission: row.permission,
    });

    // An email invite is spent here. A link invite records who used it last and
    // keeps working, which is the difference between the two modes.
    const now = this.now();
    await this.opts.db
      .update(folderShareInvites)
      .set({
        acceptedByUserId: params.user.id,
        acceptedAt:
          row.mode === 'email' ? now : sql`COALESCE(${folderShareInvites.acceptedAt}, ${now})`,
      })
      .where(eq(folderShareInvites.id, row.id));

    return { shareId, folderPath: row.folderPath, ownerId: row.ownerId };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
