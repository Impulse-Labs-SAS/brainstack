// The sharing tools, driven the way a client drives them: a real MCP session
// over an in-memory transport. Calling the service directly would not have
// caught the bug this file starts with — `list_shared_with_me` returned the
// unawaited promise, which serialises to `{}`, so the tool answered "nothing
// is shared with you" no matter what was.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../services/AuthService.js';
import { CrawlHistoryService } from '../services/CrawlHistoryService.js';
import { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import { CapturingEmailSender } from '../services/EmailSender.js';
import { InviteService } from '../services/InviteService.js';
import { NoteService } from '../services/NoteService.js';
import { SearchService } from '../services/SearchService.js';
import { SharingService } from '../services/SharingService.js';
import { TotpService } from '../services/TotpService.js';
import { createTestDatabase, type TestDatabase } from '../services/testDb.js';

import { buildMcpServer } from './server.js';

const logger = pino({ level: 'silent' });
const { users } = pgSchema;

const OWNER = { id: 'owner', email: 'owner@x.com' };
const FRODO = { id: 'frodo', email: 'frodo@x.com' };

let database: TestDatabase;
let email: CapturingEmailSender;
let sharing: SharingService;

/** An MCP client talking to a server that acts as `userId`. */
async function clientFor(userId: string): Promise<Client> {
  const notes = new NoteService({ db: database.db });
  const search = new SearchService({ db: database.db });
  const totp = new TotpService({ db: database.db, issuer: 'BrainStack' });
  const auth = new AuthService({
    db: database.db,
    email,
    logger,
    publicOrigin: 'http://test',
    authorizedEmails: new Set(),
    totp,
  });
  const invites = new InviteService({
    db: database.db,
    email,
    sharing,
    publicOrigin: 'http://test',
  });
  const crossOwner = new CrossOwnerReader({ sharing, db: database.db });

  const server = buildMcpServer({
    notes,
    search,
    sharing,
    crossOwner,
    auth,
    invites,
    crawls: new CrawlHistoryService({ db: database.db, retentionDays: 30 }),
    logger,
    principal: { userId },
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** Every tool answers with JSON in one text block; this reads it back. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]?.text ?? '';
  if (res.isError) return { error: text };
  // Most tools answer with JSON; a few (update_note, create_folder) answer with
  // a sentence. Hand back whichever it was rather than making callers know.
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { value: text };
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  email = new CapturingEmailSender();
  sharing = new SharingService({ db: database.db });
  for (const u of [OWNER, FRODO]) {
    await database.db
      .insert(users)
      .values({ id: u.id, email: u.email, createdAt: Date.now(), updatedAt: 0 });
  }
});

describe('the sharing tools exist at all', () => {
  it('exposes both sides of sharing', async () => {
    const client = await clientFor(OWNER.id);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['share_folder', 'unshare', 'list_shares', 'list_shared_with_me']),
    );
  });

});

describe('share_folder', () => {
  it('grants straight away when the email already has an account', async () => {
    const owner = await clientFor(OWNER.id);
    const { value } = await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: FRODO.email,
    });

    expect(value).toMatchObject({
      status: 'granted',
      folderPath: 'Impulse Labs',
      sharedWith: { userId: FRODO.id, email: FRODO.email },
    });
    expect(email.sent).toHaveLength(0);
    expect(await sharing.canRead(FRODO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);
  });

  it('invites by email when there is no account yet, without leaking the token', async () => {
    const owner = await clientFor(OWNER.id);
    const { value } = await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: 'nuevo@x.com',
    });

    expect(value).toMatchObject({ status: 'invited', invitedEmail: 'nuevo@x.com' });
    // The accept URL is a bearer credential; it belongs in the inbox, not in
    // the tool result the model gets to read and repeat.
    expect(JSON.stringify(value)).not.toContain('/invite/accept/');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('nuevo@x.com');
  });

  it('refuses to share the vault root', async () => {
    const owner = await clientFor(OWNER.id);
    const { error } = await call(owner, 'share_folder', { path: '/', email: FRODO.email });
    expect(error).toContain('root');
  });

  it('refuses to share with yourself', async () => {
    const owner = await clientFor(OWNER.id);
    const { error } = await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: OWNER.email,
    });
    // Falls through to the invite path, which mails the owner rather than
    // creating a self-share — either way, no grant is made.
    expect(await sharing.listMyShares(OWNER.id)).toHaveLength(0);
    expect(error).toBeUndefined();
  });

  it('is idempotent', async () => {
    const owner = await clientFor(OWNER.id);
    const a = await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });
    const b = await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });
    expect((a.value as { shareId: string }).shareId).toBe((b.value as { shareId: string }).shareId);
    expect(await sharing.listMyShares(OWNER.id)).toHaveLength(1);
  });
});

