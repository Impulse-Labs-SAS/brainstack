// The one place that answers "can this user read or write this path".
//
// Self-host has a single user and every `can*` returns true without touching
// the database. Hosted consults folder_shares. See docs/Sharing-design.md §6.
//
// Grants are per folder, not per note, so a share keeps covering notes created
// after it was handed out.

import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';

const { folderShares, users } = pgSchema;

export type Deployment = 'self-host' | 'hosted';

export interface SharingServiceOptions {
  db: PgDb;
  deployment: Deployment;
  now?: () => number;
}

export interface SharedRoot {
  folderPath: string;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerEmail: string;
  grantedAt: number;
}

export interface ShareMember {
  shareId: string;
  folderPath: string;
  userId: string;
  email: string;
  displayName: string | null;
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

  /** True when the deployment has sharing at all. */
  get enabled(): boolean {
    return this.opts.deployment === 'hosted';
  }

  async canRead(userId: string, ownerId: string, relPath: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (userId === ownerId) return true;
    return (await this.findGrantForPath(userId, ownerId, relPath)) !== null;
  }

  canWrite(userId: string, ownerId: string, _relPath: string): boolean {
    if (!this.enabled) return true;
    // V1 is read-only sharing: only the owner writes.
    return userId === ownerId;
  }

  async assertCanRead(userId: string, ownerId: string, relPath: string): Promise<void> {
    if (!(await this.canRead(userId, ownerId, relPath))) {
      throw new AppError('sin acceso de lectura a este path', 'FORBIDDEN', 403);
    }
  }

  assertCanWrite(userId: string, ownerId: string, relPath: string): void {
    if (!this.canWrite(userId, ownerId, relPath)) {
      throw new AppError('sin acceso de escritura a este path', 'FORBIDDEN', 403);
    }
  }

  /** Folders other people shared with me. */
  async listSharedRoots(userId: string): Promise<SharedRoot[]> {
    if (!this.enabled) return [];

    const rows = await this.opts.db
      .select({
        folderPath: folderShares.folderPath,
        ownerId: folderShares.ownerId,
        displayName: users.displayName,
        email: users.email,
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
      grantedAt: Number(r.grantedAt),
    }));
  }

  /** The people I shared with, groupable by folder. */
  async listMyShares(ownerId: string): Promise<ShareMember[]> {
    if (!this.enabled) return [];

    const rows = await this.opts.db
      .select({
        shareId: folderShares.id,
        folderPath: folderShares.folderPath,
        userId: folderShares.sharedWithUserId,
        email: users.email,
        displayName: users.displayName,
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
  }): Promise<string> {
    if (!this.enabled) {
      throw new AppError('sharing no disponible en self-host', 'FORBIDDEN', 403);
    }
    const folderPath = normalizeFolderPath(params.folderPath);
    if (folderPath === '') {
      throw new AppError('no se puede compartir el root del vault', 'INVALID_INPUT', 400);
    }
    if (params.ownerId === params.sharedWithUserId) {
      throw new AppError('no se puede compartir consigo mismo', 'INVALID_INPUT', 400);
    }

    // The unique index does the deduplicating, so this is one statement rather
    // than a lookup followed by an insert that could race with itself.
    const [inserted] = await this.opts.db
      .insert(folderShares)
      .values({
        id: nanoid(),
        folderPath,
        ownerId: params.ownerId,
        sharedWithUserId: params.sharedWithUserId,
        grantedAt: this.now(),
        grantedBy: params.grantedBy,
      })
      .onConflictDoNothing()
      .returning({ id: folderShares.id });

    if (inserted) return inserted.id;

    const [existing] = await this.opts.db
      .select({ id: folderShares.id })
      .from(folderShares)
      .where(
        and(
          eq(folderShares.folderPath, folderPath),
          eq(folderShares.ownerId, params.ownerId),
          eq(folderShares.sharedWithUserId, params.sharedWithUserId),
        ),
      )
      .limit(1);

    if (!existing) throw new AppError('could not create share', 'INTERNAL', 500);
    return existing.id;
  }

  /** Revoke a grant. No-op when there is nothing to revoke. */
  async revoke(params: {
    ownerId: string;
    sharedWithUserId: string;
    folderPath: string;
  }): Promise<void> {
    if (!this.enabled) return;
    await this.opts.db
      .delete(folderShares)
      .where(
        and(
          eq(folderShares.folderPath, normalizeFolderPath(params.folderPath)),
          eq(folderShares.ownerId, params.ownerId),
          eq(folderShares.sharedWithUserId, params.sharedWithUserId),
        ),
      );
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
  ): Promise<{ folderPath: string } | null> {
    const rows = await this.opts.db
      .select({ folderPath: folderShares.folderPath })
      .from(folderShares)
      .where(
        and(eq(folderShares.sharedWithUserId, userId), eq(folderShares.ownerId, ownerId)),
      );

    for (const r of rows) {
      if (pathFallsUnder(relPath, r.folderPath)) return { folderPath: r.folderPath };
    }
    return null;
  }
}
