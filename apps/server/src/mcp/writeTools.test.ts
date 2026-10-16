// Sentinel's writing tools — edit_note, save_notes, get_notes — driven the way
// a client drives them: a real MCP session over an in-memory transport, so the
// tool schemas, the permission checks and the store are all in the path.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
const FRODO = { id: 'frodo', email: 'frodo@x.com' };

const MOC = '# Orbit\n\n## Notas\n- [[orbit/plan|Plan]]\n\n## Refs\n';

let database: TestDatabase;
let notes: NoteService;
let sharing: SharingService;

async function clientFor(userId: string, opts: { readOnly?: boolean } = {}): Promise<Client> {
  const email = new CapturingEmailSender();
  const server = buildMcpServer({
    notes,
    search: new SearchService({ db: database.db }),
    sharing,
    crossOwner: new CrossOwnerReader({ sharing, db: database.db }),
    auth: new AuthService({
      db: database.db,
      email,
      logger,
      publicOrigin: 'http://test',
      authorizedEmails: new Set(),
    }),
    crawls: new CrawlHistoryService({ db: database.db, retentionDays: 30 }),
    logger,
    principal: { userId, ...opts },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]?.text ?? '';
  if (res.isError) return { error: text, value: undefined as unknown };
  return { error: undefined, value: JSON.parse(text) as unknown };
}

const body = async (ownerId: string, path: string) => (await notes.get(ownerId, path)).body;

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
  for (const u of [OWNER, FRODO]) {
    await database.db
      .insert(users)
      .values({ id: u.id, email: u.email, createdAt: Date.now(), updatedAt: 0 });
  }
  await notes.create(OWNER.id, 'orbit/_orbit.md', MOC);
  await notes.create(OWNER.id, 'orbit/plan.md', '# Plan\n\nStep one.\n');
});

describe('the tools are offered', () => {
  it('lists edit_note, save_notes and get_notes with valid schemas', async () => {
    const client = await clientFor(OWNER.id);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['edit_note', 'save_notes', 'get_notes']));
  });
});

describe('edit_note', () => {
  it('appends into a section and leaves the rest of the note as it was', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'edit_note', {
      path: 'orbit/_orbit.md',
      edits: [{ op: 'append', section: 'Notas', text: '- [[orbit/new|New]]' }],
    });
    expect(value).toMatchObject({ path: 'orbit/_orbit.md', checksum: expect.any(String) });
    expect(await body(OWNER.id, 'orbit/_orbit.md')).toBe(
      '# Orbit\n\n## Notas\n- [[orbit/plan|Plan]]\n- [[orbit/new|New]]\n\n## Refs\n',
    );
  });

  it('writes nothing when an anchor is missing, and says which', async () => {
    const client = await clientFor(OWNER.id);
    const { error } = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      edits: [
        { op: 'append', text: 'Step two.' },
        { op: 'replace', find: 'Step three.', replace: 'x' },
      ],
    });
    expect(error).toMatch(/^\[INVALID_INPUT\] the text to replace is not in the note.*\(edit 2\)/);
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nStep one.\n');
  });

  it('refuses a stale checksum instead of overwriting', async () => {
    const client = await clientFor(OWNER.id);
    const { checksum } = await notes.get(OWNER.id, 'orbit/plan.md');
    await notes.update(OWNER.id, 'orbit/plan.md', '# Plan\n\nSomeone else.\n');
    const { error } = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      expectedChecksum: checksum,
      edits: [{ op: 'append', text: 'mine' }],
    });
    expect(error).toMatch(/^\[CHANGED\]/);
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nSomeone else.\n');
  });

  it('removes frontmatter keys for good, even the last one', async () => {
    const client = await clientFor(OWNER.id);
    await notes.create(OWNER.id, 'orbit/draft.md', 'Draft.\n', { status: 'draft' });
    await call(client, 'edit_note', {
      path: 'orbit/draft.md',
      edits: [{ op: 'set_frontmatter', values: { status: null } }],
    });
    expect((await notes.get(OWNER.id, 'orbit/draft.md')).frontmatter).toEqual({});
  });

  it('works from the checksum gather_context handed over, with no get_note', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'gather_context', { text: 'Plan' });
    const plan = (value as { notes: Array<{ path: string; checksum?: string }> }).notes.find(
      (n) => n.path === 'orbit/plan.md',
    );
    expect(plan?.checksum).toEqual(expect.any(String));
    const { error } = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      expectedChecksum: plan!.checksum,
      edits: [{ op: 'append', text: 'Step two.' }],
    });
    expect(error).toBeUndefined();
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nStep one.\nStep two.\n');
  });

  it('refuses a read-only key', async () => {
    const client = await clientFor(OWNER.id, { readOnly: true });
    const { error } = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      edits: [{ op: 'append', text: 'x' }],
    });
    expect(error).toMatch(/^\[FORBIDDEN\]/);
  });
});

