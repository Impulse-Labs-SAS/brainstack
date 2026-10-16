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
import { NOTE_MAX_CHARS } from '@brainstack/core/sentinel';

import { saveNotes } from '../services/saveNotes.js';
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

describe('the checks the review asked for', () => {
  const shareOrbit = (permission: 'read' | 'write' = 'write') =>
    sharing.grant({
      ownerId: OWNER.id,
      sharedWithUserId: FRODO.id,
      folderPath: 'orbit',
      grantedBy: OWNER.id,
      permission,
    });

  it('edit_note reaches a shared folder with its ownerId, and refuses a read-only share', async () => {
    await shareOrbit('read');
    const client = await clientFor(FRODO.id);
    const args = { path: 'orbit/plan.md', ownerId: OWNER.id, edits: [{ op: 'append', text: 'x' }] };
    expect((await call(client, 'edit_note', args)).error).toMatch(/^\[FORBIDDEN\]/);
    await sharing.grant({
      ownerId: OWNER.id,
      sharedWithUserId: FRODO.id,
      folderPath: 'orbit',
      grantedBy: OWNER.id,
      permission: 'write',
    });
    expect((await call(client, 'edit_note', args)).error).toBeUndefined();
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nStep one.\nx\n');
  });

  it('refuses a path that names a shared folder without saying whose, in both tools', async () => {
    await shareOrbit();
    const client = await clientFor(FRODO.id);
    const edit = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      edits: [{ op: 'append', text: 'x' }],
    });
    expect(edit.error).toMatch(/^\[FORBIDDEN\].*shared with you/);
    const save = await call(client, 'save_notes', {
      writes: [{ action: 'create', path: 'orbit/new.md', content: 'x' }],
    });
    expect(save.error).toMatch(/^\[FORBIDDEN\] write 1 \(orbit\/new\.md\).*shared with you/);
    expect(await notes.hasNote(OWNER.id, 'orbit/new.md')).toBe(false);
  });

  it('save_notes refuses a read-only key', async () => {
    const client = await clientFor(OWNER.id, { readOnly: true });
    const { error } = await call(client, 'save_notes', {
      writes: [{ action: 'create', path: 'orbit/new.md', content: 'x' }],
    });
    expect(error).toMatch(/^\[FORBIDDEN\]/);
  });

  it('refuses a write inside a folder the same call deletes, and a recursive delete of nothing', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'save_notes', {
      writes: [
        { action: 'delete', path: 'orbit', recursive: true },
        { action: 'edit', path: 'orbit/_orbit.md', edits: [{ op: 'append', text: 'x' }] },
        { action: 'delete', path: 'nowhere', recursive: true },
      ],
    });
    expect(value).toMatchObject({
      saved: false,
      results: [
        { status: 'skipped' },
        { status: 'failed', error: { message: expect.stringContaining('which write 1 deletes') } },
        { status: 'failed', error: { code: 'NOT_FOUND' } },
      ],
    });
    expect(await notes.hasNote(OWNER.id, 'orbit/plan.md')).toBe(true);
  });

  it('reports an edit to a missing note as NOT_FOUND', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'save_notes', {
      writes: [{ action: 'edit', path: 'orbit/gone.md', edits: [{ op: 'append', text: 'x' }] }],
    });
    expect(value).toMatchObject({ saved: false, results: [{ error: { code: 'NOT_FOUND' } }] });
  });

  it('stops at a note somebody saved between the check and the write, keeping what landed', async () => {
    // Somebody saves plan.md right after its edit was checked.
    const racing = Object.create(notes) as NoteService;
    racing.planEdit = async (...args) => {
      const plan = await notes.planEdit(...args);
      await notes.update(OWNER.id, 'orbit/plan.md', '# Plan\n\nSomeone else.\n');
      return plan;
    };
    const report = await saveNotes(
      racing,
      OWNER.id,
      [
        { action: 'create', owner: OWNER.id, path: 'orbit/a.md', content: 'A' },
        {
          action: 'edit',
          owner: OWNER.id,
          path: 'orbit/plan.md',
          edits: [{ op: 'append', text: 'mine' }],
        },
        { action: 'create', owner: OWNER.id, path: 'orbit/b.md', content: 'B' },
      ],
      { onUnexpected: () => {} },
    );
    expect(report).toMatchObject({
      saved: false,
      results: [
        { path: 'orbit/a.md', status: 'done' },
        { path: 'orbit/plan.md', status: 'failed', error: { code: 'CHANGED' } },
        { path: 'orbit/b.md', status: 'skipped' },
      ],
    });
    expect(await body(OWNER.id, 'orbit/plan.md')).toBe('# Plan\n\nSomeone else.\n');
    expect(await notes.hasNote(OWNER.id, 'orbit/a.md')).toBe(true);
    expect(await notes.hasNote(OWNER.id, 'orbit/b.md')).toBe(false);
  });

  it('refuses an edit that would grow a note past the size limit', async () => {
    const client = await clientFor(OWNER.id);
    const big = 'x'.repeat(1_500_000);
    const { error } = await call(client, 'edit_note', {
      path: 'orbit/plan.md',
      edits: [
        { op: 'append', text: big },
        { op: 'append', text: big },
      ],
    });
    expect(error).toMatch(/^\[INVALID_INPUT\] .*would grow past/);
  });

  it('lists a cut note’s sections from Postgres, skipping headings inside code', async () => {
    const long = [
      '# Ledger',
      '',
      '## Intro',
      'word '.repeat(3000),
      '```sh',
      '# not a heading',
      '```',
      '## Late section',
      'end',
      '',
    ].join('\n');
    await notes.create(OWNER.id, 'ledger.md', long);
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'gather_context', { text: 'Ledger' });
    const ledger = (
      value as { notes: Array<{ path: string; truncated: boolean; sections?: string[] }> }
    ).notes.find((n) => n.path === 'ledger.md');
    expect(ledger).toMatchObject({
      truncated: true,
      sections: ['# Ledger', '## Intro', '## Late section'],
    });
  });

  it('get_notes cuts bodies past its budget and says so', async () => {
    const huge = 'y'.repeat(300_000);
    await notes.create(OWNER.id, 'one.md', huge);
    await notes.create(OWNER.id, 'two.md', huge);
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'get_notes', {
      notes: [{ path: 'one.md' }, { path: 'two.md' }],
    });
    const [one, two] = value as Array<{ body: string; truncated?: boolean }>;
    expect(one!.truncated).toBeUndefined();
    expect(two!.truncated).toBe(true);
    expect(one!.body.length + two!.body.length).toBe(400_000);
  });
});

