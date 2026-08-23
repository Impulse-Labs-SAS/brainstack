import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { AppError } from '../lib/errors.js';

import { ApiKeyService } from './ApiKeyService.js';
import { AuthService, validatePassword } from './AuthService.js';
import { CapturingEmailSender } from './EmailSender.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const logger = pino({ level: 'silent' });
const STRONG = 'Sup3rStrong!Passw0rd';
const NEW_STRONG = 'An0ther!StrongerPass';

let database: TestDatabase;
let auth: AuthService;
let apiKeys: ApiKeyService;
let mailer: CapturingEmailSender;
let now = 1_700_000_000_000;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  mailer = new CapturingEmailSender();
  now = 1_700_000_000_000;
  auth = new AuthService({
    db: database.db,
    email: mailer,
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(['user@brain.test']),
    now: () => now,
  });
  apiKeys = new ApiKeyService({ db: database.db, now: () => now });
});

describe('validatePassword', () => {
  it('rejects short passwords', async () => {
    expect(validatePassword('Sh0rt!')).toMatch(/at least 8/);
  });
  it('rejects low-complexity passwords', async () => {
    expect(validatePassword('alllowercaseyo')).toMatch(/3 of/);
  });
  it('accepts a strong password', async () => {
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

    const verified = await auth.consumeEmailVerification(result.verification.token);
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
    await expect(auth.consumeEmailVerification(verification.token)).rejects.toThrow(AppError);
  });

  it('refuses to reuse a verification token', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    await auth.consumeEmailVerification(verification.token);
    await expect(auth.consumeEmailVerification(verification.token)).rejects.toThrow(/already used/);
  });
});

