// TOTP 2FA: enrollment, verification, backup codes.
//
// The crypto is unchanged from the sqlite version — same secret size, same
// grace period, same backup-code alphabet. What changed is the storage: every
// method that reads or writes is async now, and the two transactions are gone.
//
// Neither needed atomicity against a race; they needed to not leave an account
// locked out halfway through. So the writes are ordered such that a failure in
// between is harmless: backup codes are stored before 2FA is switched on, and
// switched off before they are removed. The worst outcome either way is codes
// belonging to nobody, which nothing reads.

import { decodeBase32, encodeBase32NoPadding } from '@oslojs/encoding';
import { createTOTPKeyURI, generateHOTP } from '@oslojs/otp';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/tokens.js';

const { totpBackupCodes, users } = pgSchema;

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
/** Steps either side of now a code may come from: one, for a clock that drifts. */
const TOTP_WINDOW = 1;
const BACKUP_CODE_COUNT = 10;
/** Wrong codes in a row before the second factor locks. */
const MAX_FAILED_ATTEMPTS = 5;
/** How long it stays locked. Five guesses per quarter hour makes a million codes hopeless. */
const LOCK_MS = 15 * 60 * 1000;

export interface TotpServiceOptions {
  db: PgDb;
  /** Used as the issuer in otpauth:// URIs. */
  issuer: string;
  now?: () => number;
}

export interface TotpEnrollment {
  /** Base32 secret to show as a setup key. */
  secret: string;
  /** otpauth:// URI for QR rendering on the client. */
  otpauthUri: string;
}

function newSecret(): { secret: string; bytes: Uint8Array } {
  const bytes = randomBytes(20); // 160 bits, TOTP standard
  return { secret: encodeBase32NoPadding(bytes), bytes };
}

function generateBackupCode(): string {
  // 10 chars from an unambiguous alphabet, formatted as XXXXX-XXXXX.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[(buf[i] ?? 0) % alphabet.length];
    if (i === 4) out += '-';
  }
  return out;
}

/**
 * The time step `code` was generated for, within the window around `nowSec`,
 * or null. Computed here rather than with a library's verify, which reads the
 * global clock and says only yes or no: the step is what lets a code be
 * refused the second time it is presented.
 */
function matchingStep(secret: string, code: string, nowSec: number): number | null {
  let key: Uint8Array;
  try {
    key = decodeBase32(secret);
  } catch {
    return null;
  }
  const given = Buffer.from(code.trim());
  const current = Math.floor(nowSec / TOTP_PERIOD);
  let found: number | null = null;
  // Every candidate is compared, so the time taken says nothing about which.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const expected = Buffer.from(generateHOTP(key, BigInt(step), TOTP_DIGITS));
    if (expected.length === given.length && timingSafeEqual(expected, given)) found = step;
  }
  return found;
}

function verifySecret(secret: string, code: string, nowSec: number): boolean {
  return matchingStep(secret, code, nowSec) !== null;
}

export class TotpService {
  constructor(private readonly opts: TotpServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  beginEnrollment(accountName: string): TotpEnrollment {
    const { secret, bytes } = newSecret();
    const otpauthUri = createTOTPKeyURI(
      this.opts.issuer,
      accountName,
      bytes,
      TOTP_PERIOD,
      TOTP_DIGITS,
    );
    return { secret, otpauthUri };
  }

  /**
   * Persist the secret after the user has proved they can generate codes from
   * it. Returns the backup codes in plaintext — they are shown once and stored
   * only as hashes.
   */
  async confirmEnrollment(
    userId: string,
    secret: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const nowSec = Math.floor(this.now() / 1000);
    const step = matchingStep(secret, code, nowSec);
    if (step === null) {
      throw new AppError('invalid TOTP code', 'UNAUTHORIZED', 401);
    }

    // Old codes go first: re-enrolling must not leave the previous set valid.
    await this.opts.db.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, userId));

    const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
    const now = this.now();
    await this.opts.db.insert(totpBackupCodes).values(
      codes.map((c) => ({
        id: nanoid(),
        userId,
        codeHash: sha256(c),
        usedAt: null,
        createdAt: now,
      })),
    );

