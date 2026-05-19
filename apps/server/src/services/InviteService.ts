// Invitaciones a carpetas compartidas. Dos modos:
//   - 'email': owner ingresa email; token va por mail al invitee exacto.
//   - 'link':  owner genera un link compartible; cualquier user logueado
//              que abra el link acepta.
//
// Tokens se guardan como SHA-256 hex (nunca plaintext). Expiran a los 7
// días por default. Email-mode es single-use; link-mode es multi-use
// hasta que el owner lo revoque.
// Ver docs/Sharing-design.md §11.

import type { BrainStackDatabase } from '@brainstack/core';
import { nanoid } from 'nanoid';

import { AppError } from '../lib/errors.js';
import { generateToken, sha256 } from '../lib/tokens.js';

import type { EmailSender } from './EmailSender.js';
import {
  SharingService,
  normalizeFolderPath,
} from './SharingService.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteServiceOptions {
  db: BrainStackDatabase;
  email: EmailSender;
  sharing: SharingService;
  publicOrigin: string;
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

  /** Owner crea una invite (con o sin email targeted). */
  async create(params: {
    ownerId: string;
    folderPath: string;
    mode: 'email' | 'link';
    inviteeEmail?: string;
  }): Promise<CreatedInvite> {
    if (!this.opts.sharing.enabled) {
      throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
    }
    const folderPath = normalizeFolderPath(params.folderPath);
    if (!folderPath) {
      throw new AppError('no se puede compartir el root del vault', 'INVALID_INPUT', 400);
    }
    if (params.mode === 'email' && !params.inviteeEmail) {
      throw new AppError('email mode requiere inviteeEmail', 'INVALID_INPUT', 400);
    }

    const token = generateToken(32);
    const tokenHash = sha256(token);
    const id = nanoid();
    const now = this.now();
    const expiresAt = now + this.ttl();

    this.opts.db.sqlite
      .prepare(
        `INSERT INTO folder_share_invites
           (id, folder_path, owner_id, mode, invitee_email, token_hash,
            expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        folderPath,
        params.ownerId,
        params.mode,
        params.mode === 'email' ? (params.inviteeEmail ?? null) : null,
        tokenHash,
        expiresAt,
        now,
      );

    const acceptUrl = `${this.opts.publicOrigin}/invite/accept/${token}`;
    if (params.mode === 'email' && params.inviteeEmail) {
      await this.opts.email.send({
        to: params.inviteeEmail,
        subject: 'Te compartieron una carpeta en BrainStack',
        text:
          `Hola,\n\nTe compartieron acceso a la carpeta "${folderPath}" en BrainStack.\n` +
          `Aceptá la invitación abriendo este link:\n\n${acceptUrl}\n\n` +
          `El link expira en 7 días.`,
        html:
          `<p>Hola,</p>` +
          `<p>Te compartieron acceso a la carpeta <strong>${escapeHtml(folderPath)}</strong> en BrainStack.</p>` +
          `<p><a href="${acceptUrl}">Aceptar invitación</a></p>` +
          `<p>El link expira en 7 días.</p>`,
      });
    }

    return { inviteId: id, mode: params.mode, token, acceptUrl, expiresAt };
  }

  /** Lista invites pendientes (sin aceptar ni revocar) creadas por owner. */
  listPending(ownerId: string): Array<{
    id: string;
    folderPath: string;
    mode: 'email' | 'link';
    inviteeEmail: string | null;
    expiresAt: number;
    createdAt: number;
  }> {
    if (!this.opts.sharing.enabled) return [];
    return this.opts.db.sqlite
      .prepare<[string, number], {
        id: string;
        folder_path: string;
        mode: 'email' | 'link';
        invitee_email: string | null;
        expires_at: number;
        created_at: number;
      }>(
        `SELECT id, folder_path, mode, invitee_email, expires_at, created_at
         FROM folder_share_invites
         WHERE owner_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
               AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(ownerId, this.now())
      .map((r) => ({
        id: r.id,
        folderPath: r.folder_path,
        mode: r.mode,
        inviteeEmail: r.invitee_email,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      }));
  }

  /** Revoca una invite pendiente (no toca grants ya aceptados). */
  revoke(ownerId: string, inviteId: string): void {
    if (!this.opts.sharing.enabled) {
      throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
    }
    const res = this.opts.db.sqlite
      .prepare(
        `UPDATE folder_share_invites SET revoked_at = ?
         WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`,
      )
      .run(this.now(), inviteId, ownerId);
    if (res.changes === 0) {
      throw new AppError('invite no encontrada o ya revocada', 'NOT_FOUND', 404);
    }
  }

  /**
   * Acepta una invite. El user logueado debe satisfacer las restricciones:
   *  - email mode: email del user debe coincidir con invitee_email.
   *  - link mode: cualquier user logueado.
   * Devuelve el share creado (o existente, idempotente).
   */
  accept(params: { token: string; user: { id: string; email: string } }): AcceptResult {
    if (!this.opts.sharing.enabled) {
      throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
    }
    const tokenHash = sha256(params.token);
    const row = this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        folder_path: string;
        owner_id: string;
        mode: 'email' | 'link';
        invitee_email: string | null;
        expires_at: number;
        accepted_at: number | null;
        revoked_at: number | null;
      }>(
        `SELECT id, folder_path, owner_id, mode, invitee_email, expires_at,
                accepted_at, revoked_at
         FROM folder_share_invites WHERE token_hash = ?`,
      )
      .get(tokenHash);
    if (!row) throw new AppError('invite no encontrada', 'NOT_FOUND', 404);
    if (row.revoked_at != null) {
      throw new AppError('invite revocada', 'FORBIDDEN', 403);
    }
    if (row.expires_at < this.now()) {
      throw new AppError('invite expirada', 'FORBIDDEN', 403);
    }
    if (row.mode === 'email') {
      if (row.accepted_at != null) {
        throw new AppError('invite ya aceptada', 'FORBIDDEN', 403);
      }
      if (
        !row.invitee_email ||
        row.invitee_email.toLowerCase() !== params.user.email.toLowerCase()
      ) {
        throw new AppError(
          'esta invitación es para otro email',
          'FORBIDDEN',
          403,
        );
      }
    }
    if (row.owner_id === params.user.id) {
      throw new AppError('no se puede aceptar tu propia invitación', 'INVALID_INPUT', 400);
    }

    const shareId = this.opts.sharing.grant({
      ownerId: row.owner_id,
      sharedWithUserId: params.user.id,
      folderPath: row.folder_path,
      grantedBy: row.owner_id,
    });

    // En email mode marcamos accepted_at (single-use). Link mode queda
    // multi-use; sólo registramos acceptedBy del último.
    this.opts.db.sqlite
      .prepare(
        `UPDATE folder_share_invites
         SET accepted_by_user_id = ?, accepted_at = COALESCE(accepted_at, ?)
         WHERE id = ?`,
      )
      .run(params.user.id, this.now(), row.id);
    if (row.mode === 'email') {
      this.opts.db.sqlite
        .prepare(`UPDATE folder_share_invites SET accepted_at = ? WHERE id = ?`)
        .run(this.now(), row.id);
    }

    return { shareId, folderPath: row.folder_path, ownerId: row.owner_id };
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