describe('list_shares', () => {
  it('lists who can read what, and filters by folder', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });

    const all = (await call(owner, 'list_shares')).value as Array<{ folderPath: string }>;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ folderPath: 'Impulse Labs', email: FRODO.email });

    const hit = (await call(owner, 'list_shares', { path: '/Impulse Labs/' })).value;
    expect(hit).toHaveLength(1);

    const miss = (await call(owner, 'list_shares', { path: 'Otra' })).value;
    expect(miss).toHaveLength(0);
  });

  it('shows nothing to someone who shared nothing', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });

    const frodo = await clientFor(FRODO.id);
    expect((await call(frodo, 'list_shares')).value).toHaveLength(0);
  });
});

describe('list_shared_with_me', () => {
  // The regression: this used to answer `{}` because the promise was never
  // awaited. Asserting on the contents is what pins it.
  it('returns the folders shared with me, not an empty object', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });

    const frodo = await clientFor(FRODO.id);
    const rows = (await call(frodo, 'list_shared_with_me')).value;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect((rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      folderPath: 'Impulse Labs',
      ownerId: OWNER.id,
      ownerEmail: OWNER.email,
    });
  });

  it('is empty for someone nobody shared with', async () => {
    const frodo = await clientFor(FRODO.id);
    expect((await call(frodo, 'list_shared_with_me')).value).toEqual([]);
  });
});

describe('unshare', () => {
  it('takes the access away', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });
    expect(await sharing.canRead(FRODO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);

    const { value } = await call(owner, 'unshare', {
      path: 'Impulse Labs',
      email: FRODO.email,
    });
    expect(value).toMatchObject({ status: 'revoked' });
    expect(await sharing.canRead(FRODO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(false);
  });

  it('says so when the email has no account', async () => {
    const owner = await clientFor(OWNER.id);
    const { error } = await call(owner, 'unshare', {
      path: 'Impulse Labs',
      email: 'nadie@x.com',
    });
    expect(error).toContain('no account');
  });

  it('cannot revoke a share it does not own', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });

    // Frodo asking to unshare names himself as the owner, and owns nothing.
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'unshare', { path: 'Impulse Labs', email: OWNER.email });

    expect(await sharing.canRead(FRODO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);
  });
});

// The bug this guard exists for, driven end to end.
//
// Frodo had read access to "Impulse Labs" and asked his assistant to write in
// it. No note tool takes an owner, so the path resolved against Frodo's own
// vault: the write succeeded, created a folder of the same name under him, and
// told him it had worked. He believed he had contributed to the shared folder.
// Nobody else ever saw the note.
describe('writing to a path that names somebody else’s shared folder', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: FRODO.email });
  });

  it('refuses create_folder instead of making a private copy', async () => {
    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_folder', { path: 'Impulse Labs' });

    expect(error).toBeDefined();
    expect(error).toContain('FORBIDDEN');
    // The message has to name the owner, or the error is just as confusing as
    // the silence it replaced.
    expect(error).toContain(OWNER.email);
  });

  it('refuses create_note anywhere under it, however deep', async () => {
    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_note', {
      path: 'Impulse Labs/reuniones/2026-08-25.md',
      content: '# Reunión',
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('leaves nothing behind when it refuses', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Impulse Labs/nota.md', content: 'x' });

    const { value } = await call(frodo, 'list_notes', {});
    expect(value).toEqual([]);
  });

  it('still lets Frodo write his own folders', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value } = await call(frodo, 'create_note', {
      path: 'mis-cosas/idea.md',
      content: 'mía',
    });
    expect(value).toMatchObject({ path: 'mis-cosas/idea.md' });
  });

  it('does not stop a name that merely starts the same', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value } = await call(frodo, 'create_note', {
      path: 'Impulse Labs Personal/idea.md',
      content: 'otra cosa',
    });
    expect(value).toMatchObject({ path: 'Impulse Labs Personal/idea.md' });
  });

  it('does not stop the owner writing in her own folder', async () => {
    const owner = await clientFor(OWNER.id);
    const { value } = await call(owner, 'create_note', {
      path: 'Impulse Labs/agenda.md',
      content: 'mía',
    });
    expect(value).toMatchObject({ path: 'Impulse Labs/agenda.md' });
  });
});

