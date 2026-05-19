import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapturingEmailSender } from './EmailSender.js';
import { InviteService } from './InviteService.js';
import { SharingService } from './SharingService.js';

let bs: BrainStackDatabase;
let sharing: SharingService;
let email: CapturingEmailSender;
let svc: InviteService;
let now = 1_000_000;

function seedUser(id: string, em: string): void {
  bs.sqlite
    .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, em, now, now);
}

beforeEach(() => {
  bs = openDatabase(':memory:');
  now = 1_000_000;
  sharing = new SharingService({ db: bs, deployment: 'hosted', now: () => ++now });
  email = new CapturingEmailSender();
  svc = new InviteService({
    db: bs,
    email,
    sharing,
    publicOrigin: 'https://app.test',
    now: () => ++now,
  });
  seedUser('owner', 'o@x.com');
  seedUser('alice', 'a@x.com');
});

afterEach(() => bs.close());

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

    const out = svc.accept({
      token: inv.token,
      user: { id: 'alice', email: 'a@x.com' },
    });
    expect(out.folderPath).toBe('proyectos');
    expect(sharing.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
  });

  it('rechaza accept con email distinto', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    seedUser('eve', 'e@x.com');
    expect(() =>
      svc.accept({ token: inv.token, user: { id: 'eve', email: 'e@x.com' } }),
    ).toThrow(/otro email/);
  });

  it('email mode es single-use', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'email',
      inviteeEmail: 'a@x.com',
    });
    svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    expect(() =>
      svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } }),
    ).toThrow(/ya aceptada/);
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

    svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } });
    seedUser('bob', 'b@x.com');
    svc.accept({ token: inv.token, user: { id: 'bob', email: 'b@x.com' } });

    expect(sharing.canRead('alice', 'owner', 'p/x.md')).toBe(true);
    expect(sharing.canRead('bob', 'owner', 'p/x.md')).toBe(true);
  });

  it('no permite aceptar tu propia invite', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    expect(() =>
      svc.accept({ token: inv.token, user: { id: 'owner', email: 'o@x.com' } }),
    ).toThrow(/propia invitación/);
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
    expect(() =>
      svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } }),
    ).toThrow(/expirada/);
  });

  it('revoke bloquea accept', async () => {
    const inv = await svc.create({
      ownerId: 'owner',
      folderPath: 'p',
      mode: 'link',
    });
    svc.revoke('owner', inv.inviteId);
    expect(() =>
      svc.accept({ token: inv.token, user: { id: 'alice', email: 'a@x.com' } }),
    ).toThrow(/revocada/);
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
    svc.accept({ token: b.token, user: { id: 'alice', email: 'a@x.com' } });
    const out = svc.listPending('owner');
    expect(out.map((p) => p.id)).toEqual([a.inviteId]);
  });
});
