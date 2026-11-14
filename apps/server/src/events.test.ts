// Events, through a booted app: each change is reported once, after it lands,
// with the vault it happened in, who did it and through what — web, API key or
// MCP — and a listener that fails changes nothing about the write.

import pino from 'pino';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBrainStack, type BrainStack } from './boot.js';
import { _resetConfigForTests, loadConfig } from './config/env.js';
import type { BrainStackEvent } from './events.js';
import { SESSION_COOKIE } from './http/middleware/auth.js';
import type { BrainStackPlugin } from './plugin.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const logger = pino({ level: 'silent' });
let database: TestDatabase;
let bs: BrainStack;
let events: BrainStackEvent[];

const listener: BrainStackPlugin = {
  name: 'listener',
  onEvent: (e) => void events.push(e),
};

const boot = (plugins: BrainStackPlugin[]) =>
  createBrainStack({
    config: loadConfig(),
    logger,
    plugins,
    database: { db: database.db, close: async () => undefined },
  });

const request = (path: string, init?: RequestInit) =>
  Promise.resolve(bs.app.fetch(new Request(`http://test/api${path}`, init)));

const trpc = (procedure: string, input: unknown, headers: Record<string, string>) =>
  request(`/trpc/${procedure}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize(input)),
  });

const mcpCall = (token: string, name: string, args: Record<string, unknown>) =>
  request('/mcp', {
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
  }).then((r) => r.text());

/** A signed-in person: id and a cookie header. */
async function person(email: string) {
  const user = await bs.services.auth.ensureUser(email);
  const { token } = await bs.services.auth.createSession(user.id);
  return { id: user.id, cookie: { cookie: `${SESSION_COOKIE}=${token}` } };
}

const pick = (e: BrainStackEvent) => {
  const { at, ...rest } = e;
  expect(typeof at).toBe('number');
  return rest;
};

beforeAll(async () => {
  database = await createTestDatabase();
  process.env.DATABASE_URL ??= 'postgres://unused/unused';
  _resetConfigForTests();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  bs = await boot([listener]);
  events = [];
});

describe('events from the web app', () => {
  it('report each note change once, by whom and through the web', async () => {
    const ana = await person('ana@x.test');
    events = [];

    await trpc('notes.createFolder', { path: 'Orbit' }, ana.cookie);
    await trpc('notes.create', { path: 'Orbit/plan.md', content: '# Plan' }, ana.cookie);
    await trpc('notes.update', { path: 'Orbit/plan.md', content: '# Plan\n\nMore.' }, ana.cookie);
    await trpc('notes.move', { from: 'Orbit/plan.md', to: 'Orbit/roadmap.md' }, ana.cookie);
    await trpc('notes.remove', { path: 'Orbit/roadmap.md' }, ana.cookie);

    const who = { ownerId: ana.id, actorId: ana.id, via: 'web' };
    expect(events.map(pick)).toEqual([
      { type: 'folder.created', path: 'Orbit', ...who },
      { type: 'note.created', path: 'Orbit/plan.md', ...who },
      { type: 'note.updated', path: 'Orbit/plan.md', ...who },
      { type: 'note.moved', from: 'Orbit/plan.md', to: 'Orbit/roadmap.md', ...who },
      { type: 'note.deleted', paths: ['Orbit/roadmap.md'], folders: [], ...who },
    ]);
  });

  it('name the owner and the writer apart in a shared folder', async () => {
    const ana = await person('ana@x.test');
    const bo = await person('bo@x.test');
    await bs.services.notes.createFolder(ana.id, 'Orbit');
    await bs.services.sharing.grant({
      ownerId: ana.id,
      sharedWithUserId: bo.id,
      folderPath: 'Orbit',
      grantedBy: ana.id,
      permission: 'write',
    });
    events = [];

    await trpc('notes.create', { path: 'Orbit/idea.md', content: 'x', ownerId: ana.id }, bo.cookie);
    expect(events.map(pick)).toEqual([
      { type: 'note.created', path: 'Orbit/idea.md', ownerId: ana.id, actorId: bo.id, via: 'web' },
    ]);
  });

  it('report a sign-up and a sign-in with the new account as the actor', async () => {
    const body = { email: 'first@x.test', password: 'Plugin-Test-2026!x' };
    const signup = await request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { user } = (await signup.json()) as { user: { id: string } };
    await request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(events.map(pick)).toEqual([
      { type: 'auth.signed_up', userId: user.id, method: 'password', actorId: user.id, via: 'web' },
      { type: 'auth.signed_in', userId: user.id, actorId: user.id, via: 'web' },
    ]);
  });
});

describe('events from an API key', () => {
  it('say api over tRPC and mcp over MCP', async () => {
    const ana = await person('ana@x.test');
    const { token, id: keyId } = await bs.services.apiKeys.create(ana.id, 'assistant');
    events = [];

    await trpc(
      'notes.create',
      { path: 'a.md', content: 'a' },
      { authorization: `Bearer ${token}` },
    );
    await mcpCall(token, 'create_note', { path: 'b.md', content: 'b' });

    expect(events.map((e) => [e.type, e.actorId, e.via])).toEqual([
      ['note.created', ana.id, 'api'],
      ['note.created', ana.id, 'mcp'],
    ]);
    expect(keyId).toBeTruthy();
  });
});

describe('sharing events', () => {
  it('report a request from an assistant, then the grant and the revoke', async () => {
    const ana = await person('ana@x.test');
    const bo = await person('bo@x.test');
    const { token } = await bs.services.apiKeys.create(ana.id, 'assistant');
    await bs.services.notes.createFolder(ana.id, 'Orbit');
    events = [];

    await mcpCall(token, 'share_folder', {
      path: 'Orbit',
      email: 'bo@x.test',
      permission: 'write',
    });
    await bs.services.sharing.grant({
      ownerId: ana.id,
      sharedWithUserId: bo.id,
      folderPath: 'Orbit',
      grantedBy: ana.id,
      permission: 'write',
    });
    await bs.services.sharing.revoke({
      ownerId: ana.id,
      sharedWithUserId: bo.id,
      folderPath: 'Orbit',
    });

    const where = { ownerId: ana.id, path: 'Orbit' };
    expect(events.map(pick)).toEqual([
      {
        type: 'share.requested',
        ...where,
        email: 'bo@x.test',
        permission: 'write',
        actorId: ana.id,
        via: 'mcp',
      },
      {
        type: 'share.granted',
        ...where,
        userId: bo.id,
        permission: 'write',
        actorId: null,
        via: 'system',
      },
      { type: 'share.revoked', ...where, userId: bo.id, actorId: null, via: 'system' },
    ]);
  });
});

describe('events outside a request', () => {
  it('say system, with no actor unless the service knows one', async () => {
    const ana = await bs.services.auth.ensureUser('ana@x.test');
    events = [];
    await bs.services.notes.create(ana.id, 'c.md', 'c');
    const key = await bs.services.apiKeys.create(ana.id, 'cli', ['notes:read']);

    expect(events.map(pick)).toEqual([
      { type: 'note.created', ownerId: ana.id, path: 'c.md', actorId: null, via: 'system' },
      {
        type: 'api_key.created',
        userId: ana.id,
        keyId: key.id,
        name: 'cli',
        scopes: ['notes:read'],
        actorId: null,
        via: 'system',
      },
    ]);
  });
});

describe('a listener that throws', () => {
  it('leaves the write and its answer as they were', async () => {
    bs = await boot([
      {
        name: 'angry',
        onEvent: () => {
          throw new Error('listener down');
        },
      },
    ]);
    const ana = await person('ana@x.test');
    const res = await trpc('notes.create', { path: 'd.md', content: 'd' }, ana.cookie);
    expect(res.status).toBe(200);
    expect(await bs.services.notes.exists(ana.id, 'd.md')).toBe(true);
  });
});