// `list_shared_with_me` was fixed for returning an unawaited promise, which
// serialises to `{}` — a tool that answers "nothing" no matter what is true.
// Three listing tools still had it, so an assistant asking what was in a folder
// got `{}` and could reasonably conclude the folder was empty, or absent.
describe('the listing tools answer with their rows, not with a pending promise', () => {
  it('list_notes returns what was written', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'mis-cosas/idea.md', content: 'una idea' });

    const { value } = await call(frodo, 'list_notes', {});
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'mis-cosas/idea.md' }]);
  });

  it('list_decisions matches the decision tag', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', {
      path: 'decisiones/usar-pg.md',
      content: 'vamos con Postgres',
      frontmatter: { tags: ['decisión'] },
    });

    const { value } = await call(frodo, 'list_decisions', {});
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'decisiones/usar-pg.md' }]);
  });

  it('list_decisions also matches a status: decidido facet, with no tag at all', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', {
      path: 'decisiones/usar-drizzle.md',
      content: 'vamos con Drizzle',
      frontmatter: { status: 'decidido' },
    });

    const { value } = await call(frodo, 'list_decisions', {});
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'decisiones/usar-drizzle.md' }]);
  });

  it('list_links returns the backlinks of a note', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'destino.md', content: 'acá se llega' });
    await call(frodo, 'create_note', { path: 'origen.md', content: 'ver [[destino]]' });

    const { value } = await call(frodo, 'list_links', { path: 'destino.md' });
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ sourcePath: 'origen.md' }]);
  });

  it('list_outbound_links returns what a note links to', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'destino.md', content: 'acá se llega' });
    await call(frodo, 'create_note', { path: 'origen.md', content: 'ver [[destino]]' });

    const { value } = await call(frodo, 'list_outbound_links', { path: 'origen.md' });
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ targetPath: 'destino.md' }]);
  });

  it('list_related finds notes sharing a tag', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', {
      path: 'a.md',
      content: 'A',
      frontmatter: { tags: ['erebor'] },
    });
    await call(frodo, 'create_note', {
      path: 'b.md',
      content: 'B',
      frontmatter: { tags: ['erebor'] },
    });

    const { value } = await call(frodo, 'list_related', { path: 'a.md' });
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'b.md' }]);
  });

  it('list_unlinked_mentions reports where a note is named without a link', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Atlas.md', content: '# Atlas' });
    await call(frodo, 'create_note', { path: 'otra.md', content: '# Otra\n\nusa Atlas' });

    const { value } = await call(frodo, 'list_unlinked_mentions', { path: 'Atlas.md' });
    expect(value).toMatchObject({ incoming: [{ path: 'otra.md', text: 'Atlas', count: 1 }] });
  });

  it('gather_context resolves a text against the caller’s own vault only', async () => {
    const owner = await clientFor(OWNER.id);
    const frodo = await clientFor(FRODO.id);
    await call(owner, 'create_note', { path: 'Erebor.md', content: '# Erebor\n\nnot frodo’s' });
    await call(frodo, 'create_note', { path: 'Atlas.md', content: '# Atlas\n\nsee [[otra]]' });
    await call(frodo, 'create_note', { path: 'otra.md', content: '# Otra' });

    const { value, error } = await call(frodo, 'gather_context', {
      text: 'Compare Atlas with Erebor.',
      terms: ['quarterly'],
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      notes: [
        { path: 'Atlas.md', reason: 'the text says "Atlas"' },
        { path: 'otra.md', reason: 'linked from Atlas' },
      ],
      unresolved: [{ term: 'quarterly', reason: 'no-match' }],
      coverage: { resolved: 1, total: 2 },
    });

    // And leaves it for the Crawl view: Frodo's history, nobody else's.
    const crawls = new CrawlHistoryService({ db: database.db, retentionDays: 30 });
    expect(await crawls.list(FRODO.id)).toMatchObject([
      { source: 'assistant', prompt: 'Compare Atlas with Erebor.', notes: 2 },
    ]);
    expect(await crawls.list(OWNER.id)).toEqual([]);
  });

  it('list_facets returns one note’s facets, or browses every value when path is omitted', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', {
      path: 'stack.md',
      content: 'S',
      frontmatter: { technologies: ['nextjs'] },
    });

    const forNote = await call(frodo, 'list_facets', { path: 'stack.md' });
    expect(forNote.value).toMatchObject([{ key: 'technologies', value: 'nextjs' }]);

    const browse = await call(frodo, 'list_facets', { key: 'technologies' });
    expect(browse.value).toMatchObject([{ key: 'technologies', value: 'nextjs', count: 1 }]);
  });

  it('list_links omits a backlink source frodo has no grant to see', async () => {
    const owner = await clientFor(OWNER.id);
    const frodo = await clientFor(FRODO.id);

    await call(owner, 'create_note', { path: 'Proyectos/erebor.md', content: 'destino compartido' });
    // Privado/ is never shared, but it links into the folder that is.
    await call(owner, 'create_note', {
      path: 'Privado/diario.md',
      content: 'ver [[Proyectos/erebor]]',
    });
    await call(owner, 'share_folder', { path: 'Proyectos', email: FRODO.email });

    const { value } = await call(frodo, 'list_links', {
      path: 'Proyectos/erebor.md',
      ownerId: OWNER.id,
    });
    expect(Array.isArray(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain('diario');
    expect(JSON.stringify(value)).not.toContain('Privado');
  });
});

