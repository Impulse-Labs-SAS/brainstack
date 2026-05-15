// TOTP 2FA. Secrets are stored base32-encoded in users.totp_secret. Backup
// codes (one-time, 8 chars) live in totp_backup_codes as sha256 hashes —
// we never store them in plaintext. The user can present a backup code in
// place of a TOTP code; using one marks it consumed.

import type { BrainStackDatabase } from '@brainstack/core';
import { decodeBase32, encodeBase32NoPadding } from '@oslojs/encoding';
import { createTOTPKeyURI, verifyTOTPWithGracePeriod } from '@oslojs/otp';
import { nanoid } from 'nanoid';
import { randomBytes } from 'node:crypto';

import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/tokens.js';

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_GRACE = 30; // accept the previous step too
const BACKUP_CODE_COUNT = 10;

export interface TotpServiceOptions {
  db: BrainStackDatabase;
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

  /** Return a fresh secret + otpauth URI WITHOUT persisting it. The caller
   * shows it to the user; they confirm by entering a current TOTP code, and
   * we persist via {@link confirmEnrollment}. */
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

  /** Persist the secret after the user has proved they can generate codes
   * from it. Generates and returns the backup codes (plaintext — show once). */
  confirmEnrollment(userId: string, secret: string, code: string): { backupCodes: string[] } {
    const nowSec = Math.floor(this.now() / 1000);
    if (!verifySecret(secret, code, nowSec)) {
      throw new AppError('invalid TOTP code', 'UNAUTHORIZED', 401);
    }
    const tx = this.opts.db.sqlite.transaction(() => {
      this.opts.db.sqlite
        .prepare('UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?')
        .run(secret, this.now(), userId);
      // Wipe old backup codes if re-enrolling.
      this.opts.db.sqlite.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
      const codes: string[] = [];
      const insert = this.opts.db.sqlite.prepare(
        `INSERT INTO totp_backup_codes (id, user_id, code_hash, used_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      );
      for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
        const code = generateBackupCode();
        insert.run(nanoid(), userId, sha256(code), this.now());
        codes.push(code);
      }
      return codes;
    });
    return { backupCodes: tx() };
  }

  /** Verify a code against a stored secret (login second-factor step). */
  verifyForUser(userId: string, code: string): boolean {
    const row = this.opts.db.sqlite
      .prepare<[string], { totp_secret: string | null }>(
        'SELECT totp_secret FROM users WHERE id = ?',
      )
      .get(userId);
    if (!row?.totp_secret) return false;
    const nowSec = Math.floor(this.now() / 1000);
    if (verifySecret(row.totp_secret, code, nowSec)) return true;
    return this.consumeBackupCode(userId, code);
  }

  private consumeBackupCode(userId: string, raw: string): boolean {
    const normalised = raw.replace(/[\s-]/g, '').toUpperCase();
    if (normalised.length !== 10) return false;
    const candidate = `${normalised.slice(0, 5)}-${normalised.slice(5)}`;
    const hash = sha256(candidate);
    const row = this.opts.db.sqlite
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM totp_backup_codes
           WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
      )
      .get(userId, hash);
    if (!row) return false;
    this.opts.db.sqlite
      .prepare('UPDATE totp_backup_codes SET used_at = ? WHERE id = ?')
      .run(this.now(), row.id);
    return true;
  }

  /** Drop the secret + every backup code. Requires the user to prove they
   * can still produce a code (or hand a backup) so a hijacked session can't
   * silently disable 2FA. */
  disable(userId: string, code: string): void {
    if (!this.verifyForUser(userId, code)) {
      throw new AppError('invalid TOTP code', 'UNAUTHORIZED', 401);
    }
    const tx = this.opts.db.sqlite.transaction(() => {
      this.opts.db.sqlite
        .prepare('UPDATE users SET totp_secret = NULL, updated_at = ? WHERE id = ?')
        .run(this.now(), userId);
      this.opts.db.sqlite
        .prepare('DELETE FROM totp_backup_codes WHERE user_id = ?')
        .run(userId);
    });
    tx();
  }

  /** Returns how many unused backup codes remain. Useful for the settings UI. */
  remainingBackupCodes(userId: string): number {
    const row = this.opts.db.sqlite
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM totp_backup_codes
           WHERE user_id = ? AND used_at IS NULL`,
      )
      .get(userId);
    return row?.c ?? 0;
  }
}

export const totpInternalsForTests = {
  generateBackupCode,
  verifySecret,
};
