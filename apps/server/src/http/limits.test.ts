// What one request may cost: every limit asserted through the whole app, the
// way a client meets it.

import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_NOTE_CHARS, MAX_SMALL_BODY_BYTES, MAX_TRPC_BATCH } from '../config/limits.js';
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

function trpcPost(cookie: string, procedure: string, input: unknown): Promise<Response> {
  return app.request(`/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize(input)),
  });
}

describe('request bodies', () => {
  it('refuses an oversized body on a route that never carries a note', async () => {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(MAX_SMALL_BODY_BYTES) }),
    });
    expect(res.status).toBe(413);
  });

  it('accepts a full-sized note over tRPC and refuses one past the limit', async () => {
    const { cookie } = await app.signIn('writer');

    const fits = await trpcPost(cookie, 'notes.create', {
      path: 'big.md',
      content: 'a '.repeat(100_000),
    });
    expect(fits.status).toBe(200);

    const tooBig = await trpcPost(cookie, 'notes.create', {
      path: 'huge.md',
      content: 'a'.repeat(MAX_NOTE_CHARS + 1),
    });
    expect(tooBig.status).toBe(400);
  });

  it('refuses a path longer than a key can hold', async () => {
    const { cookie } = await app.signIn('writer');
    const res = await trpcPost(cookie, 'notes.create', { path: `${'a'.repeat(1100)}.md`, content: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('tRPC batches', () => {
  it('refuses a batch larger than the cap', async () => {
    const { cookie } = await app.signIn('reader');
    const calls = MAX_TRPC_BATCH + 1;
    const names = Array.from({ length: calls }, () => 'notes.tags').join(',');
    const input = encodeURIComponent(
      JSON.stringify(Object.fromEntries(Array.from({ length: calls }, (_, i) => [i, {}]))),
    );
    const res = await app.request(`/api/trpc/${names}?batch=1&input=${input}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });
});