// What the whole change is for: contributing to somebody else's folder, and
// having the note land in *their* vault so the share keeps covering it.
describe('writing into a folder shared with write permission', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: FRODO.email,
      permission: 'write',
    });
  });

  it('creates the note in the owner’s vault, not a copy in Frodo’s', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value, error } = await call(frodo, 'create_note', {
      ownerId: OWNER.id,
      path: 'Impulse Labs/reunion.md',
      content: 'lo que hablamos',
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ path: 'Impulse Labs/reunion.md' });

    // The owner sees it as her own, which is the point.
    const owner = await clientFor(OWNER.id);
    const { value: mine } = await call(owner, 'list_notes', {});
    expect(mine).toMatchObject([{ path: 'Impulse Labs/reunion.md' }]);

    // And Frodo's own vault stayed empty: no private copy was made.
    const { value: his } = await call(frodo, 'list_notes', {});
    expect(his).toEqual([]);
  });

  it('lets Frodo read and edit what is in there', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'create_note', { path: 'Impulse Labs/agenda.md', content: 'v1' });

    const frodo = await clientFor(FRODO.id);
    const { value: read } = await call(frodo, 'get_note', {
      ownerId: OWNER.id,
      path: 'Impulse Labs/agenda.md',
    });
    expect(read).toMatchObject({ body: expect.stringContaining('v1') });

    const { error } = await call(frodo, 'update_note', {
      ownerId: OWNER.id,
      path: 'Impulse Labs/agenda.md',
      content: 'v2',
    });
    expect(error).toBeUndefined();

    const { value: after } = await call(owner, 'get_note', { path: 'Impulse Labs/agenda.md' });
    expect(after).toMatchObject({ body: expect.stringContaining('v2') });
  });

  it('list_tree scoped to the owner shows their folder', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'create_note', { path: 'Impulse Labs/agenda.md', content: 'x' });

    const frodo = await clientFor(FRODO.id);
    const { value } = await call(frodo, 'list_tree', {
      ownerId: OWNER.id,
      path: 'Impulse Labs',
    });
    expect(JSON.stringify(value)).toContain('agenda.md');
  });

  it('write permission does not reach outside the shared folder', async () => {
    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_note', {
      ownerId: OWNER.id,
      path: 'Privado/secreto.md',
      content: 'no',
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('a read-only share still refuses the same call', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Solo Lectura',
      email: FRODO.email,
      permission: 'read',
    });

    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_note', {
      ownerId: OWNER.id,
      path: 'Solo Lectura/x.md',
      content: 'no',
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('naming no owner is still ambiguous, and still refused', async () => {
    // Write permission does not make "Impulse Labs/x.md" mean the shared
    // folder: Frodo may well have one of his own.
    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_note', {
      path: 'Impulse Labs/x.md',
      content: 'x',
    });
    expect(error).toContain('FORBIDDEN');
    expect(error).toContain(OWNER.id);
  });
});

