import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';
import { CrossOwnerReader } from './CrossOwnerReader.js';
import { SharingService } from './SharingService.js';

let bs: BrainStackDatabase;
let notesDir: string;

function seedUser(id: string, email: string): void {
  bs.sqlite
    .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, email, Date.now(), Date.now());
}

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = join(notesDir, rel);
  await fsp.mkdir(join(abs, '..'), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  bs = openDatabase(':memory:');
  notesDir = await fsp.mkdtemp(join(tmpdir(), 'bs-cross-'));
  seedUser('owner', 'o@x.com');
  seedUser('viewer', 'v@x.com');
});

afterEach(async () => {
  bs.close();
  await fsp.rm(notesDir, { recursive: true, force: true });
});

describe('CrossOwnerReader — self-host', () => {
  it('todos los métodos tiran NOT_FOUND porque no aplica', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'self-host' });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'self-host', notesDirAbs: notesDir },
    });
    expect(reader.enabled).toBe(false);
    await expect(reader.getNote('viewer', 'owner', 'x.md')).rejects.toBeInstanceOf(AppError);
    await expect(reader.listTree('viewer', 'owner', 'p', 4)).rejects.toBeInstanceOf(AppError);
  });
});

describe('CrossOwnerReader — hosted', () => {
  it('getNote: FORBIDDEN si no hay grant', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'hosted' });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'hosted', notesDirAbs: notesDir },
    });
    await writeFile('owner/proyectos/foo.md', '# foo\n');
    await expect(reader.getNote('viewer', 'owner', 'proyectos/foo.md')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('getNote: devuelve la nota cuando hay grant que cubre el path', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'hosted' });
    sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'viewer',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'hosted', notesDirAbs: notesDir },
    });
    await writeFile('owner/proyectos/foo.md', '---\ntitle: Foo\n---\nhola');
    const note = await reader.getNote('viewer', 'owner', 'proyectos/foo.md');
    expect(note.path).toBe('proyectos/foo.md');
    expect(note.title).toBe('Foo');
    expect(note.body.trim()).toBe('hola');
  });

  it('getNote: NOT_FOUND cuando hay grant pero el file no existe', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'hosted' });
    sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'viewer',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'hosted', notesDirAbs: notesDir },
    });
    await fsp.mkdir(join(notesDir, 'owner'), { recursive: true });
    await expect(reader.getNote('viewer', 'owner', 'proyectos/nope.md')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('listTree: requiere scopePath con grant; root forbidden', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'hosted' });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'hosted', notesDirAbs: notesDir },
    });
    await expect(reader.listTree('viewer', 'owner', '', 4)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(reader.listTree('viewer', 'owner', 'proyectos', 4)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('listTree: devuelve árbol con notas dentro del scope', async () => {
    const sharing = new SharingService({ db: bs, deployment: 'hosted' });
    sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'viewer',
      folderPath: 'proyectos',
      grantedBy: 'owner',
    });
    const reader = new CrossOwnerReader({
      sharing,
      vaultCfg: { deployment: 'hosted', notesDirAbs: notesDir },
    });
    await writeFile('owner/proyectos/a.md', 'a');
    await writeFile('owner/proyectos/sub/b.md', 'b');
    await writeFile('owner/privado/secreto.md', 'no');

    const tree = await reader.listTree('viewer', 'owner', 'proyectos', 4);
    expect(tree.path).toBe('proyectos');
    expect(tree.type).toBe('folder');
    const childPaths = (tree.children ?? []).map((c) => c.path).sort();
    expect(childPaths).toEqual(['proyectos/a.md', 'proyectos/sub']);
  });
});
