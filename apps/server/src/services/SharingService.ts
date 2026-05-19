// Authz central de sharing. Único punto de verdad para "este user puede
// leer/escribir este path". Ver docs/Sharing-design.md §6.
//
// En self-host todos los métodos `can*` devuelven true sin tocar la DB.
// En hosted consultan folder_shares.

import type { BrainStackDatabase } from '@brainstack/core';
import { nanoid } from 'nanoid';

import { AppError } from '../lib/errors.js';

export type Deployment = 'self-host' | 'hosted';

export interface SharingServiceOptions {
  db: BrainStackDatabase;
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

/** Normaliza un path lógico al formato de folder_path: sin slash inicial ni final. */
export function normalizeFolderPath(input: string): string {
  return input.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
}

/** True si `relPath` cae dentro (o es) `folderPath`. */
export function pathFallsUnder(relPath: string, folderPath: string): boolean {
  const a = normalizeFolderPath(relPath);
  const b = normalizeFolderPath(folderPath);
  if (b === '') return true;
  if (a === b) return true;
  return a.startsWith(b + '/');
}

export class SharingService {
  constructor(private readonly opts: SharingServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** True si el deployment usa sharing (hosted). */
  get enabled(): boolean {
    return this.opts.deployment === 'hosted';
  }

  canRead(userId: string, ownerId: string, relPath: string): boolean {
    if (!this.enabled) return true;
    if (userId === ownerId) return true;
    return this.findGrantForPath(userId, ownerId, relPath) !== null;
  }

  canWrite(userId: string, ownerId: string, _relPath: string): boolean {
    if (!this.enabled) return true;
    // V1 read-only: solo el dueño escribe.
    return userId === ownerId;
  }

  assertCanRead(userId: string, ownerId: string, relPath: string): void {
    if (!this.canRead(userId, ownerId, relPath)) {
      throw new AppError('sin acceso de lectura a este path', 'FORBIDDEN', 403);
    }
  }

  assertCanWrite(userId: string, ownerId: string, relPath: string): void {
    if (!this.canWrite(userId, ownerId, relPath)) {
      throw new AppError('sin acceso de escritura a este path', 'FORBIDDEN', 403);
    }
  }

  /** Carpetas que otros users compartieron CONMIGO. */
  listSharedRoots(userId: string): SharedRoot[] {
    if (!this.enabled) return [];
    return this.opts.db.sqlite
      .prepare<[string], {
        folder_path: string;
        owner_id: string;
        display_name: string | null;
        email: string;
        granted_at: number;
      }>(
        `SELECT fs.folder_path, fs.owner_id, u.display_name, u.email, fs.granted_at
         FROM folder_shares fs
         JOIN users u ON u.id = fs.owner_id
         WHERE fs.shared_with_user_id = ?
         ORDER BY fs.granted_at DESC`,
      )
      .all(userId)
      .map((r) => ({
        folderPath: r.folder_path,
        ownerId: r.owner_id,
        ownerDisplayName: r.display_name,
        ownerEmail: r.email,
        grantedAt: r.granted_at,
      }));
  }

  /** Miembros con los que YO compartí (agrupable por folder_path). */
  listMyShares(ownerId: string): ShareMember[] {
    if (!this.enabled) return [];
    return this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        folder_path: string;
        user_id: string;
        email: string;
        display_name: string | null;
        granted_at: number;
      }>(
        `SELECT fs.id, fs.folder_path, fs.shared_with_user_id AS user_id,
                u.email, u.display_name, fs.granted_at
         FROM folder_shares fs
         JOIN users u ON u.id = fs.shared_with_user_id
         WHERE fs.owner_id = ?
         ORDER BY fs.folder_path, fs.granted_at DESC`,
      )
      .all(ownerId)
      .map((r) => ({
        shareId: r.id,
        folderPath: r.folder_path,
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        grantedAt: r.granted_at,
      }));
  }

  /**
   * Crea un grant directo (owner → target). Idempotente: si ya existe el
   * grant para (folder, owner, target), devuelve el id existente.
   */
  grant(params: {
    ownerId: string;
    sharedWithUserId: string;
    folderPath: string;
    grantedBy: string;
  }): string {
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

    const existing = this.opts.db.sqlite
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM folder_shares
         WHERE folder_path = ? AND owner_id = ? AND shared_with_user_id = ?`,
      )
      .get(folderPath, params.ownerId, params.sharedWithUserId);
    if (existing) return existing.id;

    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO folder_shares
           (id, folder_path, owner_id, shared_with_user_id, granted_at, granted_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, folderPath, params.ownerId, params.sharedWithUserId, this.now(), params.grantedBy);
    return id;
  }

  /** Revoca un grant por (folder, owner, target). No-op si no existe. */
  revoke(params: {
    ownerId: string;
    sharedWithUserId: string;
    folderPath: string;
  }): void {
    if (!this.enabled) return;
    this.opts.db.sqlite
      .prepare(
        `DELETE FROM folder_shares
         WHERE folder_path = ? AND owner_id = ? AND shared_with_user_id = ?`,
      )
      .run(normalizeFolderPath(params.folderPath), params.ownerId, params.sharedWithUserId);
  }

  // --- Internals -------------------------------------------------------------

  private findGrantForPath(
    userId: string,
    ownerId: string,
    relPath: string,
  ): { folderPath: string } | null {
    const rows = this.opts.db.sqlite
      .prepare<[string, string], { folder_path: string }>(
        `SELECT folder_path FROM folder_shares
         WHERE shared_with_user_id = ? AND owner_id = ?`,
      )
      .all(userId, ownerId);
    for (const r of rows) {
      if (pathFallsUnder(relPath, r.folder_path)) return { folderPath: r.folder_path };
    }
    return null;
  }
}
