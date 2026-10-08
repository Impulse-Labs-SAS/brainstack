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
  it('crea invite, manda email y permite accept por el email correcto', async () => {
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

  it('rechaza accept con email distinto', async () => {
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

describe('InviteService — expiración y revocación', () => {
  it('rechaza tokens expirados', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    now = inv.expiresAt + 1000;
    await expect(svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } })).rejects.toThrow(/expirada/);
  });

  it('revoke bloquea accept', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    await svc.revoke('owner', inv.inviteId);
    await expect(svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } })).rejects.toThrow(/revocada/);
  });

  it('listPending no incluye aceptadas, revocadas ni expiradas', async () => {
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
describe('revocar el acceso cierra la puerta de atrás', () => {
  it('alice no puede volver con el mismo link tras ser revocada', async () => {
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
    ).rejects.toThrow(/revocada/);
    expect(await sharing.canRead('alice', 'owner', 'proyectos/nota.md')).toBe(false);
  });

  it('también mata la invitación por email que seguía pendiente', async () => {
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
    ).rejects.toThrow(/revocada/);
  });

  it('no toca los links de otras carpetas', async () => {
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

  it('quien ya entró conserva el acceso: sólo se cierra el regreso', async () => {
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
 * El link es lo único que el invitado ve, y apuntaba al origin del frontend sin
 * el prefijo de la API: `/invite/accept/:token` no es una página, así que cada
 * invitación terminaba en el 404 de Next.
 */
describe('InviteService — acceptUrl', () => {
  it('apunta al endpoint del server, detrás del prefijo de la API', async () => {
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

  it('sin prefijo configurado queda en la raíz del origin', async () => {
    const inv = await svc.create({ ownerId: 'owner', folderPath: 'proyectos', mode: 'link' });
    expect(inv.acceptUrl).toBe(`https://app.test/invite/accept/${inv.token}`);
  });
});
