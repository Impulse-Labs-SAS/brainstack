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
  return { value: JSON.parse(text) as unknown };
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
