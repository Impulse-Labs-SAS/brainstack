// A read-only API key, through the whole app: it reads, and every route that
// changes something refuses it — tRPC and MCP alike.

import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../services/testDb.js';
import { buildTestApp, type TestApp } from '../testApp.js';

let database: TestDatabase;
let app: TestApp;
let readOnly: string;
let full: string;

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  app = buildTestApp(database);
  const { id } = await app.signIn('keyholder');
  await app.services.notes.create(id, 'Atlas/plan.md', '# Atlas plan');
  readOnly = (await app.services.apiKeys.create(id, 'reader', ['notes:read'])).token;
  full = (await app.services.apiKeys.create(id, 'writer')).token;
});

const trpc = (token: string, procedure: string, input: unknown, method: 'GET' | 'POST') =>
  method === 'GET'
    ? app.request(
        `/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
        { headers: { authorization: `Bearer ${token}` } },
      )
    : app.request(`/api/trpc/${procedure}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(superjson.serialize(input)),
      });

const mcpCall = async (token: string, name: string, args: Record<string, unknown>) => {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return res.text();
};

describe('a read-only API key', () => {
  it('reads over tRPC, and is refused every change', async () => {
    expect((await trpc(readOnly, 'notes.get', { path: 'Atlas/plan.md' }, 'GET')).status).toBe(200);
    expect(
      (await trpc(readOnly, 'notes.create', { path: 'Atlas/new.md', content: '# x' }, 'POST')).status,
    ).toBe(403);
    expect(
      (await trpc(readOnly, 'notes.remove', { path: 'Atlas/plan.md' }, 'POST')).status,
    ).toBe(403);
    // Gathering context is sent as a mutation but only reads.
    expect(
      (await trpc(readOnly, 'notes.gatherContext', { text: 'Atlas plan' }, 'POST')).status,
    ).toBe(200);
  });

  it('reads over MCP, and is refused every change', async () => {
    expect(await mcpCall(readOnly, 'get_note', { path: 'Atlas/plan.md' })).toContain('Atlas plan');
    const refused = await mcpCall(readOnly, 'create_note', { path: 'Atlas/new.md', content: 'x' });
    expect(refused).toContain('read-only');
    expect(await app.services.notes.exists((await app.signIn('keyholder')).id, 'Atlas/new.md')).toBe(
      false,
    );
  });

  it('leaves a key without scopes, and one with notes:write, able to write', async () => {
    expect(
      (await trpc(full, 'notes.create', { path: 'Atlas/new.md', content: '# x' }, 'POST')).status,
    ).toBe(200);
    expect(await mcpCall(full, 'create_note', { path: 'Atlas/other.md', content: 'x' })).not.toContain(
      'read-only',
    );
  });

  it('cannot be asked for with a scope that means nothing', async () => {
    const { cookie } = await app.signIn('keyholder');
    const res = await app.request('/api/trpc/apiKeys.create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(superjson.serialize({ name: 'x', scopes: ['admin'] })),
    });
    expect(res.status).toBe(400);
  });
});
