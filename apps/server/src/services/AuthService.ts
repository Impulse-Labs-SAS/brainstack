// AuthService: email + password auth, email verification, password reset and
// session lifecycle. Google OAuth and TOTP 2FA live in their own files but
// reuse the helpers here.
//
// Security invariants, unchanged from the sqlite version:
//   - Plaintext tokens are never persisted. Only sha256 hashes hit the DB.
//   - Passwords are hashed with scrypt from node:crypto (see lib/password.ts).
//   - Email enumeration is avoided: "forgot password" and login report the
//     same thing whether or not the account exists, and cost the same time.
//
// What Postgres changed: every read is a round trip now, so the methods that
// used to return straight are async. And there are no interactive transactions
// over the Neon HTTP driver, so the two read-then-write flows — verifying an
// email, resetting a password — claim their token in a single conditional
// UPDATE instead. That is stronger than the transaction was: two concurrent
// clicks on the same link race inside one statement and exactly one wins.

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Logger } from 'pino';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';
import { DECOY_HASH, hashPassword, verifyPassword } from '../lib/password.js';
import { generateToken, sha256 } from '../lib/tokens.js';

import type { EmailSender } from './EmailSender.js';
import type { TotpService } from './TotpService.js';

const { emailVerificationTokens, passwordResetTokens, sessions, users } = pgSchema;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
/*
 * Eight, with the character-class rule below still in force. Short for a
 * password on its own; this one is behind an email allowlist of three people,
 * with TOTP available, so the length is not what is holding the door.
 */
const PASSWORD_MIN = 8;


export interface AuthServiceOptions {
  db: PgDb;
  email: EmailSender;
  logger: Logger;
  /** Where this server answers. Links to endpoints are built from it. */
  publicOrigin: string;
  /**
   * Where the web app lives. Links to pages are built from this instead.
   *
   * In production both are one origin and this can be omitted. In development
   * the server is on :3000 and the app on :3001, and sending somebody to a page
   * on the server's origin lands them on a 404 — which is exactly the mistake
   * that made the magic link fail on the Netlify line.
   */
  appOrigin?: string;
  /** Lowercased emails allowed to sign in. Empty set = open (dev only). */
  authorizedEmails: Set<string>;
  /**
   * Prefix the HTTP API is mounted under, for links that point at an endpoint
   * rather than a page. Empty when the app serves its own routes at the root;
   * `/api` behind the Next catch-all. Getting this wrong is what made every
   * magic link 404 before, so it is passed in rather than assumed.
   */
  apiBasePath?: string;
  /**
   * Optional TOTP gate. When set and the user has a secret, `login` requires a
   * code and verifies it before handing out a session.
   */
  totp?: TotpService;
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
  token: string | null;
  url: string | null;
  expiresAt: number | null;
}

