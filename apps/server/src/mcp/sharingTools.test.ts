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
const PABLO = { id: 'pablo', email: 'pablo@x.com' };

let database: TestDatabase;
let email: CapturingEmailSender;
let sharing: SharingService;

/** An MCP client talking to a server that acts as `userId`. */
async function clientFor(userId: string): Promise<Client> {
  const vaultCfg = { deployment: 'hosted' as const };
  const notes = new NoteService({ cfg: vaultCfg, db: database.db });
  const search = new SearchService({ db: database.db, cfg: vaultCfg });
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

  const server = buildMcpServer({
    notes,
    search,
    sharing,
    auth,
    invites,
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
  sharing = new SharingService({ db: database.db, deployment: 'hosted' });
  for (const u of [OWNER, PABLO]) {
    await database.db
      .insert(users)
      .values({ id: u.id, email: u.email, createdAt: Date.now(), updatedAt: 0 });
  }
});

describe('the sharing tools exist at all', () => {
  it('exposes both sides of sharing in hosted', async () => {
    const client = await clientFor(OWNER.id);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['share_folder', 'unshare', 'list_shares', 'list_shared_with_me']),
    );
  });

  it('hides them in self-host, where there is nobody to share with', async () => {
    sharing = new SharingService({ db: database.db, deployment: 'self-host' });
    const client = await clientFor(OWNER.id);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of ['share_folder', 'unshare', 'list_shares', 'list_shared_with_me']) {
      expect(names).not.toContain(tool);
    }
  });
});

describe('share_folder', () => {
  it('grants straight away when the email already has an account', async () => {
    const owner = await clientFor(OWNER.id);
    const { value } = await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: PABLO.email,
    });

    expect(value).toMatchObject({
      status: 'granted',
      folderPath: 'Impulse Labs',
      sharedWith: { userId: PABLO.id, email: PABLO.email },
    });
    expect(email.sent).toHaveLength(0);
    expect(await sharing.canRead(PABLO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);
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
    const { error } = await call(owner, 'share_folder', { path: '/', email: PABLO.email });
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
    const a = await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });
    const b = await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });
    expect((a.value as { shareId: string }).shareId).toBe((b.value as { shareId: string }).shareId);
    expect(await sharing.listMyShares(OWNER.id)).toHaveLength(1);
  });
});

describe('list_shares', () => {
  it('lists who can read what, and filters by folder', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });

    const all = (await call(owner, 'list_shares')).value as Array<{ folderPath: string }>;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ folderPath: 'Impulse Labs', email: PABLO.email });

    const hit = (await call(owner, 'list_shares', { path: '/Impulse Labs/' })).value;
    expect(hit).toHaveLength(1);

    const miss = (await call(owner, 'list_shares', { path: 'Otra' })).value;
    expect(miss).toHaveLength(0);
  });

  it('shows nothing to someone who shared nothing', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });

    const pablo = await clientFor(PABLO.id);
    expect((await call(pablo, 'list_shares')).value).toHaveLength(0);
  });
});

describe('list_shared_with_me', () => {
  // The regression: this used to answer `{}` because the promise was never
  // awaited. Asserting on the contents is what pins it.
  it('returns the folders shared with me, not an empty object', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });

    const pablo = await clientFor(PABLO.id);
    const rows = (await call(pablo, 'list_shared_with_me')).value;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect((rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      folderPath: 'Impulse Labs',
      ownerId: OWNER.id,
      ownerEmail: OWNER.email,
    });
  });

  it('is empty for someone nobody shared with', async () => {
    const pablo = await clientFor(PABLO.id);
    expect((await call(pablo, 'list_shared_with_me')).value).toEqual([]);
  });
});

describe('unshare', () => {
  it('takes the access away', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });
    expect(await sharing.canRead(PABLO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);

    const { value } = await call(owner, 'unshare', {
      path: 'Impulse Labs',
      email: PABLO.email,
    });
    expect(value).toMatchObject({ status: 'revoked' });
    expect(await sharing.canRead(PABLO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(false);
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
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });

    // Pablo asking to unshare names himself as the owner, and owns nothing.
    const pablo = await clientFor(PABLO.id);
    await call(pablo, 'unshare', { path: 'Impulse Labs', email: OWNER.email });

    expect(await sharing.canRead(PABLO.id, OWNER.id, 'Impulse Labs/nota.md')).toBe(true);
  });
});

