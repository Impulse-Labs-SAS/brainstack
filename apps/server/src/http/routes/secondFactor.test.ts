// The second factor holds on every way into an account, not only the password
// form. A reset link and a Google sign-in each prove control of the email
// address; with TOTP on, that alone must not open a session.

import { decodeBase32 } from '@oslojs/encoding';
import { generateTOTP } from '@oslojs/otp';
import { Hono } from 'hono';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLoginRateLimiter } from '../../lib/rateLimitLogin.js';
import { ApiKeyService } from '../../services/ApiKeyService.js';
import { AuthService } from '../../services/AuthService.js';
import { CapturingEmailSender } from '../../services/EmailSender.js';
import type { GoogleOAuthService } from '../../services/GoogleOAuthService.js';
import { TotpService } from '../../services/TotpService.js';
import { createTestDatabase, type TestDatabase } from '../../services/testDb.js';
import { SESSION_COOKIE, type AuthBindings } from '../middleware/auth.js';

import { createAuthRouter } from './auth.js';
import { SECOND_FACTOR_COOKIE, createOAuthGoogleRouter } from './oauthGoogle.js';

const STRONG = 'Sup3rStrong!Passw0rd';
const NEWER = 'An0ther!Strong-Passw0rd';
const EMAIL = 'person@brain.test';
const logger = pino({ level: 'silent' });

let database: TestDatabase;
let auth: AuthService;
let totp: TotpService;
let app: Hono<AuthBindings>;
let now = 1_700_000_000_000;

/** A Google that always answers with the same verified profile. */
const google = {
  startAuthorization: async () => ({ url: 'https://accounts.google.test/', state: 's' }),
  completeAuthorization: async () => ({
    profile: { googleId: 'g-1', email: EMAIL, emailVerified: true, name: 'Person' },
    redirectTo: '/notes/a',
  }),
} as unknown as GoogleOAuthService;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  now = 1_700_000_000_000;
  totp = new TotpService({ db: database.db, issuer: 'BrainStack', now: () => now });
  auth = new AuthService({
    db: database.db,
    email: new CapturingEmailSender(),
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(),
    openSignup: true,
    totp,
    now: () => now,
  });
  // The first account is the owner and skips verification; reuse that.
  await auth.signup(EMAIL, STRONG);

  app = new Hono<AuthBindings>();
  app.route(
    '/auth',
    createAuthRouter({
      auth,
      apiKeys: new ApiKeyService({ db: database.db }),
      resolveUser: () => {
        throw new Error('no API key reaches these routes');
      },
      logger,
      loginLimiter: createLoginRateLimiter(),
      secureCookies: false,
      appHome: 'https://brain.test',
      trustedProxy: 'proxy',
    }),
  );
  app.route(
    '/auth',
    createOAuthGoogleRouter({
      google,
      auth,
      logger,
      secureCookies: false,
      appHome: 'https://brain.test',
      trustedProxy: 'proxy',
    }),
  );
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

async function enableTotp(): Promise<string> {
  const user = await auth.findUserByEmail(EMAIL);
  const { secret } = totp.beginEnrollment(EMAIL);
  await totp.confirmEnrollment(user!.id, secret, codeFor(secret));
  // The enrollment code is spent; the next one comes from a later step.
  now += 30_000;
  return secret;
}

function post(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function cookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [key, value] = (pair ?? '').split('=');
    if (key === name && value) return value;
  }
  return null;
}

async function resetToken(): Promise<string> {
  const { token } = await auth.requestPasswordReset(EMAIL);
  return token!;
}

describe('POST /auth/reset-password', () => {
  it('signs in an account without a second factor, as before', async () => {
    const res = await post('/auth/reset-password', { token: await resetToken(), password: NEWER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signedIn: true });
    expect(cookieValue(res, SESSION_COOKIE)).not.toBeNull();
  });

  it('changes the password but opens no session when the account has TOTP', async () => {
    const secret = await enableTotp();
    const res = await post('/auth/reset-password', { token: await resetToken(), password: NEWER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signedIn: false });
    expect(cookieValue(res, SESSION_COOKIE)).toBeNull();

    // The new password works, and still asks for the code.
    const without = await post('/auth/login', { email: EMAIL, password: NEWER });
    expect(without.status).toBe(401);
    const withCode = await post('/auth/login', {
      email: EMAIL,
      password: NEWER,
      totpCode: codeFor(secret),
    });
    expect(withCode.status).toBe(200);
  });
});

describe('Google sign-in', () => {
  async function callback(): Promise<Response> {
    return app.request('/auth/google/callback?code=c&state=s');
  }

  it('signs in an account without a second factor, as before', async () => {
    const res = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://brain.test/notes/a');
    expect(cookieValue(res, SESSION_COOKIE)).not.toBeNull();
    expect(cookieValue(res, SECOND_FACTOR_COOKIE)).toBeNull();
  });

  it('holds the sign-in for the code when the account has TOTP', async () => {
    await enableTotp();
    const res = await callback();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('second_factor')).toBe('google');
    expect(location.searchParams.get('redirect_to')).toBe('/notes/a');
    expect(cookieValue(res, SESSION_COOKIE)).toBeNull();
    expect(cookieValue(res, SECOND_FACTOR_COOKIE)).not.toBeNull();
  });

  it('opens the session once the right code arrives, and only once', async () => {
    const secret = await enableTotp();
    const challenge = cookieValue(await callback(), SECOND_FACTOR_COOKIE)!;
    const cookie = `${SECOND_FACTOR_COOKIE}=${challenge}`;

    const wrong = await post('/auth/google/second-factor', { code: '000000' }, cookie);
    expect(wrong.status).toBe(401);
    expect(cookieValue(wrong, SESSION_COOKIE)).toBeNull();

    // A wrong code leaves the challenge for another try.
    const right = await post('/auth/google/second-factor', { code: codeFor(secret) }, cookie);
    expect(right.status).toBe(200);
    const session = cookieValue(right, SESSION_COOKIE);
    expect(session).not.toBeNull();
    expect(await auth.validateSession(session!)).toMatchObject({ email: EMAIL });

    now += 30_000;
    const again = await post('/auth/google/second-factor', { code: codeFor(secret) }, cookie);
    expect(again.status).toBe(401);
  });

  it('refuses the code without the cookie, or after the challenge expires', async () => {
    const secret = await enableTotp();
    const none = await post('/auth/google/second-factor', { code: codeFor(secret) });
    expect(none.status).toBe(401);

    const challenge = cookieValue(await callback(), SECOND_FACTOR_COOKIE)!;
    now += 11 * 60 * 1000;
    const late = await post(
      '/auth/google/second-factor',
      { code: codeFor(secret) },
      `${SECOND_FACTOR_COOKIE}=${challenge}`,
    );
    expect(late.status).toBe(401);
    expect(cookieValue(late, SESSION_COOKIE)).toBeNull();
  });
});