describe('the note size limit', () => {
  const long = (chars: number) => `# Long\n\n${'x'.repeat(chars - 8)}\n`;

  it('refuses a note an assistant creates past the limit, and says to split it', async () => {
    const client = await clientFor(OWNER.id);
    const { error } = await call(client, 'create_note', {
      path: 'orbit/long.md',
      content: long(NOTE_MAX_CHARS + 100),
    });
    expect(error).toMatch(/^\[TOO_LONG\] orbit\/long\.md would be \d+ characters .*Split it/);
    expect(await notes.hasNote(OWNER.id, 'orbit/long.md')).toBe(false);
    const ok = await call(client, 'create_note', {
      path: 'orbit/long.md',
      content: long(NOTE_MAX_CHARS),
    });
    expect(ok.error).toBeUndefined();
  });

  it('writes nothing in a batch where one note would be too long', async () => {
    const client = await clientFor(OWNER.id);
    const { value } = await call(client, 'save_notes', {
      writes: [
        { action: 'create', path: 'orbit/ok.md', content: 'Fine.' },
        { action: 'replace', path: 'orbit/plan.md', content: long(NOTE_MAX_CHARS + 1) },
      ],
    });
    expect(value).toMatchObject({
      saved: false,
      results: [{ status: 'skipped' }, { status: 'failed', error: { code: 'TOO_LONG' } }],
    });
    expect(await notes.hasNote(OWNER.id, 'orbit/ok.md')).toBe(false);
  });

  it('lets a note already past the limit shrink, never grow, and says so when read', async () => {
    // Written by a person, who is not held to the limit.
    await notes.create(OWNER.id, 'orbit/legacy.md', `${long(NOTE_MAX_CHARS + 500)}## Tail\nend\n`);
    const client = await clientFor(OWNER.id);

    const read = await call(client, 'get_note', { path: 'orbit/legacy.md' });
    expect(read.value).toMatchObject({
      tooLong: { maxChars: NOTE_MAX_CHARS, mayOnlyShrink: true },
    });
    const crawl = await call(client, 'gather_context', { text: 'Long' });
    expect((crawl.value as { notes: Array<{ path: string; tooLong?: boolean }> }).notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'orbit/legacy.md', tooLong: true })]),
    );

    const grow = await call(client, 'edit_note', {
      path: 'orbit/legacy.md',
      edits: [{ op: 'append', section: 'Tail', text: 'more' }],
    });
    expect(grow.error).toMatch(/^\[TOO_LONG\].*already \d+ characters, past the limit/);
    const shrink = await call(client, 'edit_note', {
      path: 'orbit/legacy.md',
      edits: [{ op: 'replace', find: '## Tail\nend\n', replace: '' }],
    });
    expect(shrink.error).toBeUndefined();
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