// El caso que motivó todo esto, de punta a punta: Frodo cargó Gondor en su
// bóveda personal porque no podía escribir en la compartida, y ahora hay que
// migrarlo sin perder nada.
describe('migrar una carpeta de la bóveda personal a la compartida', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: FRODO.email,
      permission: 'write',
    });
  });

  it('mueve Gondor a la carpeta compartida y lo deja a nombre del dueño', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Gondor/arquitectura.md', content: 'todo' });
    await call(frodo, 'create_note', { path: 'Gondor/sub/api.md', content: 'endpoints' });

    const { value, error } = await call(frodo, 'move_to_owner', {
      from: 'Gondor',
      to: 'Impulse Labs/Gondor',
      toOwnerId: OWNER.id,
      userConfirmedOwnershipTransfer: true,
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ path: 'Impulse Labs/Gondor', movedNotes: 2 });

    // La bóveda de Frodo quedó limpia.
    const { value: his } = await call(frodo, 'list_notes', {});
    expect(his).toEqual([]);

    // Y el dueño las ve como propias, que es lo que mantiene el share cubriéndolas.
    const owner = await clientFor(OWNER.id);
    const { value: hers } = await call(owner, 'list_notes', {});
    expect(hers).toMatchObject([
      { path: expect.stringContaining('Impulse Labs/Gondor/') },
      { path: expect.stringContaining('Impulse Labs/Gondor/') },
    ]);
  });

  it('avisa qué wikilinks dejaron de resolver por el cruce', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Gondor/nota.md', content: 'ver [[personal/idea]]' });
    await call(frodo, 'create_note', { path: 'personal/idea.md', content: 'mía' });

    const { value } = await call(frodo, 'move_to_owner', {
      from: 'Gondor',
      to: 'Impulse Labs/Gondor',
      toOwnerId: OWNER.id,
      userConfirmedOwnershipTransfer: true,
    });
    expect(value).toMatchObject({
      linksLeftDangling: [{ note: 'Impulse Labs/Gondor/nota.md' }],
    });
  });

  it('no deja migrar a una carpeta donde no podés escribir', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Gondor/x.md', content: 'x' });

    const { error } = await call(frodo, 'move_to_owner', {
      from: 'Gondor',
      to: 'Privado/Gondor',
      toOwnerId: OWNER.id,
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('no deja sacar algo de la bóveda de otro sin permiso de escritura', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Solo Lectura',
      email: FRODO.email,
      permission: 'read',
    });
    await call(owner, 'create_note', { path: 'Solo Lectura/ajena.md', content: 'no tocar' });

    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'move_to_owner', {
      from: 'Solo Lectura/ajena.md',
      fromOwnerId: OWNER.id,
      to: 'mio.md',
      toOwnerId: FRODO.id,
    });
    expect(error).toContain('FORBIDDEN');
  });
});

// Dos carpetas con el mismo nombre: una tuya, una que te compartieron.
describe('cuando el nombre coincide con una carpeta propia', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'impulse-labs', email: FRODO.email });
  });

  it('Frodo sigue pudiendo escribir en la suya si dice que es la suya', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value, error } = await call(frodo, 'create_note', {
      ownerId: FRODO.id,
      path: 'impulse-labs/mia.md',
      content: 'esta es mi carpeta, no la de ella',
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ path: 'impulse-labs/mia.md' });
  });

  it('sin decir de quién sigue siendo ambiguo, y se rechaza', async () => {
    const frodo = await clientFor(FRODO.id);
    const { error } = await call(frodo, 'create_note', {
      path: 'impulse-labs/mia.md',
      content: 'x',
    });
    expect(error).toContain('FORBIDDEN');
  });
});

