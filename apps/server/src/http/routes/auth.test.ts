// /auth routes that call into the store, against a real Postgres (PGlite).
//
// The store went async when it moved to Postgres, and a handful of these
// routes kept calling it as if it were not. Nothing failed loudly: the API key
// routes answered `{}`, a refused Google unlink answered "ok" while its
// rejection went unhandled, and logout returned before the session was gone.

import type { Hono } from 'hono';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLoginRateLimiter } from '../../lib/rateLimitLogin.js';
import { ApiKeyService } from '../../services/ApiKeyService.js';
import { AuthService } from '../../services/AuthService.js';
import { CapturingEmailSender } from '../../services/EmailSender.js';
import { createTestDatabase, type TestDatabase } from '../../services/testDb.js';
import { SESSION_COOKIE, type AuthBindings } from '../middleware/auth.js';

import { createAuthRouter } from './auth.js';

const logger = pino({ level: 'silent' });

let database: TestDatabase;
let auth: AuthService;
let router: Hono<AuthBindings>;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  auth = new AuthService({
    db: database.db,
    email: new CapturingEmailSender(),
    logger,
    publicOrigin: 'https://brain.test',
    authorizedEmails: new Set(),
  });
  router = createAuthRouter({
    auth,
    apiKeys: new ApiKeyService({ db: database.db }),
    resolveUser: () => {
      throw new Error('no API key reaches these routes');
    },
    logger,
    loginLimiter: createLoginRateLimiter(),
    secureCookies: false,
    appHome: 'https://brain.test',
  });
});

/** A signed-in user with no password, as Google sign-in leaves one. */
async function signedIn(): Promise<{ token: string; cookie: string }> {
  const user = await auth.ensureUser('user@brain.test');
  const { token } = await auth.createSession(user.id);
  return { token, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('API key routes', () => {
  it('are not served over REST — tRPC is the only way to manage keys', async () => {
    const { cookie } = await signedIn();
    const headers = { cookie, 'content-type': 'application/json' };

    for (const [method, path] of [
      ['GET', '/api-keys'],
      ['POST', '/api-keys'],
      ['DELETE', '/api-keys/some-id'],
    ] as const) {
      const res = await router.request(path, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify({ name: 'k' }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('POST /google/unlink', () => {
  it('reports the refusal to unlink an account with no password', async () => {
    const { cookie } = await signedIn();

    const res = await router.request('/google/unlink', { method: 'POST', headers: { cookie } });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('POST /logout', () => {
  it('has invalidated the session by the time it answers', async () => {
    const { token } = await signedIn();

    const res = await router.request('/logout', {
      method: 'POST',
      headers: { 'x-session-token': token },
    });

    expect(res.status).toBe(200);
    expect(await auth.validateSession(token)).toBeNull();
  });
});

describe('auth links', () => {
  // A verification or reset link is the account. It goes to the inbox and
  // nowhere else: not into the response, and not into the server log.
  it('never appear in a response or in the log', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'trace' }, { write: (line: string) => lines.push(line) });
    const email = new CapturingEmailSender();
    const service = new AuthService({
      db: database.db,
      email,
      logger: capturing,
      publicOrigin: 'http://localhost',
      authorizedEmails: new Set(),
    });
    const r = createAuthRouter({
      auth: service,
      apiKeys: new ApiKeyService({ db: database.db }),
      resolveUser: () => {
        throw new Error('no API key reaches these routes');
      },
      logger: capturing,
      loginLimiter: createLoginRateLimiter(),
      secureCookies: false,
      appHome: 'http://localhost',
    });
    const post = (path: string, body: unknown) =>
      r.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const bodies = [
      await (await post('/signup', { email: 'a@brain.test', password: 'Passw0rd!xyz' })).text(),
      await (await post('/resend-verification', { email: 'a@brain.test' })).text(),
      await (await post('/forgot-password', { email: 'a@brain.test' })).text(),
    ];

    const tokens = email.sent.map((m) => /token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1]);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    for (const token of tokens) {
      expect(token).toBeTruthy();
      for (const body of bodies) expect(body).not.toContain(token!);
      for (const line of lines) expect(line).not.toContain(token!);
    }
  });
});
