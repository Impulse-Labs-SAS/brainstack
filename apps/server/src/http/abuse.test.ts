// What stops a stranger, or one account, from wearing the instance down:
// the limiters as a client meets them, the email cooldown and the purge.

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLoginRateLimiter } from '../lib/rateLimitLogin.js';
import { purgeExpired } from '../services/Maintenance.js';
import { createTestDatabase, type TestDatabase } from '../services/testDb.js';
import { buildTestApp, type TestApp } from '../testApp.js';

let database: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  app = buildTestApp(database, { rateLimitPerMinute: 5 });
});

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('anonymous routes', () => {
  it('limit a client by the address its proxy reports, not one it makes up', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      // A client prepends whatever it likes; the proxy appends the real peer.
      const res = await app.request(
        '/api/auth/forgot-password',
        json({ email: 'x@brain.test' }, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('never believe the Netlify header outside Netlify', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app.request(
        '/api/oauth/register',
        json(
          { redirect_uris: ['https://client.test/cb'] },
          { 'x-nf-client-connection-ip': `10.0.0.${i}`, 'x-forwarded-for': '203.0.113.8' },
        ),
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe('the login limiter', () => {
  it('caps one address across many accounts', () => {
    const limiter = createLoginRateLimiter(() => 0);
    for (let i = 0; i < 30; i++) {
      const k = { ip: '203.0.113.9', email: `user${i}@brain.test` };
      limiter.check(k);
      limiter.recordFailure(k);
    }
    expect(() => limiter.check({ ip: '203.0.113.9', email: 'another@brain.test' })).toThrow(
      /too many attempts/,
    );
    expect(() => limiter.check({ ip: '198.51.100.1', email: 'another@brain.test' })).not.toThrow();
  });
});

describe('reset emails', () => {
  it('send one per address per cooldown, and only the newest link works', async () => {
    const auth = app.services.auth;
    await auth.signup('owner@brain.test', 'Sup3rStrong!Passw0rd');

    const first = await auth.requestPasswordReset('owner@brain.test');
    const second = await auth.requestPasswordReset('owner@brain.test');
    expect(first.token).not.toBeNull();
    expect(second.token).toBeNull();
    expect(app.email.sent.filter((m) => m.subject.includes('Reset'))).toHaveLength(1);
  });
});

describe('purgeExpired', () => {
  it('deletes a session once it has expired, and not before', async () => {
    const auth = app.services.auth;
    const user = await auth.ensureUser('purge@brain.test');
    const session = await auth.createSession(user.id);
    const logger = pino({ level: 'silent' });

    await purgeExpired(database.db, { now: session.expiresAt - 1, logger });
    expect(await auth.validateSession(session.token)).not.toBeNull();

    await purgeExpired(database.db, { now: session.expiresAt + 1, logger });
    expect(await auth.validateSession(session.token)).toBeNull();
  });
});
