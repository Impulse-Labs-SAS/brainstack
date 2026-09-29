// Who may create an account, and what an instance without email can still do.
//
// Sign-up is closed unless the operator opens it: the first account is the
// instance's owner, and after that only OPEN_SIGNUP, AUTHORIZED_EMAILS or a
// pending email invitation let anyone else in. An instance nobody configured
// is not a free account for whoever finds its address.

import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService, type AuthServiceOptions } from './AuthService.js';
import {
  CapturingEmailSender,
  createEmailSender,
  ResendEmailSender,
  SmtpEmailSender,
} from './EmailSender.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { folderShareInvites, passwordResetTokens, users } = pgSchema;

const logger = pino({ level: 'silent' });
const STRONG = 'Sup3rStrong!Passw0rd';
const NOW = 1_700_000_000_000;

let database: TestDatabase;
let mailer: CapturingEmailSender;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  mailer = new CapturingEmailSender();
});

function authWith(overrides: Partial<AuthServiceOptions> = {}): AuthService {
  return new AuthService({
    db: database.db,
    email: mailer,
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(),
    now: () => NOW,
    ...overrides,
  });
}

async function userCount(): Promise<number> {
  return (await database.db.select({ id: users.id }).from(users)).length;
}

describe('the first account', () => {
  it('is created verified, without sending anything', async () => {
    const { user, verification } = await authWith().signup('owner@brain.test', STRONG);
    expect(user.emailVerified).toBe(true);
    expect(verification).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it('needs no email configured', async () => {
    const auth = authWith({ email: null });
    await auth.signup('owner@brain.test', STRONG);
    expect((await auth.login('owner@brain.test', STRONG)).user.email).toBe('owner@brain.test');
  });

  it('must be on AUTHORIZED_EMAILS when that is set', async () => {
    const auth = authWith({ authorizedEmails: new Set(['owner@brain.test']) });
    await expect(auth.signup('someone@brain.test', STRONG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await auth.signup('owner@brain.test', STRONG);
  });
});

describe('every account after the first', () => {
  it('is refused by default', async () => {
    const auth = authWith();
    await auth.signup('owner@brain.test', STRONG);
    await expect(auth.signup('stranger@brain.test', STRONG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await userCount()).toBe(1);
  });

  it('is let in by OPEN_SIGNUP, and verified by email', async () => {
    const auth = authWith({ openSignup: true });
    await auth.signup('owner@brain.test', STRONG);
    const { user, verification } = await auth.signup('guest@brain.test', STRONG);
    expect(user.emailVerified).toBe(false);
    expect(verification).not.toBeNull();
    expect(mailer.sent).toHaveLength(1);
  });

  it('is let in by AUTHORIZED_EMAILS', async () => {
    const auth = authWith({ authorizedEmails: new Set(['owner@brain.test', 'pablo@brain.test']) });
    await auth.signup('owner@brain.test', STRONG);
    await auth.signup('Pablo@Brain.test', STRONG);
    expect(await userCount()).toBe(2);
  });

  it('is let in by a pending email invitation, and only a pending one', async () => {
    const auth = authWith();
    const { user: owner } = await auth.signup('owner@brain.test', STRONG);
    const invite = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
      id,
      folderPath: 'Shared',
      ownerId: owner.id,
      mode: 'email' as const,
      inviteeEmail: email,
      tokenHash: id,
      expiresAt: NOW + 60_000,
      createdAt: NOW,
      ...extra,
    });
    await database.db
      .insert(folderShareInvites)
      .values([
        invite('pending', 'Invited@brain.test'),
        invite('expired', 'late@brain.test', { expiresAt: NOW - 1 }),
        invite('revoked', 'revoked@brain.test', { revokedAt: NOW - 1 }),
      ]);

    await auth.signup('invited@brain.test', STRONG);
    for (const email of ['late@brain.test', 'revoked@brain.test']) {
      await expect(auth.signup(email, STRONG)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('is refused when the instance cannot send the verification, before any row exists', async () => {
    const auth = authWith({ email: null, openSignup: true });
    await auth.signup('owner@brain.test', STRONG);
    await expect(auth.signup('guest@brain.test', STRONG)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(await userCount()).toBe(1);
  });
});

describe('signing in', () => {
  // AUTHORIZED_EMAILS decides who may create an account, not who may use one:
  // an invited account is not on the list and still signs in.
  it('does not consult AUTHORIZED_EMAILS', async () => {
    const open = authWith({ openSignup: true });
    await open.signup('owner@brain.test', STRONG);
    const { verification } = await open.signup('guest@brain.test', STRONG);
    await open.consumeEmailVerification(verification!.token);

    const listed = authWith({ authorizedEmails: new Set(['owner@brain.test']) });
    expect((await listed.login('guest@brain.test', STRONG)).user.email).toBe('guest@brain.test');
  });

  it('with Google creates an account only for those who may sign up', async () => {
    const auth = authWith();
    await auth.signup('owner@brain.test', STRONG);
    await expect(
      auth.upsertGoogleUser({
        googleId: 'g1',
        email: 'stranger@brain.test',
        googleEmailVerified: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The owner can still link Google to the account that exists.
    const linked = await auth.upsertGoogleUser({
      googleId: 'g2',
      email: 'owner@brain.test',
      googleEmailVerified: true,
    });
    expect(linked.hasGoogle).toBe(true);
  });
});

describe('without email', () => {
  it('answers a reset request without issuing a link', async () => {
    const auth = authWith({ email: null });
    await auth.signup('owner@brain.test', STRONG);
    expect(await auth.requestPasswordReset('owner@brain.test')).toMatchObject({ url: null });
    expect(await database.db.select().from(passwordResetTokens)).toHaveLength(0);
  });

  it('lets the operator reset a password from the server', async () => {
    const auth = authWith({ email: null });
    await auth.signup('owner@brain.test', STRONG);
    const { session } = await auth.login('owner@brain.test', STRONG);

    const password = await auth.resetPasswordFromServer('owner@brain.test');

    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(await auth.validateSession(session.token)).toBeNull();
    await expect(auth.login('owner@brain.test', STRONG)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect((await auth.login('owner@brain.test', password)).user.email).toBe('owner@brain.test');
  });

  it('refuses an operator reset for an address with no account', async () => {
    await expect(authWith().resetPasswordFromServer('nobody@brain.test')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('createEmailSender', () => {
  const smtp = { host: 'smtp.example.com', port: 587, secure: false };

  it('needs a From address', () => {
    expect(createEmailSender({ resendApiKey: 're_x', smtp })).toBeNull();
  });

  it('is null with nothing to send through', () => {
    expect(createEmailSender({ from: 'brain@example.com' })).toBeNull();
  });

  it('uses SMTP when that is what is configured', () => {
    expect(createEmailSender({ smtp, from: 'brain@example.com' })).toBeInstanceOf(SmtpEmailSender);
  });

  it('prefers Resend when both are configured', () => {
    expect(
      createEmailSender({ resendApiKey: 're_x', smtp, from: 'brain@example.com' }),
    ).toBeInstanceOf(ResendEmailSender);
  });
});
