import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';

import { SharingService, normalizeFolderPath, pathFallsUnder } from './SharingService.js';

let bs: BrainStackDatabase;
let svc: SharingService;
let t = 0;

function seedUser(id: string, email: string): void {
  bs.sqlite
    .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, email, Date.now(), Date.now());
}

beforeEach(() => {
  bs = openDatabase(':memory:');
  t = 1_000_000;
  svc = new SharingService({ db: bs, deployment: 'hosted', now: () => ++t });
  seedUser('owner', 'o@x.com');
  seedUser('alice', 'a@x.com');
  seedUser('bob', 'b@x.com');
});

afterEach(() => {
  bs.close();
});

describe('normalizeFolderPath / pathFallsUnder', () => {
  it('normaliza slashes', () => {
    expect(normalizeFolderPath('/foo/bar/')).toBe('foo/bar');
    expect(normalizeFolderPath('\\foo\\')).toBe('foo');
    expect(normalizeFolderPath('')).toBe('');
  });

  it('pathFallsUnder cubre igualdad y prefijo', () => {
    expect(pathFallsUnder('proyectos/x.md', 'proyectos')).toBe(true);
    expect(pathFallsUnder('proyectos', 'proyectos')).toBe(true);
    expect(pathFallsUnder('proyectos2/x.md', 'proyectos')).toBe(false);
    expect(pathFallsUnder('otra/x.md', 'proyectos')).toBe(false);
  });
});

describe('SharingService — self-host', () => {
  it('canRead/canWrite siempre true; listSharedRoots vacío', () => {
    const selfHost = new SharingService({ db: bs, deployment: 'self-host' });
    expect(selfHost.canRead('alice', 'owner', 'anything')).toBe(true);
    expect(selfHost.canWrite('alice', 'owner', 'anything')).toBe(true);
    expect(selfHost.listSharedRoots('alice')).toEqual([]);
    expect(selfHost.listMyShares('owner')).toEqual([]);
  });

  it('grant tira FORBIDDEN en self-host', () => {
    const selfHost = new SharingService({ db: bs, deployment: 'self-host' });
    expect(() =>
      selfHost.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: 'x',
        grantedBy: 'owner',
      }),
    ).toThrow(AppError);
  });
});

describe('SharingService — hosted: canRead/canWrite', () => {
  it('dueño siempre puede leer/escribir', () => {
    expect(svc.canRead('owner', 'owner', 'cualquiera/x.md')).toBe(true);
    expect(svc.canWrite('owner', 'owner', 'cualquiera/x.md')).toBe(true);
  });

  it('user sin grant no puede leer ni escribir', () => {
    expect(svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
  });

  it('grant habilita read pero no write (V1 read-only)', () => {
    svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    expect(svc.canRead('alice', 'owner', 'proyectos/x.md')).toBe(true);
    expect(svc.canRead('alice', 'owner', 'proyectos/sub/y.md')).toBe(true);
    expect(svc.canWrite('alice', 'owner', 'proyectos/x.md')).toBe(false);
    expect(svc.canRead('alice', 'owner', 'otra/x.md')).toBe(false);
  });

  it('assertCanRead throw FORBIDDEN sin grant', () => {
    expect(() => svc.assertCanRead('alice', 'owner', 'p/x.md')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('SharingService — grant / revoke', () => {
  it('grant es idempotente: dos llamadas misma fila', () => {
    const id1 = svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const id2 = svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: '/p/',
      grantedBy: 'owner',
    });
    expect(id1).toBe(id2);
  });

  it('grant rechaza root y self-share', () => {
    expect(() =>
      svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'alice',
        folderPath: '/',
        grantedBy: 'owner',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() =>
      svc.grant({
        ownerId: 'owner',
        sharedWithUserId: 'owner',
        folderPath: 'x',
        grantedBy: 'owner',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('revoke quita el grant', () => {
    svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    expect(svc.canRead('alice', 'owner', 'p/x.md')).toBe(true);
    svc.revoke({ ownerId: 'owner', sharedWithUserId: 'alice', folderPath: 'p' });
    expect(svc.canRead('alice', 'owner', 'p/x.md')).toBe(false);
  });
});

describe('SharingService — listing', () => {
  it('listSharedRoots devuelve metadata del dueño', () => {
    svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const out = svc.listSharedRoots('alice');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      folderPath: 'p',
      ownerId: 'owner',
      ownerEmail: 'o@x.com',
    });
  });

  it('listMyShares agrupa por folder', () => {
    svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'alice',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    svc.grant({
      ownerId: 'owner',
      sharedWithUserId: 'bob',
      folderPath: 'p',
      grantedBy: 'owner',
    });
    const out = svc.listMyShares('owner');
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.email).sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});
