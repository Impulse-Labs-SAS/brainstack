import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { AppError } from '../lib/errors.js';

import { ApiKeyService } from './ApiKeyService.js';
import { AuthService, validatePassword } from './AuthService.js';
import { CapturingEmailSender } from './EmailSender.js';

const logger = pino({ level: 'silent' });
const STRONG = 'Sup3rStrong!Passw0rd';
const NEW_STRONG = 'An0ther!StrongerPass';

let bs: BrainStackDatabase;
let auth: AuthService;
let apiKeys: ApiKeyService;
let mailer: CapturingEmailSender;
let now = 1_700_000_000_000;

beforeEach(() => {
  bs = openDatabase(':memory:');
  mailer = new CapturingEmailSender();
  now = 1_700_000_000_000;
  auth = new AuthService({
    db: bs,
    email: mailer,
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(['user@brain.test']),
    now: () => now,
  });
  apiKeys = new ApiKeyService({ db: bs, now: () => now });
});

afterEach(() => {
  bs.close();
});

describe('validatePassword', () => {
  it('rejects short passwords', () => {
    expect(validatePassword('Short1!')).toMatch(/at least 12/);
  });
  it('rejects low-complexity passwords', () => {
    expect(validatePassword('alllowercaseyo')).toMatch(/3 of/);
  });
  it('accepts a strong password', () => {
    expect(validatePassword(STRONG)).toBeNull();
  });
});

