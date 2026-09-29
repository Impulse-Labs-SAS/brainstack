// Moving a folder, which used to be impossible.
//
// `PgNoteStore.move` moves one note: it reads, writes at the new key and
// deletes the old. `NoteService.move` called it once, so a folder arrived as a
// path not ending in `.md` and died on that — while the MCP tool advertised
// "folders are moved with all their contents" and the web tree let you drag
// one. Both promised something that always threw.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteService } from './NoteService.js';
import { SharingService } from './SharingService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

let database: TestDatabase;
let notes: NoteService;

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await database.db
    .insert(users)
    .values({ id: 'u1', email: 'u1@x.com', createdAt: Date.now(), updatedAt: 0 });
  notes = new NoteService({ db: database.db });
});

const paths = async (): Promise<string[]> => (await notes.list('u1', {})).map((n) => n.path).sort();

describe('NoteService.move — carpetas', () => {
  it('mueve la carpeta con todo lo que cuelga, a cualquier profundidad', async () => {
    await notes.create('u1', 'Brutus/nota.md', 'a');
    await notes.create('u1', 'Brutus/sub/hondo.md', 'b');
    await notes.createFolder('u1', 'Destino');

    const result = await notes.move('u1', 'Brutus', 'Destino/Brutus');

    expect(result.path).toBe('Destino/Brutus');
    expect(await paths()).toEqual(['Destino/Brutus/nota.md', 'Destino/Brutus/sub/hondo.md']);
  });

  it('renombra una carpeta en su lugar', async () => {
    await notes.create('u1', 'Viejo/x.md', 'a');
    await notes.move('u1', 'Viejo', 'Nuevo');
    expect(await paths()).toEqual(['Nuevo/x.md']);
  });

  it('mueve una carpeta vacía, que no tiene notas que la impliquen', async () => {
    await notes.createFolder('u1', 'Vacia');
    await notes.createFolder('u1', 'Destino');
    await notes.move('u1', 'Vacia', 'Destino/Vacia');

    const tree = await notes.listTree('u1', 'Destino');
    expect(JSON.stringify(tree)).toContain('Vacia');
  });

  it('reescribe los wikilinks que apuntaban adentro', async () => {
    await notes.create('u1', 'Brutus/nota.md', 'contenido');
    await notes.create('u1', 'afuera.md', 'ver [[Brutus/nota]]');

    await notes.move('u1', 'Brutus', 'Proyectos/Brutus');

    const after = await notes.get('u1', 'afuera.md');
    expect(after.body).toContain('[[Proyectos/Brutus/nota]]');
    expect(after.body).not.toContain('[[Brutus/nota]]');
  });

  it('no deja nada movido si algo del destino ya existe', async () => {
    await notes.create('u1', 'Brutus/a.md', '1');
    await notes.create('u1', 'Brutus/b.md', '2');
    await notes.create('u1', 'Destino/Brutus/b.md', 'ocupado');

    await expect(notes.move('u1', 'Brutus', 'Destino/Brutus')).rejects.toThrow(
      expect.objectContaining({ code: 'ALREADY_EXISTS' }),
    );

    // Ni siquiera `a.md`, que no chocaba con nada: la colisión se detecta antes
    // de mover, porque el store no tiene transacción que revertir.
    expect(await paths()).toEqual(['Brutus/a.md', 'Brutus/b.md', 'Destino/Brutus/b.md']);
  });

  it('rechaza mover una carpeta dentro de sí misma', async () => {
    await notes.create('u1', 'Brutus/a.md', '1');
    await expect(notes.move('u1', 'Brutus', 'Brutus/adentro')).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('una carpeta que no existe es NOT_FOUND, no un éxito vacío', async () => {
    await expect(notes.move('u1', 'NoExiste', 'Otro')).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('reescribe el link de path completo al mover una nota entre carpetas', async () => {
    // Roto antes de esto: el rewriter recibía el path físico
    // (`u1/A/nota.md`), que nunca coincide con lo que dice un wikilink. Solo
    // acertaba de rebote cuando cambiaba el basename.
    await notes.create('u1', 'A/nota.md', 'contenido');
    await notes.create('u1', 'ref.md', 'ver [[A/nota]]');

    await notes.move('u1', 'A/nota.md', 'B/nota.md');

    const after = await notes.get('u1', 'ref.md');
    expect(after.body).toContain('[[B/nota]]');
  });

  it('sigue moviendo notas sueltas como antes', async () => {
    await notes.create('u1', 'a.md', 'x');
    const result = await notes.move('u1', 'a.md', 'b.md');
    expect(result.path).toBe('b.md');
    expect(await paths()).toEqual(['b.md']);
  });
});

// Renombrar una carpeta compartida le cortaba el acceso al invitado sin avisar
// y le dejaba el nombre viejo en el árbol: el grant nombra un path, y nadie lo
// movía junto con la carpeta. Es la misma carpeta, del mismo dueño, así que lo
// compartido tiene que seguirla.
describe('NoteService.move — los shares siguen a la carpeta', () => {
  let sharing: SharingService;

  beforeEach(async () => {
    sharing = new SharingService({ db: database.db });
    notes = new NoteService({
      db: database.db,
      onFolderMoved: async (ownerId, from, to) => {
        await sharing.reparentUnder({ ownerId, from, to });
      },
    });
    await database.db
      .insert(users)
      .values({ id: 'invitado', email: 'inv@x.com', createdAt: Date.now(), updatedAt: 0 });
  });

  const grant = async (
    folderPath: string,
    permission: 'read' | 'write' = 'write',
  ): Promise<void> => {
    await sharing.grant({
      ownerId: 'u1',
      sharedWithUserId: 'invitado',
      folderPath,
      grantedBy: 'u1',
      permission,
    });
  };

  it('el invitado conserva el acceso y ve el nombre nuevo', async () => {
    await notes.create('u1', 'Brutus/nota.md', 'a');
    await grant('Brutus');

    await notes.move('u1', 'Brutus', 'Archivo/Brutus');

    expect((await sharing.listSharedRoots('invitado')).map((r) => r.folderPath)).toEqual([
      'Archivo/Brutus',
    ]);
    expect(await sharing.canWrite('invitado', 'u1', 'Archivo/Brutus/nota.md')).toBe(true);
    expect(await sharing.canRead('invitado', 'u1', 'Brutus/nota.md')).toBe(false);
  });

  it('un grant sobre una subcarpeta conserva su profundidad', async () => {
    await notes.create('u1', 'Brutus/App/x.md', 'a');
    await grant('Brutus/App');

    await notes.move('u1', 'Brutus', 'Archivo/Brutus');

    expect((await sharing.listSharedRoots('invitado')).map((r) => r.folderPath)).toEqual([
      'Archivo/Brutus/App',
    ]);
  });

  it('no arrastra la carpeta que apenas comparte el prefijo del nombre', async () => {
    await notes.create('u1', 'Brutus/x.md', 'a');
    await notes.create('u1', 'Brutus2/y.md', 'b');
    await grant('Brutus');
    await grant('Brutus2');

    await notes.move('u1', 'Brutus', 'Archivo/Brutus');

    expect((await sharing.listSharedRoots('invitado')).map((r) => r.folderPath).sort()).toEqual([
      'Archivo/Brutus',
      'Brutus2',
    ]);
  });

  it('si el destino ya estaba compartido con la misma persona, queda un grant con el permiso más amplio', async () => {
    await notes.create('u1', 'Brutus/x.md', 'a');
    await notes.create('u1', 'Archivo/Brutus/y.md', 'b');
    await grant('Brutus', 'write');
    await grant('Archivo/Brutus', 'read');

    await notes.move('u1', 'Brutus', 'Archivo/Brutus');

    const roots = await sharing.listSharedRoots('invitado');
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ folderPath: 'Archivo/Brutus', permission: 'write' });
  });

  it('mover una nota sola no toca ningún grant', async () => {
    await notes.create('u1', 'Brutus/x.md', 'a');
    await grant('Brutus');

    await notes.move('u1', 'Brutus/x.md', 'Brutus/y.md');

    expect((await sharing.listSharedRoots('invitado')).map((r) => r.folderPath)).toEqual([
      'Brutus',
    ]);
  });

  it('la invitación pendiente apunta a donde la carpeta terminó', async () => {
    const { folderShareInvites } = pgSchema;
    await notes.create('u1', 'Brutus/x.md', 'a');
    await database.db.insert(folderShareInvites).values({
      id: 'inv1',
      folderPath: 'Brutus',
      ownerId: 'u1',
      mode: 'link',
      permission: 'write',
      tokenHash: 'hash-1',
      expiresAt: Date.now() + 100_000,
      createdAt: Date.now(),
    });

    await notes.move('u1', 'Brutus', 'Archivo/Brutus');

    const [invite] = await database.db.select().from(folderShareInvites);
    expect(invite?.folderPath).toBe('Archivo/Brutus');
  });
});
