import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { decodeBase32 } from '@oslojs/encoding';
import { generateTOTP } from '@oslojs/otp';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';

import { AuthService } from './AuthService.js';
import { CapturingEmailSender } from './EmailSender.js';
import { TotpService } from './TotpService.js';

const STRONG = 'Sup3rStrong!Passw0rd';

let bs: BrainStackDatabase;
let auth: AuthService;
let totp: TotpService;
let now = 1_700_000_000_000;

beforeEach(() => {
  bs = openDatabase(':memory:');
  now = 1_700_000_000_000;
  totp = new TotpService({ db: bs, issuer: 'BrainStack', now: () => now });
  auth = new AuthService({
    db: bs,
    email: new CapturingEmailSender(),
    logger: pino({ level: 'silent' }),
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(),
    totp,
    now: () => now,
  });
});

afterEach(() => {
  bs.close();
});

function codeFor(secret: string): string {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return generateTOTP(decodeBase32(secret), 30, 6);
  } finally {
    Date.now = realNow;
  }
}

describe('TotpService enrollment', () => {
  it('returns a base32 secret + otpauth URI but does not persist anything', () => {
    const enrollment = totp.beginEnrollment('user@brain.test');
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\/BrainStack:user/);
    const u = auth.ensureUser('user@brain.test');
    expect(auth.getUser(u.id)?.hasTotp).toBe(false);
  });

  it('persists the secret and returns 10 backup codes on confirmation', () => {
    const u = auth.ensureUser('user@brain.test');
    const { secret } = totp.beginEnrollment('user@brain.test');
    const { backupCodes } = totp.confirmEnrollment(u.id, secret, codeFor(secret));
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    expect(auth.getUser(u.id)?.hasTotp).toBe(true);
  });

  it('rejects the wrong confirmation code', () => {
    const u = auth.ensureUser('user@brain.test');
    const { secret } = totp.beginEnrollment('user@brain.test');
    expect(() => totp.confirmEnrollment(u.id, secret, '000000')).toThrow(AppError);
    expect(auth.getUser(u.id)?.hasTotp).toBe(false);
  });
});

describe('TotpService verifyForUser', () => {
  it('accepts the current code', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const { secret } = totp.beginEnrollment('user@brain.test');
    const user = auth.getUser(auth.ensureUser('user@brain.test').id)!;
    totp.confirmEnrollment(user.id, secret, codeFor(secret));
    expect(totp.verifyForUser(user.id, codeFor(secret))).toBe(true);
  });

  it('accepts and consumes a backup code', async () => {
    const u = auth.ensureUser('user@brain.test');
    const { secret } = totp.beginEnrollment('user@brain.test');
    const { backupCodes } = totp.confirmEnrollment(u.id, secret, codeFor(secret));
    const code = backupCodes[0]!;
    expect(totp.verifyForUser(u.id, code)).toBe(true);
    expect(totp.verifyForUser(u.id, code)).toBe(false); // already consumed
    expect(totp.remainingBackupCodes(u.id)).toBe(9);
  });

  it('returns false for an arbitrary string', () => {
    const u = auth.ensureUser('user@brain.test');
    const { secret } = totp.beginEnrollment('user@brain.test');
    totp.confirmEnrollment(u.id, secret, codeFor(secret));
    expect(totp.verifyForUser(u.id, 'nope')).toBe(false);
  });
});

describe('AuthService.login with TOTP', () => {
  it('refuses login without a code when totp is enabled', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const me = auth.getUser(auth.ensureUser('user@brain.test').id)!;
    const { secret } = totp.beginEnrollment('user@brain.test');
    totp.confirmEnrollment(me.id, secret, codeFor(secret));

    await expect(auth.login('user@brain.test', STRONG)).rejects.toMatchObject({
      message: 'totp code required',
    });

    await expect(
      auth.login('user@brain.test', STRONG, { totpCode: '000000' }),
    ).rejects.toMatchObject({ message: 'invalid totp code' });

    const ok = await auth.login('user@brain.test', STRONG, { totpCode: codeFor(secret) });
    expect(ok.session.token).toBeTruthy();
  });
});

describe('TotpService.disable', () => {
  it('requires a valid code', async () => {
    const u = auth.ensureUser('user@brain.test');
    const { secret } = totp.beginEnrollment('user@brain.test');
    totp.confirmEnrollment(u.id, secret, codeFor(secret));
    expect(() => totp.disable(u.id, '000000')).toThrow(AppError);
    totp.disable(u.id, codeFor(secret));
    expect(auth.getUser(u.id)?.hasTotp).toBe(false);
    expect(totp.remainingBackupCodes(u.id)).toBe(0);
  });
});
