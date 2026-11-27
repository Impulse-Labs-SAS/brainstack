// `@username` mentions through a booted app: a person picks a username from
// their assistant, someone mentions them in a note from the web or an
// assistant, and the mentioned person's assistant hears about it on its next
// call — once, and only when they may read the note.

import pino from 'pino';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBrainStack, type BrainStack } from './boot.js';
import { _resetConfigForTests, loadConfig } from './config/env.js';
import { SESSION_COOKIE } from './http/middleware/auth.js';
import { USERNAME_ASK_EVERY_MS } from './services/MentionService.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const logger = pino({ level: 'silent' });
let database: TestDatabase;
let bs: BrainStack;

const request = (path: string, init?: RequestInit) =>
  Promise.resolve(bs.app.fetch(new Request(`http://test/api${path}`, init)));

const trpc = async (procedure: string, input: unknown, headers: Record<string, string>) => {
  const res = await request(`/trpc/${procedure}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize(input)),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

const trpcQuery = async (procedure: string, input: unknown, headers: Record<string, string>) => {
  const q = encodeURIComponent(JSON.stringify(superjson.serialize(input)));
  const res = await request(`/trpc/${procedure}?input=${q}`, { headers });
  const json = (await res.json()) as { result?: { data: { json: unknown } } };
  return { status: res.status, data: json.result?.data.json };
};

/** Every text block of a tool's answer. */
async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const res = await request('/mcp', {
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
  const raw = await res.text();
  const json = raw.includes('data: ') ? raw.split('data: ')[1]!.trim() : raw;
  const parsed = JSON.parse(json) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { texts: parsed.result.content.map((c) => c.text), isError: !!parsed.result.isError };
}

/** A signed-in person with an assistant key. */
async function person(email: string) {
  const user = await bs.services.auth.ensureUser(email);
  const { token } = await bs.services.auth.createSession(user.id);
  const key = await bs.services.apiKeys.create(user.id, 'assistant');
  return { id: user.id, cookie: { cookie: `${SESSION_COOKIE}=${token}` }, key: key.token };
}

const noticesIn = (texts: string[]) => texts.slice(1).join('\n');

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
  bs = await createBrainStack({
    config: loadConfig(),
    logger,
    database: { db: database.db, close: async () => undefined },
  });
});

describe('usernames', () => {
  it('are asked for by the assistant once, suggested from the email, and saved with set_username', async () => {
    const pablo = await person('Pablo.Gomez@x.test');

    const first = await mcpCall(pablo.key, 'list_notes', {});
    expect(noticesIn(first.texts)).toContain('has no username');
    expect(noticesIn(first.texts)).toContain('"pablo.gomez"');

    // Asked once, not on every call.
    const second = await mcpCall(pablo.key, 'list_notes', {});
    expect(second.texts).toHaveLength(1);

    const saved = await mcpCall(pablo.key, 'set_username', { username: '@Pablo' });
    expect(JSON.parse(saved.texts[0]!)).toEqual({ username: 'pablo', mentionAs: '@pablo' });
  });

  it('are asked for again after a week without one', async () => {
    const pablo = await person('pablo@x.test');
    await mcpCall(pablo.key, 'list_notes', {});
    const { users } = (await import('@brainstack/core/pg')).pgSchema;
    const { eq } = await import('drizzle-orm');
    await database.db
      .update(users)
      .set({ usernameAskedAt: Date.now() - USERNAME_ASK_EVERY_MS - 1 })
      .where(eq(users.id, pablo.id));
    expect(noticesIn((await mcpCall(pablo.key, 'list_notes', {})).texts)).toContain(
      'has no username',
    );
  });

  it('are unique and follow the rules', async () => {
    const ana = await person('ana@x.test');
    const bo = await person('bo@x.test');
    await bs.services.mentions.setUsername(ana.id, 'ana');

    const taken = await mcpCall(bo.key, 'set_username', { username: 'ANA' });
    expect(taken.isError).toBe(true);
    expect(taken.texts[0]).toContain('ALREADY_EXISTS');

    const bad = await trpc('mentions.setUsername', { username: 'no spaces' }, bo.cookie);
    expect(bad.status).toBe(400);

    const me = await trpcQuery('mentions.me', undefined, bo.cookie);
    expect(me.data).toEqual({ username: null, suggested: 'bo' });
  });
});

describe('mentions', () => {
  async function setup() {
    const ana = await person('ana@x.test');
    const pablo = await person('pablo@x.test');
    const eve = await person('eve@x.test');
    for (const [p, name] of [
      [ana, 'ana'],
      [pablo, 'pablo'],
      [eve, 'eve'],
    ] as const) {
      await bs.services.mentions.setUsername(p.id, name);
    }
    await bs.services.notes.createFolder(ana.id, 'orbit');
    await bs.services.sharing.grant({
      ownerId: ana.id,
      sharedWithUserId: pablo.id,
      folderPath: 'orbit',
      grantedBy: ana.id,
      permission: 'write',
    });
    return { ana, pablo, eve };
  }

  it('reach the mentioned person on their next call, once, with who, where and the line', async () => {
    const { ana, pablo } = await setup();
    await trpc(
      'notes.create',
      { path: 'orbit/plan.md', content: '# Plan\n\n@pablo revisá los precios.\n' },
      ana.cookie,
    );

    const next = await mcpCall(pablo.key, 'list_shared_with_me', {});
    const notice = noticesIn(next.texts);
    expect(notice).toContain('mentioned in notes');
    expect(notice).toContain('@ana');
    expect(notice).toContain('"orbit/plan.md"');
    expect(notice).toContain(`ownerId "${ana.id}"`);
    expect(notice).toContain('@pablo revisá los precios.');

    expect((await mcpCall(pablo.key, 'list_shared_with_me', {})).texts).toHaveLength(1);

    // Still there to look back on.
    const listed = JSON.parse((await mcpCall(pablo.key, 'list_mentions', {})).texts[0]!) as {
      username: string;
      mentions: Array<{ path: string; ownerId: string; line: string }>;
    };
    expect(listed.username).toBe('pablo');
    expect(listed.mentions).toEqual([
      expect.objectContaining({ path: 'orbit/plan.md', ownerId: ana.id }),
    ]);
  });

  it('are told only for what a save added', async () => {
    const { ana, pablo } = await setup();
    const created = await trpc(
      'notes.create',
      { path: 'orbit/plan.md', content: '@pablo uno' },
      ana.cookie,
    );
    expect(created.status).toBe(200);
    await mcpCall(pablo.key, 'list_notes', {});

    const note = await bs.services.notes.get(ana.id, 'orbit/plan.md');
    await trpc(
      'notes.update',
      {
        path: 'orbit/plan.md',
        content: '@pablo uno, y @pablo dos',
        expectedChecksum: note.checksum,
      },
      ana.cookie,
    );
    expect((await mcpCall(pablo.key, 'list_notes', {})).texts).toHaveLength(1);
  });

  it('are not told to someone who cannot read the note, nor to the writer', async () => {
    const { ana, pablo, eve } = await setup();
    await mcpCall(ana.key, 'create_note', {
      path: 'orbit/plan.md',
      content: '@eve @ana @nobody mirá',
    });
    expect((await mcpCall(eve.key, 'list_notes', {})).texts).toHaveLength(1);
    expect((await mcpCall(ana.key, 'list_notes', {})).texts).toHaveLength(1);
    expect(pablo).toBeTruthy();
  });

  it('name whoever wrote them in a shared folder, not its owner', async () => {
    const { ana, pablo } = await setup();
    await mcpCall(pablo.key, 'create_note', {
      path: 'orbit/idea.md',
      ownerId: ana.id,
      content: 'Idea para @ana',
    });
    const notice = noticesIn((await mcpCall(ana.key, 'list_notes', {})).texts);
    expect(notice).toContain('@pablo mentioned them in "orbit/idea.md"');
    // The note is Ana's own: no ownerId to pass.
    expect(notice).not.toContain('ownerId "');
  });

  it('are dropped when the folder stopped being shared before they were told', async () => {
    const { ana, pablo } = await setup();
    await trpc('notes.create', { path: 'orbit/plan.md', content: '@pablo hola' }, ana.cookie);
    await bs.services.sharing.revoke({
      ownerId: ana.id,
      folderPath: 'orbit',
      sharedWithUserId: pablo.id,
    });
    expect((await mcpCall(pablo.key, 'list_notes', {})).texts).toHaveLength(1);
  });

  it('suggest in the editor only people who can read the note', async () => {
    const { ana, pablo } = await setup();
    await bs.services.notes.create(ana.id, 'orbit/plan.md', 'x');
    await bs.services.notes.create(ana.id, 'private.md', 'x');

    const shared = await trpcQuery('mentions.people', { path: 'orbit/plan.md' }, ana.cookie);
    expect(shared.data).toEqual([{ userId: pablo.id, username: 'pablo', displayName: null }]);

    const mine = await trpcQuery('mentions.people', { path: 'private.md' }, ana.cookie);
    expect(mine.data).toEqual([]);

    const asPablo = await trpcQuery(
      'mentions.people',
      { path: 'orbit/plan.md', ownerId: ana.id },
      pablo.cookie,
    );
    expect(asPablo.data).toEqual([{ userId: ana.id, username: 'ana', displayName: null }]);
  });
});
