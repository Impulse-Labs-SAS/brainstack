// Migrar una carpeta de una bóveda a otra.
//
// El caso real: Frodo cargó todo Gondor en su bóveda personal porque no podía
// escribir en la compartida. Ahora que puede, eso tiene que poder cruzarse —
// y cruzar cuesta links, porque un wikilink no sabe decir de quién es el
// `[[Gondor/nota]]` al que apunta.

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
  for (const id of ['frodo', 'sam']) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@x.com`, createdAt: Date.now(), updatedAt: 0 });
  }
  notes = new NoteService({ db: database.db });
});

const pathsOf = async (owner: string): Promise<string[]> =>
  (await notes.list(owner, {})).map((n) => n.path).sort();

describe('NoteService.moveAcrossVaults', () => {
  it('lleva la carpeta entera a la bóveda del otro', async () => {
    await notes.create('frodo', 'Gondor/arquitectura.md', 'a');
    await notes.create('frodo', 'Gondor/sub/detalle.md', 'b');
    await notes.createFolder('sam', 'Impulse Labs');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'Impulse Labs/Gondor',
    });

    expect(result.path).toBe('Impulse Labs/Gondor');
    expect(result.movedNotes).toBe(2);
    expect(await pathsOf('frodo')).toEqual([]);
    expect(await pathsOf('sam')).toEqual([
      'Impulse Labs/Gondor/arquitectura.md',
      'Impulse Labs/Gondor/sub/detalle.md',
    ]);
  });

  it('las notas quedan a nombre del dueño del destino', async () => {
    await notes.create('frodo', 'Gondor/x.md', 'a');
    await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'Impulse Labs/Gondor',
    });

    // Si quedaran a nombre de Frodo, desaparecerían de la carpeta compartida
    // para todos los demás.
    const row = await notes.get('sam', 'Impulse Labs/Gondor/x.md');
    expect(row.path).toBe('Impulse Labs/Gondor/x.md');
  });

  it('los links internos al bloque que se mueve sobreviven', async () => {
    await notes.create('frodo', 'Gondor/uno.md', 'ver [[Gondor/dos]]');
    await notes.create('frodo', 'Gondor/dos.md', 'destino');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'Gondor',
    });

    expect(result.linksLeftDangling).toEqual([]);
  });

  it('reporta los links que quedan colgando por cruzar, en ambas direcciones', async () => {
    await notes.create('frodo', 'Gondor/nota.md', 'ver [[personal/idea]]');
    await notes.create('frodo', 'personal/idea.md', 'algo mío');
    await notes.create('frodo', 'indice.md', 'ver [[Gondor/nota]]');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'Gondor',
    });

    // La nota que se fue ya no alcanza lo que quedó.
    expect(result.linksLeftDangling).toMatchObject([
      { note: 'Gondor/nota.md', target: expect.stringContaining('personal/idea') },
    ]);
    // Y lo que quedó ya no alcanza a la que se fue.
    expect(result.linksNowBroken).toMatchObject([{ note: 'indice.md', target: 'Gondor/nota.md' }]);
  });

  it('no culpa al cruce por links que ya estaban rotos', async () => {
    await notes.create('frodo', 'Gondor/nota.md', 'ver [[no-existe-nunca]]');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'Gondor',
    });

    expect(result.linksLeftDangling).toEqual([]);
  });

  it('no mueve nada si el destino ya tiene algo con ese path', async () => {
    await notes.create('frodo', 'Gondor/a.md', '1');
    await notes.create('frodo', 'Gondor/b.md', '2');
    await notes.create('sam', 'Gondor/b.md', 'ocupado');

    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'frodo',
        fromPath: 'Gondor',
        toOwnerId: 'sam',
        toPath: 'Gondor',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ALREADY_EXISTS' }));

    expect(await pathsOf('frodo')).toEqual(['Gondor/a.md', 'Gondor/b.md']);
  });

  it('mueve también una nota suelta', async () => {
    await notes.create('frodo', 'suelta.md', 'x');
    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'suelta.md',
      toOwnerId: 'sam',
      toPath: 'Impulse Labs/suelta.md',
    });
    expect(result.movedNotes).toBe(1);
    expect(await pathsOf('sam')).toEqual(['Impulse Labs/suelta.md']);
  });

  it('mismo dueño no es un cruce', async () => {
    await notes.create('frodo', 'Gondor/a.md', '1');
    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'frodo',
        fromPath: 'Gondor',
        toOwnerId: 'frodo',
        toPath: 'Otro',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('lo que no existe es NOT_FOUND', async () => {
    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'frodo',
        fromPath: 'NoExiste',
        toOwnerId: 'sam',
        toPath: 'x',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

// El caso de Sam: Frodo le compartió Gondor con escritura, Sam lo movió a
// `impulse-labs` — que es suya y que Frodo ya ve — y en el árbol de Sam quedó
// un `Gondor` de Frodo, vacío, que nada podía volver a llenar. La carpeta se
// había ido de la bóveda de Frodo; el grant que la nombraba, no.
describe('moveAcrossVaults y los shares que quedaban atrás', () => {
  let sharing: SharingService;

  beforeEach(() => {
    sharing = new SharingService({ db: database.db });
    notes = new NoteService({
      db: database.db,
      onFolderGone: async (ownerId, folderPath) => {
        await sharing.revokeUnder({ ownerId, folderPath });
      },
    });
  });

  it('la carpeta compartida deja de aparecer en el árbol de quien la movió', async () => {
    await notes.create('frodo', 'Gondor/arquitectura.md', 'a');
    await sharing.grant({
      ownerId: 'frodo',
      sharedWithUserId: 'sam',
      folderPath: 'Gondor',
      grantedBy: 'frodo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'impulse-labs/Gondor',
    });

    expect(await sharing.listSharedRoots('sam')).toEqual([]);
    expect(await sharing.listMyShares('frodo')).toEqual([]);
  });

  it('también caen los grants sobre subcarpetas de lo que se movió', async () => {
    await notes.create('frodo', 'Gondor/App/x.md', 'a');
    await sharing.grant({
      ownerId: 'frodo',
      sharedWithUserId: 'sam',
      folderPath: 'Gondor/App',
      grantedBy: 'frodo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor',
      toOwnerId: 'sam',
      toPath: 'impulse-labs/Gondor',
    });

    expect(await sharing.listSharedRoots('sam')).toEqual([]);
  });

  it('mover una nota sola no revoca nada', async () => {
    await notes.create('frodo', 'Gondor/x.md', 'a');
    await notes.create('frodo', 'Gondor/y.md', 'b');
    await sharing.grant({
      ownerId: 'frodo',
      sharedWithUserId: 'sam',
      folderPath: 'Gondor',
      grantedBy: 'frodo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'frodo',
      fromPath: 'Gondor/x.md',
      toOwnerId: 'sam',
      toPath: 'impulse-labs/x.md',
    });

    // La carpeta sigue en la bóveda de Frodo, con `y.md` adentro.
    expect(await sharing.listSharedRoots('sam')).toHaveLength(1);
  });

  it('borrar la carpeta compartida también se lleva el grant', async () => {
    await notes.create('frodo', 'Gondor/x.md', 'a');
    await sharing.grant({
      ownerId: 'frodo',
      sharedWithUserId: 'sam',
      folderPath: 'Gondor',
      grantedBy: 'frodo',
      permission: 'write',
    });

    await notes.remove('frodo', 'Gondor', { recursive: true });

    expect(await sharing.listSharedRoots('sam')).toEqual([]);
  });
});