// Crear una carpeta dentro de una compartida decía "creada" y después no
// aparecía: el árbol del dueño leía sólo `notes`, y una carpeta vacía no la
// implica ninguna nota.
describe('una carpeta creada dentro de lo compartido se ve', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Gondor',
      email: FRODO.email,
      permission: 'write',
    });
    await call(owner, 'create_note', { path: 'Gondor/App/x.md', content: 'algo' });
  });

  it('aparece en el árbol apenas se crea, aun estando vacía', async () => {
    const frodo = await clientFor(FRODO.id);

    const { error } = await call(frodo, 'create_folder', {
      ownerId: OWNER.id,
      path: 'Gondor/App/prueba3',
    });
    expect(error).toBeUndefined();

    const { value } = await call(frodo, 'list_tree', {
      ownerId: OWNER.id,
      path: 'Gondor',
    });
    expect(JSON.stringify(value)).toContain('prueba3');
  });

  it('el dueño la ve igual que quien la creó', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_folder', { ownerId: OWNER.id, path: 'Gondor/App/prueba3' });

    const owner = await clientFor(OWNER.id);
    const { value } = await call(owner, 'list_tree', { path: 'Gondor' });
    expect(JSON.stringify(value)).toContain('prueba3');
  });
});

// Mover entre bóvedas transfiere la propiedad, y por MCP eso ocurría sin que
// nada se lo dijera al modelo: la respuesta traía un path y un conteo de links,
// así que un asistente podía informar "listo, movido" mientras la otra persona
// acababa de dejar de ser dueña de sus notas — o de verlas.
describe('move_to_owner avisa lo que la transferencia le costó al dueño anterior', () => {
  const setup = async (): Promise<Client> => {
    const owner = await clientFor(OWNER.id);
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', { path: 'Gondor/arquitectura.md', content: 'a' });
    await sharing.grant({
      ownerId: FRODO.id,
      sharedWithUserId: OWNER.id,
      folderPath: 'Gondor',
      grantedBy: FRODO.id,
      permission: 'write',
    });
    return owner;
  };

  const move = async (client: Client, confirmed = true) =>
    call(client, 'move_to_owner', {
      from: 'Gondor',
      fromOwnerId: FRODO.id,
      to: 'mio/Gondor',
      toOwnerId: OWNER.id,
      ...(confirmed ? { userConfirmedOwnershipTransfer: true } : {}),
    });

  it('sin la confirmación no mueve nada, y dice qué habría costado', async () => {
    const owner = await setup();

    const { value } = (await move(owner, false)) as {
      value: { moved: boolean; wouldTransfer: Record<string, unknown>; askTheUser: string };
    };

    expect(value.moved).toBe(false);
    expect(value.wouldTransfer).toMatchObject({
      notes: 1,
      fromOwnerId: FRODO.id,
      toOwnerId: OWNER.id,
      previousOwnerAccessAfterwards: 'none',
    });
    expect(value.askTheUser).toMatch(/no access at all/);

    // Y lo importante: la nota sigue siendo de Frodo.
    const frodo = await clientFor(FRODO.id);
    const { value: mias } = (await call(frodo, 'list_notes', {})) as {
      value: Array<{ path: string }>;
    };
    expect(mias.map((n) => n.path)).toEqual(['Gondor/arquitectura.md']);
  });

  it('dice que el dueño anterior se quedó sin ver nada cuando el destino no vuelve', async () => {
    const owner = await setup();

    const { value } = (await move(owner)) as { value: { ownership: Record<string, string> } };

    expect(value.ownership.previousOwnerId).toBe(FRODO.id);
    expect(value.ownership.newOwnerId).toBe(OWNER.id);
    expect(value.ownership.previousOwnerAccess).toBe('none');
    expect(value.ownership.tellTheUser).toMatch(/no longer see them at all/);
  });

  it('distingue quedarse sólo con lectura de conservar la escritura', async () => {
    const owner = await setup();
    await sharing.grant({
      ownerId: OWNER.id,
      sharedWithUserId: FRODO.id,
      folderPath: 'mio',
      grantedBy: OWNER.id,
      permission: 'read',
    });

    const { value } = (await move(owner)) as { value: { ownership: Record<string, string> } };

    expect(value.ownership.previousOwnerAccess).toBe('read');
    expect(value.ownership.tellTheUser).toMatch(/only read/);
  });

  it('reconoce cuando conserva la escritura por el destino compartido', async () => {
    const owner = await setup();
    await sharing.grant({
      ownerId: OWNER.id,
      sharedWithUserId: FRODO.id,
      folderPath: 'mio',
      grantedBy: OWNER.id,
      permission: 'write',
    });

    const { value } = (await move(owner)) as { value: { ownership: Record<string, string> } };

    expect(value.ownership.previousOwnerAccess).toBe('write');
  });

  it('la descripción de la herramienta avisa antes de que se llame', async () => {
    const client = await clientFor(OWNER.id);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'move_to_owner');

    // Lo que lee el modelo cuando decide si llamarla.
    expect(tool?.description).toMatch(/TRANSFERS OWNERSHIP/);
    expect(tool?.description).toMatch(/ALWAYS tell the user/);
    expect(tool?.description).toMatch(/moves nothing/);
  });
});

