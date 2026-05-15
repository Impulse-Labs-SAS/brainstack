// AuthService: email + password auth, email verification, password reset and
// session lifecycle. Google OAuth and TOTP 2FA live in their own files but
// reuse the helpers exported here (createSession, ensureUserByGoogleId, etc.).
//
// Security invariants:
//   - Plaintext tokens are never persisted. Only sha256 hashes hit the DB.
//   - Passwords are hashed with argon2id (@node-rs/argon2 defaults).
//   - All comparisons that depend on user input are timing-safe.
//   - Email enumeration is avoided at the route layer (always return 200 OK
//     for "forgot password" and signup-on-existing-email).

import type { BrainStackDatabase } from '@brainstack/core';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { nanoid } from 'nanoid';
import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';
import { generateToken, sha256 } from '../lib/tokens.js';

import type { EmailSender } from './EmailSender.js';

export interface AuthServiceOptions {
  db: BrainStackDatabase;
  email: EmailSender;
  logger: Logger;
  /** Used to build verification / reset URLs in outgoing email. */
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
  emailVerified: boolean;
  hasPassword: boolean;
  hasGoogle: boolean;
  hasTotp: boolean;
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

export interface SignupResult {
  user: User;
  verification: { token: string; url: string; expiresAt: number };
}

export interface PasswordResetRequestResult {
  /** Null when no user matched the email (we still pretend success at the route). */
  token: string | null;
  url: string | null;
  expiresAt: number | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: number;
  password_hash: string | null;
  google_id: string | null;
  totp_secret: string | null;
  created_at: number;
  last_login_at: number | null;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const PASSWORD_MIN = 12;

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified === 1,
    hasPassword: row.password_hash != null,
    hasGoogle: row.google_id != null,
    hasTotp: row.totp_secret != null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Validate password complexity. Returns null if OK, or an error message. */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'password must include at least 3 of: lowercase, uppercase, digit, symbol';
  return null;
}

export class AuthService {
  constructor(private readonly opts: AuthServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private originBase(): string {
    return this.opts.publicOrigin.replace(/\/+$/, '');
  }

  assertAuthorized(email: string): void {
    if (this.opts.authorizedEmails.size === 0) return; // open in dev
    if (!this.opts.authorizedEmails.has(this.normaliseEmail(email))) {
      throw new AppError('email not authorized', 'FORBIDDEN', 403);
    }
  }

  private findUserByEmail(email: string): UserRow | undefined {
    return this.opts.db.sqlite
      .prepare<[string], UserRow>(
        `SELECT id, email, display_name, email_verified, password_hash, google_id,
                totp_secret, created_at, last_login_at
           FROM users WHERE email = ?`,
      )
      .get(this.normaliseEmail(email));
  }

  private findUserById(userId: string): UserRow | undefined {
    return this.opts.db.sqlite
      .prepare<[string], UserRow>(
        `SELECT id, email, display_name, email_verified, password_hash, google_id,
                totp_secret, created_at, last_login_at
           FROM users WHERE id = ?`,
      )
      .get(userId);
  }

  getUser(userId: string): User | null {
    const row = this.findUserById(userId);
    return row ? rowToUser(row) : null;
  }

  async signup(
    rawEmail: string,
    password: string,
    displayName?: string | null,
  ): Promise<SignupResult> {
    const email = this.normaliseEmail(rawEmail);
    if (!email.includes('@')) throw new AppError('invalid email', 'INVALID_INPUT', 400);
    this.assertAuthorized(email);

    const policyError = validatePassword(password);
    if (policyError) throw new AppError(policyError, 'INVALID_INPUT', 400);

    if (this.findUserByEmail(email)) {
      throw new AppError('email already registered', 'ALREADY_EXISTS', 409);
    }

    const passwordHash = await argonHash(password);
    const now = this.now();
    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO users
           (id, email, display_name, email_verified, password_hash, google_id,
            totp_secret, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, 0, ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(id, email, displayName ?? null, passwordHash, now, now);

    const row = this.findUserById(id)!;
    const verification = await this.issueEmailVerification(row, email);
    return { user: rowToUser(row), verification };
  }

  async login(
    rawEmail: string,
    password: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<{ user: User; session: Session }> {
    const email = this.normaliseEmail(rawEmail);
    // Always look up — we still hash a dummy password if the user is missing
    // so the timing of the response doesn't leak account existence.
    const row = this.findUserByEmail(email);

    // Argon2 verify against the stored hash, or against a constant dummy
    // when the account is absent or only uses Google.
    const dummy = '$argon2id$v=19$m=19456,t=2,p=1$ZGVjb3lkZWNveWRlY295ZGU$' +
      'lZbZx0WgPa1xQp4qF2tQE3W3uX7YBgmkOdGqQyMS7C0';
    const hashToCheck = row?.password_hash ?? dummy;
    let ok = false;
    try {
      ok = await argonVerify(hashToCheck, password);
    } catch {
      ok = false;
    }

    if (!row || !row.password_hash || !ok) {
      throw new AppError('invalid email or password', 'UNAUTHORIZED', 401);
    }
    if (row.email_verified !== 1) {
      throw new AppError('email not verified', 'FORBIDDEN', 403);
    }

    const now = this.now();
    this.opts.db.sqlite
      .prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, row.id);

    const session = this.createSession(row.id, context);
    const refreshed = this.findUserById(row.id)!;
    return { user: rowToUser(refreshed), session };
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
      .prepare<[string, number], UserRow>(
        `SELECT u.id, u.email, u.display_name, u.email_verified, u.password_hash,
                u.google_id, u.totp_secret, u.created_at, u.last_login_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), now);
    return row ? rowToUser(row) : null;
  }

  revokeSession(token: string): void {
    if (!token) return;
    this.opts.db.sqlite
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(sha256(token));
  }

  revokeAllSessionsFor(userId: string): void {
    this.opts.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // -- Email verification --------------------------------------------------

  private async issueEmailVerification(
    row: UserRow,
    targetEmail: string,
  ): Promise<{ token: string; url: string; expiresAt: number }> {
    const now = this.now();
    const expiresAt = now + VERIFICATION_TTL_MS;
    const token = generateToken(32);
    const id = nanoid();
    const email = this.normaliseEmail(targetEmail);
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO email_verification_tokens (id, user_id, email, token_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, row.id, email, sha256(token), now, expiresAt);

    const url = `${this.originBase()}/auth/verify-email?token=${token}`;
    await this.opts.email.send({
      to: email,
      subject: 'Verify your BrainStack email',
      text: `Click to verify your email: ${url}\nThis link expires in 24 hours.`,
      html: `<p>Click to verify your email: <a href="${url}">${url}</a></p><p>This link expires in 24 hours.</p>`,
    });
    return { token, url, expiresAt };
  }

  async resendVerification(rawEmail: string): Promise<{ url: string | null }> {
    const row = this.findUserByEmail(rawEmail);
    if (!row || row.email_verified === 1) return { url: null };
    const v = await this.issueEmailVerification(row, row.email);
    return { url: v.url };
  }

  consumeEmailVerification(token: string): User {
    const tokenHash = sha256(token);
    const now = this.now();
    const tx = this.opts.db.sqlite.transaction(() => {
      const row = this.opts.db.sqlite
        .prepare<[string], {
          id: string;
          user_id: string;
          email: string;
          expires_at: number;
          used_at: number | null;
        }>(
          `SELECT id, user_id, email, expires_at, used_at
             FROM email_verification_tokens WHERE token_hash = ?`,
        )
        .get(tokenHash);
      if (!row) throw new AppError('invalid token', 'UNAUTHORIZED', 401);
      if (row.used_at != null) throw new AppError('token already used', 'UNAUTHORIZED', 401);
      if (row.expires_at < now) throw new AppError('token expired', 'UNAUTHORIZED', 401);

      this.opts.db.sqlite
        .prepare('UPDATE email_verification_tokens SET used_at = ? WHERE id = ?')
        .run(now, row.id);
      this.opts.db.sqlite
        .prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?')
        .run(now, row.user_id);
      const userRow = this.findUserById(row.user_id);
      if (!userRow) throw new AppError('user not found', 'NOT_FOUND', 404);
      return userRow;
    });
    return rowToUser(tx());
  }

  // -- Password reset ------------------------------------------------------

  async requestPasswordReset(rawEmail: string): Promise<PasswordResetRequestResult> {
    const row = this.findUserByEmail(rawEmail);
    if (!row || !row.password_hash) {
      // Don't leak account existence — caller treats this as a success.
      return { token: null, url: null, expiresAt: null };
    }
    const now = this.now();
    const expiresAt = now + RESET_TTL_MS;
    const token = generateToken(32);
    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, row.id, sha256(token), now, expiresAt);
    const url = `${this.originBase()}/reset-password?token=${token}`;
    await this.opts.email.send({
      to: row.email,
      subject: 'Reset your BrainStack password',
      text: `Reset your password: ${url}\nThis link expires in 1 hour. Ignore this email if you didn't request it.`,
      html: `<p>Reset your password: <a href="${url}">${url}</a></p><p>This link expires in 1 hour. Ignore this email if you didn't request it.</p>`,
    });
    return { token, url, expiresAt };
  }

  async consumePasswordReset(token: string, newPassword: string): Promise<User> {
    const policyError = validatePassword(newPassword);
    if (policyError) throw new AppError(policyError, 'INVALID_INPUT', 400);
    const tokenHash = sha256(token);
    const now = this.now();
    const newHash = await argonHash(newPassword);

    const tx = this.opts.db.sqlite.transaction(() => {
      const row = this.opts.db.sqlite
        .prepare<[string], {
          id: string;
          user_id: string;
          expires_at: number;
          used_at: number | null;
        }>(
          `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
        )
        .get(tokenHash);
      if (!row) throw new AppError('invalid token', 'UNAUTHORIZED', 401);
      if (row.used_at != null) throw new AppError('token already used', 'UNAUTHORIZED', 401);
      if (row.expires_at < now) throw new AppError('token expired', 'UNAUTHORIZED', 401);

      this.opts.db.sqlite
        .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?')
        .run(now, row.id);
      this.opts.db.sqlite
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(newHash, now, row.user_id);
      this.opts.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      const userRow = this.findUserById(row.user_id);
      if (!userRow) throw new AppError('user not found', 'NOT_FOUND', 404);
      return userRow;
    });
    return rowToUser(tx());
  }

  // -- Password change (already logged in) ---------------------------------

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const row = this.findUserById(userId);
    if (!row || !row.password_hash) {
      throw new AppError('no password set on this account', 'INVALID_INPUT', 400);
    }
    const ok = await argonVerify(row.password_hash, currentPassword).catch(() => false);
    if (!ok) throw new AppError('current password is incorrect', 'UNAUTHORIZED', 401);
    const policyError = validatePassword(newPassword);
    if (policyError) throw new AppError(policyError, 'INVALID_INPUT', 400);
    const newHash = await argonHash(newPassword);
    const now = this.now();
    this.opts.db.sqlite
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(newHash, now, userId);
  }

  // -- Google OAuth helpers ------------------------------------------------

  findUserByGoogleId(googleId: string): User | null {
    const row = this.opts.db.sqlite
      .prepare<[string], UserRow>(
        `SELECT id, email, display_name, email_verified, password_hash, google_id,
                totp_secret, created_at, last_login_at
           FROM users WHERE google_id = ?`,
      )
      .get(googleId);
    return row ? rowToUser(row) : null;
  }

  /** Get-or-link a user by Google. Throws if linking would be unsafe. */
  upsertGoogleUser(input: {
    googleId: string;
    email: string;
    googleEmailVerified: boolean;
    displayName?: string | null;
  }): User {
    const email = this.normaliseEmail(input.email);
    const now = this.now();

    const byGoogle = this.findUserByGoogleId(input.googleId);
    if (byGoogle) {
      this.opts.db.sqlite
        .prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, byGoogle.id);
      return { ...byGoogle, lastLoginAt: now };
    }

    if (!input.googleEmailVerified) {
      throw new AppError(
        'google account has an unverified email — cannot link',
        'FORBIDDEN',
        403,
      );
    }

    const byEmail = this.findUserByEmail(email);
    if (byEmail) {
      if (byEmail.email_verified !== 1) {
        // Refuse to auto-link to an unverified local account — would
        // let an attacker pre-register the victim's email and inherit
        // the Google sign-in later.
        throw new AppError(
          'local account exists but is not verified — verify by email first',
          'FORBIDDEN',
          403,
        );
      }
      this.opts.db.sqlite
        .prepare(
          `UPDATE users SET google_id = ?, last_login_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.googleId, now, now, byEmail.id);
      const refreshed = this.findUserById(byEmail.id)!;
      return rowToUser(refreshed);
    }

    this.assertAuthorized(email);
    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO users
           (id, email, display_name, email_verified, password_hash, google_id,
            totp_secret, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, 1, NULL, ?, NULL, ?, ?, ?)`,
      )
      .run(id, email, input.displayName ?? null, input.googleId, now, now, now);
    const row = this.findUserById(id)!;
    return rowToUser(row);
  }

  unlinkGoogle(userId: string): void {
    const row = this.findUserById(userId);
    if (!row) throw new AppError('user not found', 'NOT_FOUND', 404);
    if (!row.password_hash) {
      throw new AppError(
        'cannot unlink Google: no password is set, account would be locked out',
        'INVALID_INPUT',
        400,
      );
    }
    const now = this.now();
    this.opts.db.sqlite
      .prepare('UPDATE users SET google_id = NULL, updated_at = ? WHERE id = ?')
      .run(now, userId);
  }

  /**
   * Get-or-create a user by email without going through any flow. Used by
   * tests and as a primitive in OAuth bootstrap.
   */
  ensureUser(rawEmail: string): User {
    const email = this.normaliseEmail(rawEmail);
    const existing = this.findUserByEmail(email);
    if (existing) return rowToUser(existing);
    const now = this.now();
    const id = nanoid();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO users
           (id, email, display_name, email_verified, password_hash, google_id,
            totp_secret, created_at, updated_at, last_login_at)
         VALUES (?, ?, NULL, 0, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(id, email, now, now);
    return rowToUser(this.findUserById(id)!);
  }
}
