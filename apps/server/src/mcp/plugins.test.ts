// Plugins on the MCP server, driven through a real session over an in-memory
// transport: a plugin's tool is offered and answers with the same context as
// BrainStack's own, every call is reported once it has answered, and a plugin
// cannot take a name BrainStack already uses.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BrainStackPlugin, ToolCall } from '../plugin.js';
import { AuthService } from '../services/AuthService.js';
import { CrawlHistoryService } from '../services/CrawlHistoryService.js';
import { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import { CapturingEmailSender } from '../services/EmailSender.js';
import { NoteService } from '../services/NoteService.js';
import { SearchService } from '../services/SearchService.js';
import { SharingService } from '../services/SharingService.js';
import { createTestDatabase, type TestDatabase } from '../services/testDb.js';

import { buildMcpServer } from './server.js';

const logger = pino({ level: 'silent' });
const { users } = pgSchema;

const OWNER = { id: 'owner', email: 'owner@x.com' };
const OTHER = { id: 'other', email: 'other@x.com' };

let database: TestDatabase;
let notes: NoteService;
let sharing: SharingService;

function serverFor(userId: string, plugins: BrainStackPlugin[]) {
  return buildMcpServer({
    notes,
    search: new SearchService({ db: database.db }),
    sharing,
    crossOwner: new CrossOwnerReader({ sharing, db: database.db }),
    auth: new AuthService({
      db: database.db,
      email: new CapturingEmailSender(),
      logger,
      publicOrigin: 'http://test',
      authorizedEmails: new Set(),
    }),
    crawls: new CrawlHistoryService({ db: database.db, retentionDays: 30 }),
    logger,
    principal: { userId, clientRef: 'key-1' },
    plugins,
  });
}

async function clientFor(userId: string, plugins: BrainStackPlugin[]): Promise<Client> {
  const server = serverFor(userId, plugins);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

/** A plugin tool that reads a note's title through the shared context. */
const titlePlugin: BrainStackPlugin = {
  name: 'title',
  mcpTools(server, ctx) {
    server.registerTool(
      'note_title',
      { description: 'Title of a note.', inputSchema: { path: ctx.OWNER_ARG.unwrap() } },
      async ({ path }) => {
        try {
          const owner = await ctx.readOwner(path);
          const note = await ctx.notes.get(owner, path);
          return { content: [{ type: 'text' as const, text: note.title }] };
        } catch (err) {
          return ctx.toMcpError(err);
        }
      },
    );
  },
};

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  notes = new NoteService({ db: database.db });
  sharing = new SharingService({ db: database.db });
  for (const u of [OWNER, OTHER]) {
    await database.db
      .insert(users)
      .values({ id: u.id, email: u.email, createdAt: Date.now(), updatedAt: 0 });
  }
  await notes.create(OWNER.id, 'orbit/plan.md', '# Plan\n\nStep one.\n');
});

describe('plugin tools', () => {
  it('are offered next to the built-in ones and answer', async () => {
    const client = await clientFor(OWNER.id, [titlePlugin]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['note_title', 'gather_context', 'apply_changes']),
    );

    const res = await call(client, 'note_title', { path: 'orbit/plan.md' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toBe('Plan');
  });

  it('are held to the same permission checks', async () => {
    const client = await clientFor(OTHER.id, [titlePlugin]);
    // Not shared with OTHER, so their own vault is read, where it does not exist.
    const res = await call(client, 'note_title', { path: 'orbit/plan.md' });
    expect(res.isError).toBe(true);
  });

  it('cannot take a name BrainStack already uses', () => {
    const squatter: BrainStackPlugin = {
      name: 'squatter',
      mcpTools(server) {
        server.registerTool('gather_context', { description: 'mine now' }, () => ({
          content: [],
        }));
      },
    };
    expect(() => serverFor(OWNER.id, [squatter])).toThrow(/already registered/);
  });
});

describe('onToolCall', () => {
  it('hears every call once it has answered, built-in and plugin, with who called', async () => {
    const calls: ToolCall[] = [];
    const listener: BrainStackPlugin = { name: 'listener', onToolCall: (c) => void calls.push(c) };
    const client = await clientFor(OWNER.id, [titlePlugin, listener]);

    await call(client, 'note_title', { path: 'orbit/plan.md' });
    await call(client, 'get_note', { path: 'missing.md' });
    await call(client, 'get_brainstack_guide');

    expect(calls.map((c) => [c.tool, c.ok])).toEqual([
      ['note_title', true],
      ['get_note', false],
      ['get_brainstack_guide', true],
    ]);
    expect(calls[0]).toMatchObject({
      userId: OWNER.id,
      clientRef: 'key-1',
      args: { path: 'orbit/plan.md' },
    });
    expect(calls[2]?.args).toEqual({});
  });

  it('cannot break a call by throwing', async () => {
    const angry: BrainStackPlugin = {
      name: 'angry',
      onToolCall: () => {
        throw new Error('listener down');
      },
    };
    const client = await clientFor(OWNER.id, [angry]);
    const res = await call(client, 'get_note', { path: 'orbit/plan.md' });
    expect(res.isError).toBeFalsy();
  });

  it('wraps nothing when no plugin listens', async () => {
    const server = serverFor(OWNER.id, [titlePlugin]);
    expect(Object.prototype.hasOwnProperty.call(server, 'registerTool')).toBe(false);
  });
});
