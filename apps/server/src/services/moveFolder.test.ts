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
  notes = new NoteService({ db: database.db, cfg: { deployment: 'hosted' } });
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
    // Roto antes de esto en hosted: el rewriter recibía el path físico
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