    // Only now is 2FA on, so a failure above cannot lock the user out of an
    // account whose second factor exists without any way around it.
    await this.opts.db
      .update(users)
      .set({
        totpSecret: secret,
        totpFailedAttempts: 0,
        totpLockedUntil: null,
        // The code that proved the enrolment is spent like any other.
        totpLastStep: step,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    return { backupCodes: codes };
  }

  /**
   * Verify a code against a stored secret: the login step, and the proof
   * `disable` asks for.
   *
   * Guessing is what this has to stop. Five wrong codes in a row lock the
   * second factor for a quarter of an hour, counted in the database because a
   * process is not the unit of deployment; and a code is accepted once, for a
   * step later than the last one accepted, so a code seen over a shoulder or in
   * a log is spent.
   */
  async verifyForUser(userId: string, code: string): Promise<boolean> {
    const [row] = await this.opts.db
      .select({
        totpSecret: users.totpSecret,
        failed: users.totpFailedAttempts,
        lockedUntil: users.totpLockedUntil,
        lastStep: users.totpLastStep,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row?.totpSecret) return false;
    const now = this.now();
    if (row.lockedUntil != null && row.lockedUntil > now) {
      const minutes = Math.ceil((row.lockedUntil - now) / 60_000);
      throw new AppError(
        `too many wrong codes; try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
        'RATE_LIMITED',
        429,
      );
    }

    const step = matchingStep(row.totpSecret, code, Math.floor(now / 1000));
    if (step !== null && (row.lastStep == null || step > row.lastStep)) {
      // Conditional, so two requests carrying the same code cannot both pass.
      const [claimed] = await this.opts.db
        .update(users)
        .set({ totpLastStep: step, totpFailedAttempts: 0, totpLockedUntil: null })
        .where(
          and(
            eq(users.id, userId),
            sql`(${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`,
          ),
        )
        .returning({ id: users.id });
      if (claimed) return true;
    }

    if (await this.consumeBackupCode(userId, code)) {
      await this.opts.db
        .update(users)
        .set({ totpFailedAttempts: 0, totpLockedUntil: null })
        .where(eq(users.id, userId));
      return true;
    }

    await this.recordFailure(userId, now);
    return false;
  }

  private async recordFailure(userId: string, now: number): Promise<void> {
    const [row] = await this.opts.db
      .update(users)
      .set({ totpFailedAttempts: sql`${users.totpFailedAttempts} + 1` })
      .where(eq(users.id, userId))
      .returning({ failed: users.totpFailedAttempts });
    if (row && row.failed >= MAX_FAILED_ATTEMPTS) {
      await this.opts.db
        .update(users)
        .set({ totpFailedAttempts: 0, totpLockedUntil: now + LOCK_MS })
        .where(eq(users.id, userId));
    }
  }

  private async consumeBackupCode(userId: string, raw: string): Promise<boolean> {
    const normalised = raw.replace(/[\s-]/g, '').toUpperCase();
    if (normalised.length !== 10) return false;
    const candidate = `${normalised.slice(0, 5)}-${normalised.slice(5)}`;

    // Claimed in one statement, so the same code submitted twice at once is
    // spent once. The sqlite version read and then wrote, and could not say so.
    const [claimed] = await this.opts.db
      .update(totpBackupCodes)
      .set({ usedAt: this.now() })
      .where(
        and(
          eq(totpBackupCodes.userId, userId),
          eq(totpBackupCodes.codeHash, sha256(candidate)),
          isNull(totpBackupCodes.usedAt),
        ),
      )
      .returning({ id: totpBackupCodes.id });

    return claimed != null;
  }

  /**
   * Drop the secret and every backup code. Requires the user to prove they can
   * still produce a code, so a hijacked session cannot silently disable 2FA.
   */
  async disable(userId: string, code: string): Promise<void> {
    if (!(await this.verifyForUser(userId, code))) {
      throw new AppError('invalid TOTP code', 'UNAUTHORIZED', 401);
    }

    // Secret first: 2FA is off from here, so a failure below leaves stray codes
    // rather than a second factor the user believes they removed.
    await this.opts.db
      .update(users)
      .set({ totpSecret: null, totpLastStep: null, updatedAt: this.now() })
      .where(eq(users.id, userId));

    await this.opts.db.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, userId));
  }

  /** How many unused backup codes remain. Shown in the settings UI. */
  async remainingBackupCodes(userId: string): Promise<number> {
    const [row] = await this.opts.db
      .select({ count: sql<number>`count(*)::int` })
      .from(totpBackupCodes)
      .where(and(eq(totpBackupCodes.userId, userId), isNull(totpBackupCodes.usedAt)));

    return row?.count ?? 0;
  }
}

export const totpInternalsForTests = {
  generateBackupCode,
  matchingStep,
  verifySecret,
};