/*
 * Lo que Frodo vivió: la nota existía, la carpeta estaba compartida con él, y
 * cada herramienta le contestó que no existía. Sin `ownerId` el path se resolvía
 * contra su propia bóveda y ahí no estaba — el server sabía que caía bajo una
 * carpeta compartida y se lo callaba.
 */
describe('leer un path que cae bajo una carpeta compartida, sin decir de quién', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'impulse-labs',
      email: FRODO.email,
      permission: 'write',
    });
    await call(owner, 'create_note', {
      path: 'impulse-labs/erebor/comercial/planes-y-pricing.md',
      content: 'los tres planes',
    });
  });

  it('get_note encuentra la nota en la bóveda de quien la compartió', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value, error } = await call(frodo, 'get_note', {
      path: 'impulse-labs/erebor/comercial/planes-y-pricing.md',
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ body: expect.stringContaining('los tres planes') });
  });

  it('list_notes y list_tree miran la misma carpeta', async () => {
    const frodo = await clientFor(FRODO.id);

    const { value: rows } = await call(frodo, 'list_notes', { folder: 'impulse-labs' });
    expect(rows).toMatchObject([{ path: 'impulse-labs/erebor/comercial/planes-y-pricing.md' }]);

    const { value: tree } = await call(frodo, 'list_tree', { path: 'impulse-labs' });
    expect(JSON.stringify(tree)).toContain('planes-y-pricing.md');
  });

  it('la bóveda propia gana cuando ahí hay algo', async () => {
    const frodo = await clientFor(FRODO.id);
    await call(frodo, 'create_note', {
      ownerId: FRODO.id,
      path: 'impulse-labs/mis-notas.md',
      content: 'lo mío',
    });

    const { value } = await call(frodo, 'get_note', { path: 'impulse-labs/mis-notas.md' });
    expect(value).toMatchObject({ body: expect.stringContaining('lo mío') });

    // Y la carpeta compartida sigue estando para lo que no tiene: cuál de las
    // dos bóvedas responde se decide por path, no de una vez por la carpeta.
    const { error } = await call(frodo, 'get_note', {
      path: 'impulse-labs/erebor/comercial/planes-y-pricing.md',
    });
    expect(error).toBeUndefined();
  });

  it('no abre nada que no esté compartido', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'create_note', { path: 'privado/sueldos.md', content: 'la planilla' });

    const frodo = await clientFor(FRODO.id);
    const { value, error } = await call(frodo, 'get_note', { path: 'privado/sueldos.md' });
    expect(error ?? JSON.stringify(value)).not.toContain('la planilla');
    expect(error).toBeDefined();
  });

  it('search_brain sin scope encuentra lo compartido', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value } = await call(frodo, 'search_brain', { query: 'planes' });
    expect(value).toMatchObject([
      { path: 'impulse-labs/erebor/comercial/planes-y-pricing.md', ownerId: OWNER.id },
    ]);
  });

  it('scope "mine" sigue siendo la manera de mirar sólo lo propio', async () => {
    const frodo = await clientFor(FRODO.id);
    const { value } = await call(frodo, 'search_brain', { query: 'planes', scope: 'mine' });
    expect(value).toEqual([]);
  });
});
