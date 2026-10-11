// What every response says about itself, and what a failure lets out: headers,
// readiness, and error bodies, through the whole app.

import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  app = buildTestApp(database);
});

const trpcQuery = (cookie: string, procedure: string, input: unknown) =>
  app.request(
    `/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
    { headers: { cookie } },
  );

const trpcPost = (cookie: string, procedure: string, input: unknown) =>
  app.request(`/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize(input)),
  });

describe('response headers', () => {
  it('forbid framing and sniffing, and carry a request id', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('readiness', () => {
  it('says whether the database answers', async () => {
    const up = buildTestApp(database, { ping: async () => {} });
    expect((await up.request('/api/health/ready')).status).toBe(200);

    const down = buildTestApp(database, {
      ping: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      },
    });
    const res = await down.request('/api/health/ready');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('10.0.0.5');
  });
});

describe('a failure the caller did not cause', () => {
  it('reaches an auth route as a fixed message, not the driver’s', async () => {
    app.services.auth.signup = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    };
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@brain.test', password: 'a-long-password-123' }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('10.0.0.5');
  });

  it('reaches tRPC as "internal error"', async () => {
    const { cookie } = await app.signIn('writer');
    app.services.notes.list = async () => {
      throw new Error('relation "secret_table" does not exist');
    };
    const res = await trpcQuery(cookie, 'notes.list', {});
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('secret_table');
    expect(body).toContain('internal error');
  });
});

describe('a refusal', () => {
  it('is a 403 from every procedure, not a 500 from the ones that forgot to map it', async () => {
    const alice = await app.signIn('alice');
    const bob = await app.signIn('bob');
    await trpcPost(alice.cookie, 'notes.create', { path: 'Private/diary.md', content: '# Diary' });

    const res = await trpcQuery(bob.cookie, 'notes.backlinks', {
      path: 'Private/diary.md',
      ownerId: alice.id,
    });
    expect(res.status).toBe(403);
  });

  it('is a 404 for a note that is not there', async () => {
    const { cookie } = await app.signIn('writer');
    const res = await trpcQuery(cookie, 'notes.get', { path: 'nowhere.md' });
    expect(res.status).toBe(404);
  });

  it('is a 400 for a note with a NUL in it, which Postgres would refuse', async () => {
    const { cookie } = await app.signIn('writer');
    const res = await trpcPost(cookie, 'notes.create', { path: 'nul.md', content: 'a\u0000b' });
    expect(res.status).toBe(400);
  });
});
