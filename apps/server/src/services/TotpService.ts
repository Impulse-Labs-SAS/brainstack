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
import { createTOTPKeyURI, verifyTOTPWithGracePeriod } from '@oslojs/otp';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { randomBytes } from 'node:crypto';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/tokens.js';

const { totpBackupCodes, users } = pgSchema;

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_GRACE = 30; // accept the previous step too
const BACKUP_CODE_COUNT = 10;

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

function verifySecret(secret: string, code: string, nowSec: number): boolean {
  let key: Uint8Array;
  try {
    key = decodeBase32(secret);
  } catch {
    return false;
  }
  // Pin the verifier to our `now()` if a test wants to: we re-seed Date.now
  // momentarily because @oslojs/otp doesn't accept a clock injection.
  const realNow = Date.now;
  try {
    Date.now = () => nowSec * 1000;
    return verifyTOTPWithGracePeriod(key, TOTP_PERIOD, TOTP_DIGITS, code, TOTP_GRACE);
  } finally {
    Date.now = realNow;
  }
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
    if (!verifySecret(secret, code, nowSec)) {
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
      .set({ totpSecret: secret, updatedAt: now })
      .where(eq(users.id, userId));

    return { backupCodes: codes };
  }

  /** Verify a code against a stored secret (login second-factor step). */
  async verifyForUser(userId: string, code: string): Promise<boolean> {
    const [row] = await this.opts.db
      .select({ totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row?.totpSecret) return false;
    const nowSec = Math.floor(this.now() / 1000);
    if (verifySecret(row.totpSecret, code, nowSec)) return true;
    return this.consumeBackupCode(userId, code);
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
      .set({ totpSecret: null, updatedAt: this.now() })
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
  verifySecret,
};
