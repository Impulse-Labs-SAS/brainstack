import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';

import { SharingService, normalizeFolderPath, pathFallsUnder } from './SharingService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

let database: TestDatabase;
let svc: SharingService;
let t = 0;

async function seedUser(id: string, email: string): Promise<void> {
  await database.db.insert(users).values({ id, email, createdAt: Date.now(), updatedAt: 0 });
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  t = 1_000_000;
  svc = new SharingService({ db: database.db, deployment: 'hosted', now: () => ++t });
  await seedUser('owner', 'o@x.com');
  await seedUser('alice', 'a@x.com');
  await seedUser('bob', 'b@x.com');
});

describe('normalizeFolderPath / pathFallsUnder', () => {
  it('normaliza slashes', async () => {
    expect(normalizeFolderPath('/foo/bar/')).toBe('foo/bar');
    expect(normalizeFolderPath('\\foo\\')).toBe('foo');
    expect(normalizeFolderPath('')).toBe('');
  });

  it('pathFallsUnder cubre igualdad y prefijo', async () => {
    expect(pathFallsUnder('proyectos/x.md', 'proyectos')).toBe(true);
    expect(pathFallsUnder('proyectos', 'proyectos')).toBe(true);
    expect(pathFallsUnder('proyectos2/x.md', 'proyectos')).toBe(false);
    expect(pathFallsUnder('otra/x.md', 'proyectos')).toBe(false);
  });
});

describe('SharingService — self-host', () => {
  it('canRead/canWrite siempre true; listSharedRoots vacío', async () => {
    const selfHost = new SharingService({ db: database.db, deployment: 'self-host' });
    expect(await selfHost.canRead('alice', 'owner', 'anything')).toBe(true);
    expect(selfHost.canWrite('alice', 'owner', 'anything')).toBe(true);
    expect(await selfHost.listSharedRoots('alice')).toEqual([]);
    expect(await selfHost.listMyShares('owner')).toEqual([]);
  });

  it('grant tira FORBIDDEN en self-host', async () => {
    const selfHost = new SharingService({ db: database.db, deployment: 'self-host' });
    await expect(selfHost.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: 'x',
        grantedBy: 'owner',
      })).rejects.toThrow(AppError);
  });
});

describe('SharingService — hosted: canRead/canWrite', () => {
  it('dueño siempre puede leer/escribir', async () => {
    expect(await svc.canRead('owner', 'owner', 'cualquiera/x.md')).toBe(true);
    expect(svc.canWrite('owner', 'owner', 'cualquiera/x.md')).toBe(true);
  });

  it('user sin grant no puede leer ni escribir', async () => {
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
  });

  it('grant habilita read pero no write (V1 read-only)', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
    expect(await svc.canRead('alice', 'owner', 'proyectos/sub/y.md')).toBe(true);
    expect(svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(await svc.canRead('alice', 'owner', 'otra/x.md')).toBe(false);
  });

  it('assertCanRead throw FORBIDDEN sin grant', async () => {
    await expect(svc.assertCanRead('alice', 'owner', 'p/x.md')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('SharingService — grant / revoke', () => {
  it('grant es idempotente: dos llamadas misma fila', async () => {
    const id1 = await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const id2 = await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: '/p/',
      grantedBy: 'owner',
    });
    expect(id1).toBe(id2);
  });

  it('grant rechaza root y self-share', async () => {
    await expect(svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: '/',
        grantedBy: 'owner',
      })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    await expect(svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'owner',
        folderPath: 'x',
        grantedBy: 'owner',
      })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('revoke quita el grant', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    expect(await svc.canRead('alice', 'owner', 'p/x.md')).toBe(true);
    await svc.revoke({ ownerId: 'owner', sharedWithUserId: 'alice', folderPath: 'p' });
    expect(await svc.canRead('alice', 'owner', 'p/x.md')).toBe(false);
  });
});

describe('SharingService — listing', () => {
  it('listSharedRoots devuelve metadata del dueño', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const out = await svc.listSharedRoots('alice');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      folderPath: 'p',
      ownerId: 'owner',
      ownerEmail: 'o@x.com',
    });
  });

  it('listMyShares agrupa por folder', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'bob',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const out = await svc.listMyShares('owner');
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.email).sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});