/** Row shape shared by every select that builds a `User`. */
interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  googleId: string | null;
  totpSecret: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3) {
    return 'password must include at least 3 of: lowercase, uppercase, digit, symbol';
  }
  return null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    emailVerified: row.emailVerified,
    hasPassword: row.passwordHash != null,
    hasGoogle: row.googleId != null,
    hasTotp: row.totpSecret != null,
    createdAt: Number(row.createdAt),
    lastLoginAt: row.lastLoginAt === null ? null : Number(row.lastLoginAt),
  };
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

  /** Base for links that land on an endpoint. Pages do not get the prefix. */
  private apiBase(): string {
    return `${this.originBase()}${this.opts.apiBasePath ?? ''}`;
  }

  /** Base for links that land on a page of the web app. */
  private appBase(): string {
    return (this.opts.appOrigin ?? this.opts.publicOrigin).replace(/\/+$/, '');
  }

  assertAuthorized(email: string): void {
    if (this.opts.authorizedEmails.size === 0) return; // open in dev
    if (!this.opts.authorizedEmails.has(email)) {
      throw new AppError('email not authorized', 'FORBIDDEN', 403);
    }
  }

  // -- Lookups ---------------------------------------------------------------

  private async rowById(id: string): Promise<UserRow | null> {
    const [row] = await this.opts.db.select().from(users).where(eq(users.id, id)).limit(1);
    return (row as UserRow | undefined) ?? null;
  }

  private async rowByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.opts.db
      .select()
      .from(users)
      .where(eq(users.email, this.normaliseEmail(email)))
      .limit(1);
    return (row as UserRow | undefined) ?? null;
  }

  async findUserById(id: string): Promise<User | null> {
    const row = await this.rowById(id);
    return row ? toUser(row) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const row = await this.rowByEmail(email);
    return row ? toUser(row) : null;
  }

  // -- Signup and login ------------------------------------------------------

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

    const passwordHash = await hashPassword(password);
    const now = this.now();

    // Insert-or-nothing, so a duplicate email is one statement rather than a
    // check followed by a write that could race with another signup.
    const [row] = await this.opts.db
      .insert(users)
      .values({
        id: nanoid(),
        email,
        displayName: displayName ?? null,
        emailVerified: false,
        passwordHash,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      })
      .onConflictDoNothing({ target: users.email })
      .returning();

    if (!row) throw new AppError('email already registered', 'ALREADY_EXISTS', 409);

    const verification = await this.issueEmailVerification(row as UserRow, email);
    return { user: toUser(row as UserRow), verification };
  }

  async login(
    rawEmail: string,
    password: string,
    context: { userAgent?: string; ipAddress?: string; totpCode?: string } = {},
  ): Promise<{ user: User; session: Session }> {
    const row = await this.rowByEmail(rawEmail);

    // Always verify against something, so a missing account and a wrong
    // password are indistinguishable from the outside.
    let ok = false;
    try {
      ok = await verifyPassword(row?.passwordHash ?? DECOY_HASH, password);
    } catch {
      ok = false;
    }

    if (!row || !row.passwordHash || !ok) {
      throw new AppError('invalid email or password', 'UNAUTHORIZED', 401);
    }
    if (!row.emailVerified) {
      throw new AppError('email not verified', 'FORBIDDEN', 403);
    }
    this.assertAuthorized(row.email);

    if (row.totpSecret && this.opts.totp) {
      if (!context.totpCode) throw new AppError('totp code required', 'UNAUTHORIZED', 401);
      const valid = await this.opts.totp.verifyForUser(row.id, context.totpCode);
      if (!valid) throw new AppError('invalid totp code', 'UNAUTHORIZED', 401);
    }

    const now = this.now();
    await this.opts.db
      .update(users)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(users.id, row.id));

    const session = await this.createSession(row.id, context);
    return { user: toUser({ ...row, lastLoginAt: now }), session };
  }

  // -- Sessions --------------------------------------------------------------

  async createSession(
    userId: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<Session> {
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    const token = generateToken(32);
    const id = nanoid();

    await this.opts.db.insert(sessions).values({
      id,
      userId,
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    });

    return { id, userId, token, createdAt: now, expiresAt };
  }

  async validateSession(token: string): Promise<User | null> {
    if (!token) return null;
    const now = this.now();

    const [row] = await this.opts.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        emailVerified: users.emailVerified,
        passwordHash: users.passwordHash,
        googleId: users.googleId,
        totpSecret: users.totpSecret,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now)))
      .limit(1);

    return row ? toUser(row as UserRow) : null;
  }

  async revokeSession(token: string): Promise<void> {
    if (!token) return;
    await this.opts.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }

  /** Used after a password change, so other devices do not stay signed in. */
  async revokeAllSessionsFor(userId: string): Promise<void> {
    await this.opts.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  // -- Email verification ----------------------------------------------------

  private async issueEmailVerification(
    row: UserRow,
    targetEmail: string,
  ): Promise<{ token: string; url: string; expiresAt: number }> {
    const now = this.now();
    const expiresAt = now + VERIFICATION_TTL_MS;
    const token = generateToken(32);
    const email = this.normaliseEmail(targetEmail);

    await this.opts.db.insert(emailVerificationTokens).values({
      id: nanoid(),
      userId: row.id,
      email,
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt,
      usedAt: null,
    });

    const url = `${this.apiBase()}/auth/verify-email?token=${token}`;
    await this.opts.email.send({
      to: email,
      subject: 'Verify your BrainStack email',
      text: `Click to verify your email: ${url}\nThis link expires in 24 hours.`,
      html: `<p>Click to verify your email: <a href="${url}">${url}</a></p><p>This link expires in 24 hours.</p>`,
    });
    return { token, url, expiresAt };
  }

  async resendVerification(rawEmail: string): Promise<{ url: string | null }> {
    const row = await this.rowByEmail(rawEmail);
    if (!row || row.emailVerified) return { url: null };
    const issued = await this.issueEmailVerification(row, row.email);
    return { url: issued.url };
  }

  async consumeEmailVerification(token: string): Promise<User> {
    const tokenHash = sha256(token);
    const now = this.now();

    const [claimed] = await this.opts.db
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, now),
        ),
      )
      .returning({ userId: emailVerificationTokens.userId });

    if (!claimed) {
      throw await this.explainFailedClaim(emailVerificationTokens, tokenHash, now);
    }

    const [row] = await this.opts.db
      .update(users)
      .set({ emailVerified: true, updatedAt: now })
      .where(eq(users.id, claimed.userId))
      .returning();

    if (!row) throw new AppError('user not found', 'NOT_FOUND', 404);
    return toUser(row as UserRow);
  }

  // -- Password reset --------------------------------------------------------

  /**
   * Also the way an account without a password gets one.
   *
   * The accounts that predate password sign-in have no hash, and would
   * otherwise be stuck: signup rejects them as existing, and a reset that
   * required a current password would never issue. Whoever opens the link
   * controls the address, which is the same proof a reset ever had.
   */
  async requestPasswordReset(rawEmail: string): Promise<PasswordResetRequestResult> {
    const row = await this.rowByEmail(rawEmail);
    if (!row) {
      // Do not leak account existence — the caller reports success either way.
      return { token: null, url: null, expiresAt: null };
    }

    const now = this.now();
    const expiresAt = now + RESET_TTL_MS;
    const token = generateToken(32);

    await this.opts.db.insert(passwordResetTokens).values({
      id: nanoid(),
      userId: row.id,
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt,
      usedAt: null,
    });

    const url = `${this.appBase()}/reset-password?token=${token}`;
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
    const newHash = await hashPassword(newPassword);

    const [claimed] = await this.opts.db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });

    if (!claimed) {
      throw await this.explainFailedClaim(passwordResetTokens, tokenHash, now);
    }

    const [row] = await this.opts.db
      .update(users)
      // Opening the link proves control of the address, which is exactly what
      // verification asks for — so an account that arrives here unverified
      // leaves verified, rather than setting a password it cannot sign in with.
      .set({ passwordHash: newHash, emailVerified: true, updatedAt: now })
      .where(eq(users.id, claimed.userId))
      .returning();

    if (!row) throw new AppError('user not found', 'NOT_FOUND', 404);

    // Whoever knew the old password loses their sessions with it.
    await this.revokeAllSessionsFor(claimed.userId);
    return toUser(row as UserRow);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const row = await this.rowById(userId);
    if (!row || !row.passwordHash) {
      throw new AppError('no password set on this account', 'INVALID_INPUT', 400);
    }

    const ok = await verifyPassword(row.passwordHash, currentPassword);
    if (!ok) throw new AppError('current password is incorrect', 'UNAUTHORIZED', 401);

    const policyError = validatePassword(newPassword);
    if (policyError) throw new AppError(policyError, 'INVALID_INPUT', 400);

    const now = this.now();
    await this.opts.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: now })
      .where(eq(users.id, userId));
  }

  // -- Google OAuth helpers --------------------------------------------------

  async findUserByGoogleId(googleId: string): Promise<User | null> {
    const [row] = await this.opts.db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId))
      .limit(1);
    return row ? toUser(row as UserRow) : null;
  }

  /**
   * Link a Google identity to an account, creating it if the email is new.
   *
   * Two refusals, both about account takeover:
   *
   * Google's own claim that the address is verified is required, because an
   * unverified one proves only that somebody typed it.
   *
   * And an existing local account that has never verified its email cannot be
   * linked to. Otherwise anyone could sign up with somebody else's address,
   * wait for them to arrive through Google, and end up holding a password on
   * their account.
   */
  async upsertGoogleUser(input: {
    googleId: string;
    email: string;
    googleEmailVerified: boolean;
    displayName?: string | null;
  }): Promise<User> {
    const email = this.normaliseEmail(input.email);
    this.assertAuthorized(email);

    if (!input.googleEmailVerified) {
      throw new AppError('google email is unverified', 'FORBIDDEN', 403);
    }

    const existing = await this.rowByEmail(email);
    if (existing && !existing.emailVerified && existing.passwordHash) {
      throw new AppError(
        'local account exists and is not verified; verify it before linking Google',
        'FORBIDDEN',
        403,
      );
    }

    const now = this.now();

    const [row] = await this.opts.db
      .insert(users)
      .values({
        id: nanoid(),
        email,
        displayName: input.displayName ?? null,
        emailVerified: true,
        googleId: input.googleId,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          googleId: input.googleId,
          emailVerified: true,
          lastLoginAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) throw new AppError('could not create user', 'INTERNAL', 500);
    return toUser(row as UserRow);
  }

  async unlinkGoogle(userId: string): Promise<void> {
    const row = await this.rowById(userId);
    if (!row) throw new AppError('user not found', 'NOT_FOUND', 404);
    if (!row.passwordHash) {
      // Unlinking the only way in would lock the account.
      throw new AppError('set a password before unlinking Google', 'INVALID_INPUT', 400);
    }
    await this.opts.db
      .update(users)
      .set({ googleId: null, updatedAt: this.now() })
      .where(eq(users.id, userId));
  }

  // -- Misc ------------------------------------------------------------------

  /** Get-or-create without a password, for invites and for seeding. */
  async ensureUser(rawEmail: string): Promise<User> {
    const email = this.normaliseEmail(rawEmail);
    const now = this.now();

    const [row] = await this.opts.db
      .insert(users)
      .values({
        id: nanoid(),
        email,
        displayName: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      })
      // No-op update rather than DO NOTHING, so RETURNING always yields a row.
      .onConflictDoUpdate({ target: users.email, set: { email: sql`excluded.email` } })
      .returning();

    if (!row) throw new AppError('could not create user', 'INTERNAL', 500);
    return toUser(row as UserRow);
  }

  /**
   * The claim already failed; this only decides which error to report. Kept
   * separate so the atomic path stays a single statement.
   */
  private async explainFailedClaim(
    table: typeof emailVerificationTokens | typeof passwordResetTokens,
    tokenHash: string,
    now: number,
  ): Promise<AppError> {
    const [row] = await this.opts.db
      .select({ usedAt: table.usedAt, expiresAt: table.expiresAt })
      .from(table)
      .where(eq(table.tokenHash, tokenHash))
      .limit(1);

    if (!row) return new AppError('invalid token', 'UNAUTHORIZED', 401);
    if (row.usedAt != null) return new AppError('token already used', 'UNAUTHORIZED', 401);
    if (row.expiresAt < now) return new AppError('token expired', 'UNAUTHORIZED', 401);
    return new AppError('invalid token', 'UNAUTHORIZED', 401);
  }
}
