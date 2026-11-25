import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CapturingEmailSender } from './EmailSender.js';
import { InviteService } from './InviteService.js';
import { SharingService } from './SharingService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

let database: TestDatabase;
let sharing: SharingService;
let email: CapturingEmailSender;
let svc: InviteService;
let now = 1_000_000;

async function seedUser(id: string, em: string): Promise<void> {
  await database.db.insert(users).values({ id, email: em, createdAt: now, updatedAt: now });
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  now = 1_000_000;
  sharing = new SharingService({ db: database.db, now: () => ++now });
  email = new CapturingEmailSender();
  svc = new InviteService({
    db: database.db,
    email,
    sharing,
    publicOrigin: 'https://app.test',
    now: () => ++now,
  });
  await seedUser('owner', 'o@x.com');
  await seedUser('alice', 'a@x.com');
});

describe('InviteService — email mode', () => {
  it('creates an invite, emails it and accepts it for the right address', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'proyectos',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe('a@x.com');
    expect(email.sent[0]!.text).toContain(inv.acceptUrl);

    const out = await svc.accept({
      token: inv.token,
      user: { id: 'alice', email: 'a@x.com' },
    });
    expect(out.folderPath).toBe('proyectos');
    expect(await sharing.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
  });

  it('refuses to accept for a different address', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    await seedUser('eve', 'e@x.com');
    await expect(svc.accept({ token: inv.token, user: { id: 'eve', email: 'e@x.com' } })).rejects.toThrow(/different email/);
  });

  it('email mode es single-use', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    await svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    await expect(svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } })).rejects.toThrow(/already accepted/);
  });
});

describe('InviteService — link mode', () => {
  it('cualquier user logueado puede aceptar y es multi-use', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    expect(email.sent).toHaveLength(0);

    await svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    await seedUser('bob', 'b@x.com');
    await svc.accept({ token: inv.token, user: { id: 'bob', email: 'b@x.com' } });

    expect(await sharing.canRead('alice', 'owner', 'p/x.md')).toBe(true);
    expect(await sharing.canRead('bob', 'owner', 'p/x.md')).toBe(true);
  });

  it('no permite aceptar tu propia invite', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    await expect(svc.accept({ token: inv.token, user: { id: 'owner', email: 'o@x.com' } })).rejects.toThrow(/your own invitation/);
  });
});

describe('InviteService — expiry and revocation', () => {
  it('refuses expired tokens', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    now = inv.expiresAt + 1000;
    await expect(svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } })).rejects.toThrow(/expired/);
  });

  it('revoke bloquea accept', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    await svc.revoke('owner', inv.inviteId);
    await expect(svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } })).rejects.toThrow(/revoked/);
  });

  it('listPending leaves out accepted, revoked and expired invites', async () => {
    const a = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    const b = await svc.create({
      ownerId: 'owner',
      folderPath: 'q',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    await svc.accept({ token: b.token, user: { id: 'alice', email: 'a@x.com' } });
    const out = await svc.listPending('owner');
    expect(out.map((p) => p.id)).toEqual([a.inviteId]);
  });
});

/**
 * The hole this closes: a link invite is reusable on purpose, so revoking
 * someone's access used to leave them a way straight back in. Found by walking
 * the app by hand — alice was removed from a folder and returned with the same
 * URL seconds later.
 */
describe('revoking access closes the way back in', () => {
  it('alice cannot come back with the same link once it is revoked', async () => {
    const inv = await svc.create({ ownerId: 'owner', folderPath: 'proyectos', mode: 'link' });
    await svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    expect(await sharing.canRead('alice', 'owner', 'proyectos/nota.md')).toBe(true);

    await sharing.revoke({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
    });
    expect(await sharing.canRead('alice', 'owner', 'proyectos/nota.md')).toBe(false);

    await expect(
      svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } }),
    ).rejects.toThrow(/revoked/);
    expect(await sharing.canRead('alice', 'owner', 'proyectos/nota.md')).toBe(false);
  });

  it('also ends the email invitation that was still pending', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'proyectos',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    await sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });

    await sharing.revoke({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
    });

    await expect(
      svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } }),
    ).rejects.toThrow(/revoked/);
  });

  it('leaves links to other folders alone', async () => {
    const otra = await svc.create({ ownerId: 'owner', folderPath: 'otra', mode: 'link' });
    await sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });

    await sharing.revoke({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
    });

    const out = await svc.accept({ token: otra.token, user: { id: 'alice', email: 'a@x.com' } });
    expect(out.folderPath).toBe('otra');
  });

  it('whoever already joined keeps access: only the way back is closed', async () => {
    await seedUser('bob', 'b@x.com');
    const inv = await svc.create({ ownerId: 'owner', folderPath: 'proyectos', mode: 'link' });
    await svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    await svc.accept({ token: inv.token, user: { id: 'bob', email: 'b@x.com' } });

    await sharing.revoke({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
    });

    expect(await sharing.canRead('bob', 'owner', 'proyectos/nota.md')).toBe(true);
    expect(await sharing.canRead('alice', 'owner', 'proyectos/nota.md')).toBe(false);
  });
});

/*
 * The link is all the invitee sees, and it pointed at the frontend's origin
 * without the API prefix: `/invite/accept/:token` is not a page, so every
 * invitation ended on Next's 404.
 */
describe('InviteService — acceptUrl', () => {
  it('points at the server endpoint, behind the API prefix', async () => {
    const conPrefijo = new InviteService({
      db: database.db,
      email,
      sharing,
      publicOrigin: 'https://app.test',
      apiBasePath: '/api',
      now: () => ++now,
    });
    const inv = await conPrefijo.create({
      ownerId: 'owner',
      folderPath: 'proyectos',
      mode: 'link',
    });
    expect(inv.acceptUrl).toBe(`https://app.test/api/invite/accept/${inv.token}`);
  });

  it('with no prefix configured it sits at the origin root', async () => {
    const inv = await svc.create({ ownerId: 'owner', folderPath: 'proyectos', mode: 'link' });
    expect(inv.acceptUrl).toBe(`https://app.test/invite/accept/${inv.token}`);
  });
});