describe('save_notes', () => {
  it('creates, links from the index, rewrites and deletes in one call', async () => {
    const client = await clientFor(OWNER.id);
    await notes.create(OWNER.id, 'orbit/old.md', 'Old.\n');
    const { value } = await call(client, 'save_notes', {
      writes: [
        {
          action: 'create',
          path: 'orbit/lore.md',
          content: '# Lore\n\nSee [[orbit/plan|Plan]].\n',
        },
        {
          action: 'edit',
          path: 'orbit/_orbit.md',
          edits: [{ op: 'append', section: 'Notas', text: '- [[orbit/lore|Lore]]' }],
        },
        { action: 'replace', path: 'orbit/plan.md', content: '# Plan\n\nRewritten.\n' },
        { action: 'delete', path: 'orbit/old.md' },
      ],
    });
    expect(value).toMatchObject({
      saved: true,
      results: [
        {
          action: 'create',
          path: 'orbit/lore.md',
          status: 'done',
          affectedMocs: ['orbit/_orbit.md'],
        },
        { action: 'edit', path: 'orbit/_orbit.md', status: 'done' },
        { action: 'replace', path: 'orbit/plan.md', status: 'done' },
        { action: 'delete', path: 'orbit/old.md', status: 'done', deleted: ['orbit/old.md'] },
      ],
    });
    expect(await body(OWNER.id, 'orbit/_orbit.md')).toContain('- [[orbit/lore|Lore]]');
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nRewritten.\n');
    expect(await notes.hasNote(OWNER.id, 'orbit/old.md')).toBe(false);
    // The link the index gained is a real one: the new note has its backlink.
    const backlinks = await notes.listLinks(OWNER.id, 'orbit/lore.md');
    expect(backlinks.map((b) => b.sourcePath)).toContain('orbit/_orbit.md');
  });

  it('writes nothing when any write would fail, and says which', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'save_notes', {
      writes: [
        { action: 'create', path: 'orbit/lore.md', content: '# Lore\n' },
        {
          action: 'edit',
          path: 'orbit/_orbit.md',
          edits: [{ op: 'append', section: 'Notes', text: '- [[orbit/lore|Lore]]' }],
        },
        { action: 'delete', path: 'orbit/missing.md' },
      ],
    });
    expect(value).toMatchObject({
      saved: false,
      results: [
        { action: 'create', status: 'skipped' },
        { action: 'edit', status: 'failed', error: { code: 'INVALID_INPUT' } },
        { action: 'delete', status: 'failed', error: { code: 'NOT_FOUND' } },
      ],
    });
    expect(await notes.hasNote(OWNER.id, 'orbit/lore.md')).toBe(false);
    expect(await body(OWNER.id, 'orbit/_orbit.md')).toBe(MOC);
  });

  it('refuses two writes to one path', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'save_notes', {
      writes: [
        { action: 'edit', path: 'orbit/plan.md', edits: [{ op: 'append', text: 'a' }] },
        { action: 'edit', path: './orbit/plan.md', edits: [{ op: 'append', text: 'b' }] },
      ],
    });
    expect(value).toMatchObject({
      saved: false,
      results: [{ status: 'failed' }, { status: 'failed' }],
    });
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nStep one.\n');
  });

  it('refuses the whole call when one write lands where the caller may not write', async () => {
    const client = await clientFor(FRODO.id);
    await notes.create(FRODO.id, 'mine.md', 'Mine.\n');
    const { error } = await call(client, 'save_notes', {
      writes: [
        { action: 'edit', path: 'mine.md', edits: [{ op: 'append', text: 'x' }] },
        { action: 'delete', path: 'orbit/plan.md', ownerId: OWNER.id },
      ],
    });
    expect(error).toMatch(/^\[FORBIDDEN\] write 2 \(orbit\/plan\.md\)/);
    expect(await body(FRODO.id, 'mine.md')).toBe('Mine.\n');
    expect(await notes.hasNote(OWNER.id, 'orbit/plan.md')).toBe(true);
  });

  it('writes into a folder shared for writing, in its owner’s vault', async () => {
    await sharing.grant({
      ownerId: OWNER.id,
      sharedWithUserId: FRODO.id,
      folderPath: 'orbit',
      grantedBy: OWNER.id,
      permission: 'write',
    });
    const client = await clientFor(FRODO.id);
    const { value } = await call(client, 'save_notes', {
      writes: [
        {
          action: 'edit',
          path: 'orbit/plan.md',
          ownerId: OWNER.id,
          edits: [{ op: 'append', text: 'From Frodo.' }],
        },
      ],
    });
    expect(value).toMatchObject({
      saved: true,
      results: [{ ownerId: OWNER.id, path: 'orbit/plan.md', status: 'done' }],
    });
    expect(await body(OWNER.id, 'orbit/plan.md')).toContain('From Frodo.');
  });
});

describe('get_notes', () => {
  it('reads several notes at once, with an error in place of one that is missing', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'get_notes', {
      notes: [{ path: 'orbit/plan.md' }, { path: 'orbit/missing.md' }, { path: 'orbit/_orbit.md' }],
    });
    expect(value).toMatchObject([
      { source: 'own', path: 'orbit/plan.md', body: '# Plan\n\nStep one.\n' },
      { path: 'orbit/missing.md', error: { code: 'NOT_FOUND' } },
      { source: 'own', path: 'orbit/_orbit.md' },
    ]);
  });
});
