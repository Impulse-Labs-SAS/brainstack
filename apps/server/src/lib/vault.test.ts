import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ownerIdFromPhysicalPath,
  resolveVaultRoot,
  toLogical,
  toPhysical,
} from './vault.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'bs-vault-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('resolveVaultRoot', () => {
  it('self-host devuelve notesDirAbs sin tocar el FS', () => {
    const out = resolveVaultRoot('user-ignored', {
      deployment: 'self-host',
      notesDirAbs: root,
    });
    expect(out).toBe(root);
  });

  it('hosted devuelve subdir y lo crea idempotente', async () => {
    const out = resolveVaultRoot('u1', { deployment: 'hosted', notesDirAbs: root });
    expect(out).toBe(join(root, 'u1'));
    const stat = await fsp.stat(out);
    expect(stat.isDirectory()).toBe(true);

    // Segunda llamada no rompe.
    const out2 = resolveVaultRoot('u1', { deployment: 'hosted', notesDirAbs: root });
    expect(out2).toBe(out);
  });

  it('hosted sin userId tira error', () => {
    expect(() =>
      resolveVaultRoot('', { deployment: 'hosted', notesDirAbs: root }),
    ).toThrow();
  });
});

describe('ownerIdFromPhysicalPath', () => {
  it('self-host → null', () => {
    expect(
      ownerIdFromPhysicalPath(join(root, 'notes', 'a.md'), {
        deployment: 'self-host',
        notesDirAbs: root,
      }),
    ).toBeNull();
  });

  it('hosted → primer segmento', () => {
    expect(
      ownerIdFromPhysicalPath(join(root, 'user-abc', 'notes', 'a.md'), {
        deployment: 'hosted',
        notesDirAbs: root,
      }),
    ).toBe('user-abc');
  });

  it('hosted con path fuera del root → null', () => {
    expect(
      ownerIdFromPhysicalPath(root, { deployment: 'hosted', notesDirAbs: root }),
    ).toBeNull();
  });
});

describe('toPhysical / toLogical', () => {
  const selfCfg = { deployment: 'self-host' as const, notesDirAbs: '/x' };
  const hostedCfg = { deployment: 'hosted' as const, notesDirAbs: '/x' };

  it('self-host: identity en ambos sentidos', () => {
    expect(toPhysical('alice', 'proyectos/foo.md', selfCfg)).toBe('proyectos/foo.md');
    expect(toLogical('alice', 'proyectos/foo.md', selfCfg)).toBe('proyectos/foo.md');
  });

  it('hosted: prefixea y strippea <userId>/', () => {
    expect(toPhysical('alice', 'proyectos/foo.md', hostedCfg)).toBe('alice/proyectos/foo.md');
    expect(toLogical('alice', 'alice/proyectos/foo.md', hostedCfg)).toBe('proyectos/foo.md');
  });

  it('hosted toPhysical es idempotente si ya viene prefixed', () => {
    expect(toPhysical('alice', 'alice/proyectos/foo.md', hostedCfg)).toBe(
      'alice/proyectos/foo.md',
    );
  });

  it('hosted toLogical sobre path que no pertenece tira error', () => {
    expect(() => toLogical('alice', 'bob/x.md', hostedCfg)).toThrow();
  });

  it('hosted toLogical sobre root del user → ""', () => {
    expect(toLogical('alice', 'alice', hostedCfg)).toBe('');
  });
});
