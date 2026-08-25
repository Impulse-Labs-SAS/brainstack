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
    expect(await selfHost.canWrite('alice', 'owner', 'anything')).toBe(true);
    expect(await selfHost.listSharedRoots('alice')).toEqual([]);
    expect(await selfHost.listMyShares('owner')).toEqual([]);
  });

  it('grant tira FORBIDDEN en self-host', async () => {
    const selfHost = new SharingService({ db: database.db, deployment: 'self-host' });
    await expect(
      selfHost.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: 'x',
        grantedBy: 'owner',
      }),
    ).rejects.toThrow(AppError);
  });
});

describe('SharingService — hosted: canRead/canWrite', () => {
  it('dueño siempre puede leer/escribir', async () => {
    expect(await svc.canRead('owner', 'owner', 'cualquiera/x.md')).toBe(true);
    expect(await svc.canWrite('owner', 'owner', 'cualquiera/x.md')).toBe(true);
  });

  it('user sin grant no puede leer ni escribir', async () => {
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
  });

  it('un grant de write habilita las dos cosas', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
      permission: 'write',
    });
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(true);
    expect(await svc.canWrite('alice', 'owner', 'proyectos/sub/y.md')).toBe(true);
    // El grant no se desborda fuera de su carpeta.
    expect(await svc.canWrite('alice', 'owner', 'otra/x.md')).toBe(false);
  });

  it('re-grant cambia el permiso en vez de no hacer nada', async () => {
    const first = await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);

    const second = await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
      permission: 'write',
    });

    // La misma fila, con otro permiso: subir a write no duplica el share.
    expect(second).toBe(first);
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(true);

    // Y baja igual de bien.
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
      permission: 'read',
    });
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
  });

  it('entre grants anidados gana el más ancho, sin importar el orden', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
      permission: 'read',
    });
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos/abierto',
      grantedBy: 'owner',
      permission: 'write',
    });

    // El read del padre no cancela el write del hijo.
    expect(await svc.canWrite('alice', 'owner', 'proyectos/abierto/x.md')).toBe(true);
    // Y el write del hijo no se derrama sobre el resto del padre.
    expect(await svc.canWrite('alice', 'owner', 'proyectos/otro/x.md')).toBe(false);
    expect(await svc.canRead('alice', 'owner', 'proyectos/otro/x.md')).toBe(true);
  });

  it('las listas dicen qué permiso tiene cada share', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
      permission: 'write',
    });
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'bob',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });

    const roots = await svc.listSharedRoots('alice');
    expect(roots).toMatchObject([{ folderPath: 'proyectos', permission: 'write' }]);

    const members = await svc.listMyShares('owner');
    expect(members.find((m) => m.userId === 'alice')?.permission).toBe('write');
    expect(members.find((m) => m.userId === 'bob')?.permission).toBe('read');
  });

  it('un grant sin permiso explícito es de lectura', async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    expect(await svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
    expect(await svc.canRead('alice', 'owner', 'proyectos/sub/y.md')).toBe(true);
    expect(await svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(await svc.canRead('alice', 'owner', 'otra/x.md')).toBe(false);
  });

  it('assertCanRead throw FORBIDDEN sin grant', async () => {
    await expect(svc.assertCanRead('alice', 'owner', 'p/x.md')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe("SharingService — writes that name somebody else's shared folder", () => {
  beforeEach(async () => {
    await svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'impulse-labs',
      grantedBy: 'owner',
    });
  });

  it('findShadowedShare reconoce la carpeta y quién la comparte', async () => {
    const hit = await svc.findShadowedShare('alice', 'impulse-labs/nota.md');
    expect(hit?.folderPath).toBe('impulse-labs');
    expect(hit?.ownerId).toBe('owner');
    expect(hit?.ownerEmail).toBe('o@x.com');
  });

  it('cubre la carpeta misma y todo lo que cuelga', async () => {
    expect(await svc.findShadowedShare('alice', 'impulse-labs')).not.toBeNull();
    expect(await svc.findShadowedShare('alice', 'impulse-labs/sub/hondo.md')).not.toBeNull();
  });

  it('no se pasa a un nombre que solo empieza igual', async () => {
    expect(await svc.findShadowedShare('alice', 'impulse-labs-viejo/x.md')).toBeNull();
    expect(await svc.findShadowedShare('alice', 'otra/x.md')).toBeNull();
  });

  it('assertNotShadowingShare frena la escritura y dice de quién es', async () => {
    await expect(svc.assertNotShadowingShare('alice', 'impulse-labs/nota.md')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    await expect(svc.assertNotShadowingShare('alice', 'impulse-labs/nota.md')).rejects.toThrow(
      /o@x\.com/,
    );
  });

  it('deja pasar los paths propios, que son el caso normal', async () => {
    await expect(svc.assertNotShadowingShare('alice', 'mis-cosas/x.md')).resolves.toBeUndefined();
  });

  it('al dueño no lo frena su propia carpeta', async () => {
    // `owner` la comparte, no la recibe: para él el nombre no es ambiguo.
    expect(await svc.findShadowedShare('owner', 'impulse-labs/nota.md')).toBeNull();
    await expect(
      svc.assertNotShadowingShare('owner', 'impulse-labs/nota.md'),
    ).resolves.toBeUndefined();
  });

  it('a un tercero sin grant tampoco, porque para él la carpeta no existe', async () => {
    expect(await svc.findShadowedShare('bob', 'impulse-labs/nota.md')).toBeNull();
  });

  it('en self-host no aplica: no hay con quién confundirse', async () => {
    const selfHost = new SharingService({ db: database.db, deployment: 'self-host' });
    expect(await selfHost.findShadowedShare('alice', 'impulse-labs/nota.md')).toBeNull();
    await expect(
      selfHost.assertNotShadowingShare('alice', 'impulse-labs/nota.md'),
    ).resolves.toBeUndefined();
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
    await expect(
      svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: '/',
        grantedBy: 'owner',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    await expect(
      svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'owner',
        folderPath: 'x',
        grantedBy: 'owner',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
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
