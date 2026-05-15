// AuthService: session lifecycle. Auth methods (signup/login/oauth/reset/verify)
// will be added in the next commits. For now this file only owns opaque
// server-side sessions and a get-or-create user helper used by API key tests.

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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthService {
  constructor(private readonly opts: AuthServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  assertAuthorized(email: string): void {
    if (this.opts.authorizedEmails.size === 0) return; // open in dev
    if (!this.opts.authorizedEmails.has(this.normaliseEmail(email))) {
      throw new AppError('email not authorized', 'FORBIDDEN', 403);
    }
  }

  createSession(
    userId: string,
    context: { userAgent?: string; ipAddress?: string } = {},
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

  /** Convenience: get-or-create a user (used by tests and OAuth bootstrap). */
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