describe('AuthService login', () => {
  it('succeeds for a verified user with the right password', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    await auth.consumeEmailVerification(verification.token);
    const result = await auth.login('user@brain.test', STRONG);
    expect(result.user.id).toBeTruthy();
    expect((await auth.validateSession(result.session.token))?.id).toBe(result.user.id);
  });

  it('rejects an unverified user', async () => {
    await auth.signup('user@brain.test', STRONG);
    await expect(auth.login('user@brain.test', STRONG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects a wrong password with the same error as a missing account', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    await auth.consumeEmailVerification(verification.token);
    const bad = await auth.login('user@brain.test', 'WrongPass!1234').catch((e: unknown) => e);
    const missing = await auth
      .login('ghost@brain.test', 'WhateverPass!12')
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(AppError);
    expect(missing).toBeInstanceOf(AppError);
    expect((bad as AppError).code).toBe('UNAUTHORIZED');
    expect((missing as AppError).code).toBe('UNAUTHORIZED');
  });
});

describe('AuthService password reset', () => {
  it('runs the full forgot → reset → login cycle', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    await auth.consumeEmailVerification(verification.token);
    const existing = await auth.login('user@brain.test', STRONG);

    const reset = await auth.requestPasswordReset('user@brain.test');
    expect(reset.token).not.toBeNull();
    expect(mailer.sent.at(-1)?.text).toContain('/reset-password?token=');

    const user = await auth.consumePasswordReset(reset.token!, NEW_STRONG);
    expect(user.id).toBeTruthy();

    // Old session was killed during reset.
    expect(await auth.validateSession(existing.session.token)).toBeNull();

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
    await auth.consumeEmailVerification(verification.token);
    const reset = await auth.requestPasswordReset('user@brain.test');
    now += 2 * 60 * 60 * 1000;
    await expect(auth.consumePasswordReset(reset.token!, NEW_STRONG)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses to reuse a reset token', async () => {
    const { verification } = await auth.signup('user@brain.test', STRONG);
    await auth.consumeEmailVerification(verification.token);
    const reset = await auth.requestPasswordReset('user@brain.test');
    await auth.consumePasswordReset(reset.token!, NEW_STRONG);
    await expect(auth.consumePasswordReset(reset.token!, 'YetAn0ther!Pass')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('AuthService Google OAuth linking', () => {
  it('creates a new user when no email match exists', async () => {
    const user = await auth.upsertGoogleUser({
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
    await auth.consumeEmailVerification(verification.token);
    const linked = await auth.upsertGoogleUser({
      googleId: 'g-1',
      email: 'user@brain.test',
    googleEmailVerified: true,
    });
    expect(linked.hasGoogle).toBe(true);
    expect(linked.hasPassword).toBe(true);
  });

  it('refuses to link to an unverified local user (takeover risk)', async () => {
    await auth.signup('user@brain.test', STRONG);
    await expect(
      auth.upsertGoogleUser({
        googleId: 'g-1',
        email: 'user@brain.test',
        googleEmailVerified: true,
      }),
    ).rejects.toThrow(/not verified/);
  });

  it('refuses to link when Google email is not verified', async () => {
    await expect(
      auth.upsertGoogleUser({
        googleId: 'g-2',
        email: 'user@brain.test',
        googleEmailVerified: false,
      }),
    ).rejects.toThrow(/unverified/);
  });
});

describe('AuthService sessions', () => {
  it('creates, validates and revokes a session', async () => {
    const user = await auth.ensureUser('user@brain.test');
    const session = await auth.createSession(user.id);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await auth.validateSession(session.token))?.id).toBe(user.id);
    await auth.revokeSession(session.token);
    expect(await auth.validateSession(session.token)).toBeNull();
  });

  it('revokes all sessions for a user', async () => {
    const user = await auth.ensureUser('user@brain.test');
    const a = await auth.createSession(user.id);
    const b = await auth.createSession(user.id);
    await auth.revokeAllSessionsFor(user.id);
    expect(await auth.validateSession(a.token)).toBeNull();
    expect(await auth.validateSession(b.token)).toBeNull();
  });
});

describe('ApiKeyService', () => {
  it('creates a key that validates by token and is shown only once', async () => {
    const user = await auth.ensureUser('user@brain.test');
    const created = await apiKeys.create(user.id, 'Claude Code', ['notes:read']);
    expect(created.token).toMatch(/^bs_/);
    expect(created.prefix).toBe(created.token.slice(0, 9));

    const validated = await apiKeys.validate(created.token);
    expect(validated?.id).toBe(created.id);
    expect(validated?.scopes).toEqual(['notes:read']);
  });

  it('returns null on invalid or revoked tokens', async () => {
    const user = await auth.ensureUser('user@brain.test');
    const created = await apiKeys.create(user.id, 'Test');
    await apiKeys.revoke(created.id);
    expect(await apiKeys.validate(created.token)).toBeNull();
    expect(await apiKeys.validate('bs_invalid')).toBeNull();
  });

  it('lists keys for a user, newest first', async () => {
    const user = await auth.ensureUser('user@brain.test');
    apiKeys.create(user.id, 'Old');
    now += 1000;
    apiKeys.create(user.id, 'New');
    const list = await apiKeys.list(user.id);
    expect(list.map((k) => k.name)).toEqual(['New', 'Old']);
  });
});

describe('AuthService accounts with no password', () => {
  // These exist because the Netlify line signed people in with magic links and
  // never stored a hash. Without this path they cannot sign in at all: signup
  // rejects them as existing, and a reset had nothing to reset.
  it('lets an account created without a password set one, and verifies it', async () => {
    const seeded = await auth.ensureUser('user@brain.test');
    expect(seeded.hasPassword).toBe(false);
    expect(seeded.emailVerified).toBe(false);

    const reset = await auth.requestPasswordReset('user@brain.test');
    expect(reset.token).not.toBeNull();

    const after = await auth.consumePasswordReset(reset.token!, STRONG);
    expect(after.hasPassword).toBe(true);
    // Opening the link proved control of the address.
    expect(after.emailVerified).toBe(true);

    const { user } = await auth.login('user@brain.test', STRONG);
    expect(user.id).toBe(seeded.id);
  });

  it('still says nothing about an address that has no account', async () => {
    const reset = await auth.requestPasswordReset('nobody@brain.test');
    expect(reset).toMatchObject({ token: null, url: null });
  });
});

describe('AuthService link destinations', () => {
  // Three links, two destinations. Getting this backwards is what made the
  // magic link 404 in production: a page link built from the API's origin.
  it('sends verification to the endpoint and reset to the page', async () => {
    const withSplitOrigins = new AuthService({
      db: database.db,
      email: mailer,
      logger,
      publicOrigin: 'https://api.brain.test',
      appOrigin: 'https://app.brain.test',
      apiBasePath: '/api',
      authorizedEmails: new Set(),
      now: () => now,
    });

    const { verification } = await withSplitOrigins.signup('user@brain.test', STRONG);
    // Consumed by the server, which redirects to the app afterwards.
    expect(verification.url).toBe(
      `https://api.brain.test/api/auth/verify-email?token=${verification.token}`,
    );

    const reset = await withSplitOrigins.requestPasswordReset('user@brain.test');
    // Opened by a person, so it has to be a page.
    expect(reset.url).toContain('https://app.brain.test/reset-password?token=');
  });
});

describe('ApiKeyService', () => {
  it('deletes a key rather than keeping a revoked one around', async () => {
    const user = await auth.ensureUser('user@brain.test');
    const created = await apiKeys.create(user.id, 'Claude Code', ['notes:read']);

    expect(await apiKeys.validate(created.token)).not.toBeNull();

    await apiKeys.revoke(created.id, user.id);

    // Gone from the listing, not struck through in it.
    expect(await apiKeys.list(user.id)).toEqual([]);
    expect(await apiKeys.validate(created.token)).toBeNull();
  });

  it('refuses to delete a key belonging to somebody else', async () => {
    const mine = await auth.ensureUser('user@brain.test');
    const theirs = await auth.ensureUser('otro@brain.test');
    const key = await apiKeys.create(theirs.id, 'de otro', []);

    await expect(apiKeys.revoke(key.id, mine.id)).rejects.toThrow();
    // Still works for its owner.
    expect(await apiKeys.validate(key.token)).not.toBeNull();
  });
});

describe('AuthService.updateProfile', () => {
  async function verifiedUser(): Promise<string> {
    const { user, verification } = await auth.signup('user@brain.test', STRONG, null);
    await auth.consumeEmailVerification(verification.token);
    return user.id;
  }

  it('sets the display name', async () => {
    const id = await verifiedUser();
    const updated = await auth.updateProfile(id, { displayName: 'Federico Linardelli' });
    expect(updated.displayName).toBe('Federico Linardelli');
    expect((await auth.findUserById(id))?.displayName).toBe('Federico Linardelli');
  });

  it('trims, and stores a blank name as unset rather than as an empty string', async () => {
    const id = await verifiedUser();
    expect((await auth.updateProfile(id, { displayName: '  Fede  ' })).displayName).toBe('Fede');
    expect((await auth.updateProfile(id, { displayName: '   ' })).displayName).toBeNull();
  });

  it('refuses a name past the column budget', async () => {
    const id = await verifiedUser();
    await expect(auth.updateProfile(id, { displayName: 'x'.repeat(121) })).rejects.toThrow(
      AppError,
    );
  });

  it('leaves the name alone when the field is not part of the patch', async () => {
    const id = await verifiedUser();
    await auth.updateProfile(id, { displayName: 'Fede' });
    expect((await auth.updateProfile(id, {})).displayName).toBe('Fede');
  });

  it('fails on an unknown user', async () => {
    await expect(auth.updateProfile('nope', { displayName: 'x' })).rejects.toThrow(AppError);
  });
});
