// AuthService: passwordless magic-link auth.
//
// Flow:
//   1. Client calls requestMagicLink(email). We generate a one-time token,
//      store only its sha256 hash, and email a URL with the plaintext token.
//   2. Client visits the URL. We hash the token, look it up, check it isn't
//      expired or already consumed, mark it consumed, and create a session.
//   3. The session cookie carries an opaque token (also stored as hash) for
//      subsequent authenticated requests.

import type { BrainStackDatabase } from '@brainstack/core';
import { nanoid } from 'nanoid';

import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';
import { generateToken, sha256 } from '../lib/tokens.js';

import type { EmailSender } from './EmailSender.js';

export interface AuthServiceOptions {
  db: BrainStackDatabase;
  email: EmailSender;
  logger: Logger;
  publicOrigin: string;
  /** Lowercased emails allowed to sign in. Empty set = open (dev only). */
  authorizedEmails: Set<string>;
  /** Override timestamp source for tests. */
  now?: () => number;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Session {
  id: string;
  userId: string;
  /** Plaintext token. Only returned at creation time. */
  token: string;
  createdAt: number;
  expiresAt: number;
}

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthService {
  constructor(private readonly opts: AuthServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private assertAuthorized(email: string): void {
    if (this.opts.authorizedEmails.size === 0) return; // open in dev
    if (!this.opts.authorizedEmails.has(email)) {
      throw new AppError('email not authorized', 'FORBIDDEN', 403);
    }
  }

  async requestMagicLink(email: string): Promise<{ token: string }> {
    const normalised = this.normaliseEmail(email);
    if (!normalised.includes('@')) {
      throw new AppError('invalid email', 'INVALID_INPUT', 400);
    }
    this.assertAuthorized(normalised);

    const token = generateToken(32);
    const now = this.now();
    const expiresAt = now + MAGIC_LINK_TTL_MS;
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO magic_link_tokens (id, email, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nanoid(), normalised, sha256(token), now, expiresAt);

    const url = `${this.opts.publicOrigin.replace(/\/+$/, '')}/auth/magic-link/callback?token=${token}`;
    await this.opts.email.send({
      to: normalised,
      subject: 'Your BrainStack sign-in link',
      text: `Click to sign in: ${url}\nThis link expires in 15 minutes.`,
      html: `<p>Click to sign in: <a href="${url}">${url}</a></p><p>This link expires in 15 minutes.</p>`,
    });

    return { token };
  }

  async consumeMagicLink(
    token: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<{ user: User; session: Session }> {
    const tokenHash = sha256(token);
    const now = this.now();

    const row = this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        email: string;
        expires_at: number;
        consumed_at: number | null;
      }>(
        `SELECT id, email, expires_at, consumed_at FROM magic_link_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash);

    if (!row) throw new AppError('invalid token', 'UNAUTHORIZED', 401);
    if (row.consumed_at != null) throw new AppError('token already used', 'UNAUTHORIZED', 401);
    if (row.expires_at < now) throw new AppError('token expired', 'UNAUTHORIZED', 401);

    const consumeTx = this.opts.db.sqlite.transaction(() => {
      this.opts.db.sqlite
        .prepare('UPDATE magic_link_tokens SET consumed_at = ? WHERE id = ?')
        .run(now, row.id);

      const existing = this.opts.db.sqlite
        .prepare<[string], User & { created_at: number; last_login_at: number | null }>(
          `SELECT id, email, display_name AS displayName, created_at AS createdAt, last_login_at AS lastLoginAt
           FROM users WHERE email = ?`,
        )
        .get(row.email);

      let user: User;
      if (existing) {
        this.opts.db.sqlite
          .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
          .run(now, existing.id);
        user = { ...existing, lastLoginAt: now };
      } else {
        const id = nanoid();
        this.opts.db.sqlite
          .prepare(
            `INSERT INTO users (id, email, display_name, created_at, last_login_at)
             VALUES (?, ?, NULL, ?, ?)`,
          )
          .run(id, row.email, now, now);
        user = {
          id,
          email: row.email,
          displayName: null,
          createdAt: now,
          lastLoginAt: now,
        };
      }
      return user;
    });

    const user = consumeTx();
    const session = this.createSession(user.id, context);
    return { user, session };
  }

  private createSession(
    userId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Session {
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    const token = generateToken(32);
    const id = nanoid();

    this.opts.db.sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, sha256(token), now, expiresAt, context.userAgent ?? null, context.ipAddress ?? null);

    return { id, userId, token, createdAt: now, expiresAt };
  }

  validateSession(token: string): User | null {
    if (!token) return null;
    const now = this.now();
    const row = this.opts.db.sqlite
      .prepare<[string, number], {
        id: string;
        email: string;
        display_name: string | null;
        created_at: number;
        last_login_at: number | null;
      }>(
        `SELECT u.id, u.email, u.display_name, u.created_at, u.last_login_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), now);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }

  revokeSession(token: string): void {
    if (!token) return;
    this.opts.db.sqlite
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(sha256(token));
  }

  /** Convenience: get-or-create a user without going through the magic-link flow. */
  ensureUser(email: string): User {
    const normalised = this.normaliseEmail(email);
    const now = this.now();
    const existing = this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        email: string;
        display_name: string | null;
        created_at: number;
        last_login_at: number | null;
      }>(
        `SELECT id, email, display_name, created_at, last_login_at FROM users WHERE email = ?`,
      )
      .get(normalised);
    if (existing) {
      return {
        id: existing.id,
        email: existing.email,
        displayName: existing.display_name,
        createdAt: existing.created_at,
        lastLoginAt: existing.last_login_at,
      };
    }
    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, created_at, last_login_at)
         VALUES (?, ?, NULL, ?, NULL)`,
      )
      .run(id, normalised, now);
    return {
      id,
      email: normalised,
      displayName: null,
      createdAt: now,
      lastLoginAt: null,
    };
  }
}