describe('AuthService signup + email verification', () => {
  it('creates an unverified user and emails a verification link', async () => {
    const result = await auth.signup('user@brain.test', STRONG, 'Fede');
    expect(result.user.emailVerified).toBe(false);
    expect(result.user.hasPassword).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain('https://brain.test/auth/verify-email?token=');

    const verified = auth.consumeEmailVerification(result.verification.token);
    expect(verified.emailVerified).toBe(true);
  });

  it('refuses duplicate emails', async () => {
    await auth.signup('user@brain.test', STRONG);
    await expect(auth.signup('user@brain.test', STRONG)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('rejects weak passwords', async () => {
    await expect(auth.signup('user@brain.test', 'tooweak')).rejects.toBeInstanceOf(AppError);
  });

  it('enforces the authorized-emails allowlist', async () => {
    await expect(auth.signup('intruder@brain.test', STRONG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects expired verification tokens', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    now += 25 * 60 * 60 * 1000;
    expect(() => auth.consumeEmailVerification(verification.token)).toThrow(AppError);
  });

  it('refuses to reuse a verification token', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    expect(() => auth.consumeEmailVerification(verification.token)).toThrow(/already used/);
  });
});

describe('AuthService login', () => {
  it('succeeds for a verified user with the right password', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const result = await auth.login('user@brain.test', STRONG);
    expect(result.user.id).toBeTruthy();
    expect(auth.validateSession(result.session.token)?.id).toBe(result.user.id);
  });

  it('rejects an unverified user', async () => {
    await auth.signup('user@brain.test', STRONG);
    await expect(auth.login('user@brain.test', STRONG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects a wrong password with the same error as a missing account', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const bad = await auth.login('user@brain.test', 'WrongPass!1234').catch((e) => e);
    const missing = await auth.login('ghost@brain.test', 'WhateverPass!12').catch((e) => e);
    expect(bad).toBeInstanceOf(AppError);
    expect(missing).toBeInstanceOf(AppError);
    expect((bad as AppError).code).toBe('UNAUTHORIZED');
    expect((missing as AppError).code).toBe('UNAUTHORIZED');
  });
});

describe('AuthService password reset', () => {
  it('runs the full forgot → reset → login cycle', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const existing = await auth.login('user@brain.test', STRONG);

    const reset = await auth.requestPasswordReset('user@brain.test');
    expect(reset.token).not.toBeNull();
    expect(mailer.sent.at(-1)?.text).toContain('/reset-password?token=');

    const user = await auth.consumePasswordReset(reset.token!, NEW_STRONG);
    expect(user.id).toBeTruthy();

    // Old session was killed during reset.
    expect(auth.validateSession(existing.session.token)).toBeNull();

    await expect(auth.login('user@brain.test', STRONG)).rejects.toBeInstanceOf(AppError);
    const fresh = await auth.login('user@brain.test', NEW_STRONG);
    expect(fresh.user.id).toBe(user.id);
  });

  it('returns a null token for unknown emails (no enumeration)', async () => {
    const result = await auth.requestPasswordReset('ghost@brain.test');
    expect(result.token).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it('rejects an expired reset token', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const reset = await auth.requestPasswordReset('user@brain.test');
    now += 2 * 60 * 60 * 1000;
    await expect(auth.consumePasswordReset(reset.token!, NEW_STRONG)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses to reuse a reset token', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const reset = await auth.requestPasswordReset('user@brain.test');
    await auth.consumePasswordReset(reset.token!, NEW_STRONG);
    await expect(auth.consumePasswordReset(reset.token!, 'YetAn0ther!Pass')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('AuthService Google OAuth linking', () => {
  it('creates a new user when no email match exists', () => {
    const user = auth.upsertGoogleUser({
      googleId: 'g-1',
      email: 'user@brain.test',
      googleEmailVerified: true,
      displayName: 'Fede',
    });
    expect(user.emailVerified).toBe(true);
    expect(user.hasGoogle).toBe(true);
  });

  it('links to a verified local user', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    auth.consumeEmailVerification(verification.token);
    const linked = auth.upsertGoogleUser({
      googleId: 'g-1',
      email: 'user@brain.test',
      googleEmailVerified: true,
    });
    expect(linked.hasGoogle).toBe(true);
    expect(linked.hasPassword).toBe(true);
  });

  it('refuses to link to an unverified local user (takeover risk)', async () => {
    await auth.signup('user@brain.test', STRONG);
    expect(() =>
      auth.upsertGoogleUser({
        googleId: 'g-1',
        email: 'user@brain.test',
        googleEmailVerified: true,
      }),
    ).toThrow(/not verified/);
  });

  it('refuses to link when Google email is not verified', () => {
    expect(() =>
      auth.upsertGoogleUser({
        googleId: 'g-2',
        email: 'user@brain.test',
        googleEmailVerified: false,
      }),
    ).toThrow(/unverified/);
  });
});

describe('AuthService sessions', () => {
  it('creates, validates and revokes a session', () => {
    const user = auth.ensureUser('user@brain.test');
    const session = auth.createSession(user.id);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(auth.validateSession(session.token)?.id).toBe(user.id);
    auth.revokeSession(session.token);
    expect(auth.validateSession(session.token)).toBeNull();
  });

  it('revokes all sessions for a user', () => {
    const user = auth.ensureUser('user@brain.test');
    const a = auth.createSession(user.id);
    const b = auth.createSession(user.id);
    auth.revokeAllSessionsFor(user.id);
    expect(auth.validateSession(a.token)).toBeNull();
    expect(auth.validateSession(b.token)).toBeNull();
  });
});

describe('ApiKeyService', () => {
  it('creates a key that validates by token and is shown only once', () => {
    const user = auth.ensureUser('user@brain.test');
    const created = apiKeys.create(user.id, 'Claude Code', ['notes:read']);
    expect(created.token).toMatch(/^bs_/);
    expect(created.prefix).toBe(created.token.slice(0, 9));

    const validated = apiKeys.validate(created.token);
    expect(validated?.id).toBe(created.id);
    expect(validated?.scopes).toEqual(['notes:read']);
  });

  it('returns null on invalid or revoked tokens', () => {
    const user = auth.ensureUser('user@brain.test');
    const created = apiKeys.create(user.id, 'Test');
    apiKeys.revoke(created.id);
    expect(apiKeys.validate(created.token)).toBeNull();
    expect(apiKeys.validate('bs_invalid')).toBeNull();
  });

  it('lists keys for a user, newest first', () => {
    const user = auth.ensureUser('user@brain.test');
    apiKeys.create(user.id, 'Old');
    now += 1000;
    apiKeys.create(user.id, 'New');
    const list = apiKeys.list(user.id);
    expect(list.map((k) => k.name)).toEqual(['New', 'Old']);
  });
});