// The bug this guard exists for, driven end to end.
//
// Pablo had read access to "Impulse Labs" and asked his assistant to write in
// it. No note tool takes an owner, so the path resolved against Pablo's own
// vault: the write succeeded, created a folder of the same name under him, and
// told him it had worked. He believed he had contributed to the shared folder.
// Nobody else ever saw the note.
describe('writing to a path that names somebody else’s shared folder', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', { path: 'Impulse Labs', email: PABLO.email });
  });

  it('refuses create_folder instead of making a private copy', async () => {
    const pablo = await clientFor(PABLO.id);
    const { error } = await call(pablo, 'create_folder', { path: 'Impulse Labs' });

    expect(error).toBeDefined();
    expect(error).toContain('FORBIDDEN');
    // The message has to name the owner, or the error is just as confusing as
    // the silence it replaced.
    expect(error).toContain(OWNER.email);
  });

  it('refuses create_note anywhere under it, however deep', async () => {
    const pablo = await clientFor(PABLO.id);
    const { error } = await call(pablo, 'create_note', {
      path: 'Impulse Labs/reuniones/2026-08-25.md',
      content: '# Reunión',
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('leaves nothing behind when it refuses', async () => {
    const pablo = await clientFor(PABLO.id);
    await call(pablo, 'create_note', { path: 'Impulse Labs/nota.md', content: 'x' });

    const { value } = await call(pablo, 'list_notes', {});
    expect(value).toEqual([]);
  });

  it('still lets Pablo write his own folders', async () => {
    const pablo = await clientFor(PABLO.id);
    const { value } = await call(pablo, 'create_note', {
      path: 'mis-cosas/idea.md',
      content: 'mía',
    });
    expect(value).toMatchObject({ path: 'mis-cosas/idea.md' });
  });

  it('does not stop a name that merely starts the same', async () => {
    const pablo = await clientFor(PABLO.id);
    const { value } = await call(pablo, 'create_note', {
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
    const pablo = await clientFor(PABLO.id);
    await call(pablo, 'create_note', { path: 'mis-cosas/idea.md', content: 'una idea' });

    const { value } = await call(pablo, 'list_notes', {});
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'mis-cosas/idea.md' }]);
  });

  it('list_decisions returns the notes flagged as decisions', async () => {
    const pablo = await clientFor(PABLO.id);
    await call(pablo, 'create_note', {
      path: 'decisiones/usar-pg.md',
      content: 'vamos con Postgres',
      // By tag: `listDecisions` matches on the tag alone, despite the tool
      // description also promising `status: decidido`.
      frontmatter: { tags: ['decisión'] },
    });

    const { value } = await call(pablo, 'list_decisions', {});
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ path: 'decisiones/usar-pg.md' }]);
  });

  it('list_links returns the backlinks of a note', async () => {
    const pablo = await clientFor(PABLO.id);
    await call(pablo, 'create_note', { path: 'destino.md', content: 'acá se llega' });
    await call(pablo, 'create_note', { path: 'origen.md', content: 'ver [[destino]]' });

    const { value } = await call(pablo, 'list_links', { path: 'destino.md' });
    expect(Array.isArray(value)).toBe(true);
    expect(value).toMatchObject([{ sourcePath: 'origen.md' }]);
  });
});

// What the whole change is for: contributing to somebody else's folder, and
// having the note land in *their* vault so the share keeps covering it.
describe('writing into a folder shared with write permission', () => {
  beforeEach(async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'share_folder', {
      path: 'Impulse Labs',
      email: PABLO.email,
      permission: 'write',
    });
  });

  it('creates the note in the owner’s vault, not a copy in Pablo’s', async () => {
    const pablo = await clientFor(PABLO.id);
    const { value, error } = await call(pablo, 'create_note', {
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

    // And Pablo's own vault stayed empty: no private copy was made.
    const { value: his } = await call(pablo, 'list_notes', {});
    expect(his).toEqual([]);
  });

  it('lets Pablo read and edit what is in there', async () => {
    const owner = await clientFor(OWNER.id);
    await call(owner, 'create_note', { path: 'Impulse Labs/agenda.md', content: 'v1' });

    const pablo = await clientFor(PABLO.id);
    const { value: read } = await call(pablo, 'get_note', {
      ownerId: OWNER.id,
      path: 'Impulse Labs/agenda.md',
    });
    expect(read).toMatchObject({ body: expect.stringContaining('v1') });

    const { error } = await call(pablo, 'update_note', {
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

    const pablo = await clientFor(PABLO.id);
    const { value } = await call(pablo, 'list_tree', {
      ownerId: OWNER.id,
      path: 'Impulse Labs',
    });
    expect(JSON.stringify(value)).toContain('agenda.md');
  });

  it('write permission does not reach outside the shared folder', async () => {
    const pablo = await clientFor(PABLO.id);
    const { error } = await call(pablo, 'create_note', {
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
      email: PABLO.email,
      permission: 'read',
    });

    const pablo = await clientFor(PABLO.id);
    const { error } = await call(pablo, 'create_note', {
      ownerId: OWNER.id,
      path: 'Solo Lectura/x.md',
      content: 'no',
    });
    expect(error).toContain('FORBIDDEN');
  });

  it('naming no owner is still ambiguous, and still refused', async () => {
    // Write permission does not make "Impulse Labs/x.md" mean the shared
    // folder: Pablo may well have one of his own.
    const pablo = await clientFor(PABLO.id);
    const { error } = await call(pablo, 'create_note', {
      path: 'Impulse Labs/x.md',
      content: 'x',
    });
    expect(error).toContain('FORBIDDEN');
    expect(error).toContain(OWNER.id);
  });
});
