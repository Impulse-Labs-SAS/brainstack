// Migrar una carpeta de una bóveda a otra.
//
// El caso real: Pablo cargó todo Brutus en su bóveda personal porque no podía
// escribir en la compartida. Ahora que puede, eso tiene que poder cruzarse —
// y cruzar cuesta links, porque un wikilink no sabe decir de quién es el
// `[[Brutus/nota]]` al que apunta.

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
  for (const id of ['pablo', 'fede']) {
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
    await notes.create('pablo', 'Brutus/arquitectura.md', 'a');
    await notes.create('pablo', 'Brutus/sub/detalle.md', 'b');
    await notes.createFolder('fede', 'Impulse Labs');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'Impulse Labs/Brutus',
    });

    expect(result.path).toBe('Impulse Labs/Brutus');
    expect(result.movedNotes).toBe(2);
    expect(await pathsOf('pablo')).toEqual([]);
    expect(await pathsOf('fede')).toEqual([
      'Impulse Labs/Brutus/arquitectura.md',
      'Impulse Labs/Brutus/sub/detalle.md',
    ]);
  });

  it('las notas quedan a nombre del dueño del destino', async () => {
    await notes.create('pablo', 'Brutus/x.md', 'a');
    await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'Impulse Labs/Brutus',
    });

    // Si quedaran a nombre de Pablo, desaparecerían de la carpeta compartida
    // para todos los demás.
    const row = await notes.get('fede', 'Impulse Labs/Brutus/x.md');
    expect(row.path).toBe('Impulse Labs/Brutus/x.md');
  });

  it('los links internos al bloque que se mueve sobreviven', async () => {
    await notes.create('pablo', 'Brutus/uno.md', 'ver [[Brutus/dos]]');
    await notes.create('pablo', 'Brutus/dos.md', 'destino');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'Brutus',
    });

    expect(result.linksLeftDangling).toEqual([]);
  });

  it('reporta los links que quedan colgando por cruzar, en ambas direcciones', async () => {
    await notes.create('pablo', 'Brutus/nota.md', 'ver [[personal/idea]]');
    await notes.create('pablo', 'personal/idea.md', 'algo mío');
    await notes.create('pablo', 'indice.md', 'ver [[Brutus/nota]]');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'Brutus',
    });

    // La nota que se fue ya no alcanza lo que quedó.
    expect(result.linksLeftDangling).toMatchObject([
      { note: 'Brutus/nota.md', target: expect.stringContaining('personal/idea') },
    ]);
    // Y lo que quedó ya no alcanza a la que se fue.
    expect(result.linksNowBroken).toMatchObject([{ note: 'indice.md', target: 'Brutus/nota.md' }]);
  });

  it('no culpa al cruce por links que ya estaban rotos', async () => {
    await notes.create('pablo', 'Brutus/nota.md', 'ver [[no-existe-nunca]]');

    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'Brutus',
    });

    expect(result.linksLeftDangling).toEqual([]);
  });

  it('no mueve nada si el destino ya tiene algo con ese path', async () => {
    await notes.create('pablo', 'Brutus/a.md', '1');
    await notes.create('pablo', 'Brutus/b.md', '2');
    await notes.create('fede', 'Brutus/b.md', 'ocupado');

    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'pablo',
        fromPath: 'Brutus',
        toOwnerId: 'fede',
        toPath: 'Brutus',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ALREADY_EXISTS' }));

    expect(await pathsOf('pablo')).toEqual(['Brutus/a.md', 'Brutus/b.md']);
  });

  it('mueve también una nota suelta', async () => {
    await notes.create('pablo', 'suelta.md', 'x');
    const result = await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'suelta.md',
      toOwnerId: 'fede',
      toPath: 'Impulse Labs/suelta.md',
    });
    expect(result.movedNotes).toBe(1);
    expect(await pathsOf('fede')).toEqual(['Impulse Labs/suelta.md']);
  });

  it('mismo dueño no es un cruce', async () => {
    await notes.create('pablo', 'Brutus/a.md', '1');
    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'pablo',
        fromPath: 'Brutus',
        toOwnerId: 'pablo',
        toPath: 'Otro',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('lo que no existe es NOT_FOUND', async () => {
    await expect(
      notes.moveAcrossVaults({
        fromOwnerId: 'pablo',
        fromPath: 'NoExiste',
        toOwnerId: 'fede',
        toPath: 'x',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

// El caso de Fede: Pablo le compartió Brutus con escritura, Fede lo movió a
// `impulse-labs` — que es suya y que Pablo ya ve — y en el árbol de Fede quedó
// un `Brutus` de Pablo, vacío, que nada podía volver a llenar. La carpeta se
// había ido de la bóveda de Pablo; el grant que la nombraba, no.
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
    await notes.create('pablo', 'Brutus/arquitectura.md', 'a');
    await sharing.grant({
      ownerId: 'pablo',
      sharedWithUserId: 'fede',
      folderPath: 'Brutus',
      grantedBy: 'pablo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'impulse-labs/Brutus',
    });

    expect(await sharing.listSharedRoots('fede')).toEqual([]);
    expect(await sharing.listMyShares('pablo')).toEqual([]);
  });

  it('también caen los grants sobre subcarpetas de lo que se movió', async () => {
    await notes.create('pablo', 'Brutus/App/x.md', 'a');
    await sharing.grant({
      ownerId: 'pablo',
      sharedWithUserId: 'fede',
      folderPath: 'Brutus/App',
      grantedBy: 'pablo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus',
      toOwnerId: 'fede',
      toPath: 'impulse-labs/Brutus',
    });

    expect(await sharing.listSharedRoots('fede')).toEqual([]);
  });

  it('mover una nota sola no revoca nada', async () => {
    await notes.create('pablo', 'Brutus/x.md', 'a');
    await notes.create('pablo', 'Brutus/y.md', 'b');
    await sharing.grant({
      ownerId: 'pablo',
      sharedWithUserId: 'fede',
      folderPath: 'Brutus',
      grantedBy: 'pablo',
      permission: 'write',
    });

    await notes.moveAcrossVaults({
      fromOwnerId: 'pablo',
      fromPath: 'Brutus/x.md',
      toOwnerId: 'fede',
      toPath: 'impulse-labs/x.md',
    });

    // La carpeta sigue en la bóveda de Pablo, con `y.md` adentro.
    expect(await sharing.listSharedRoots('fede')).toHaveLength(1);
  });

  it('borrar la carpeta compartida también se lleva el grant', async () => {
    await notes.create('pablo', 'Brutus/x.md', 'a');
    await sharing.grant({
      ownerId: 'pablo',
      sharedWithUserId: 'fede',
      folderPath: 'Brutus',
      grantedBy: 'pablo',
      permission: 'write',
    });

    await notes.remove('pablo', 'Brutus', { recursive: true });

    expect(await sharing.listSharedRoots('fede')).toEqual([]);
  });
});
