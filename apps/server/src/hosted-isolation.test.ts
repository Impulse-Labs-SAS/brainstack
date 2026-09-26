// Two users in one database, and what each of them can see.
//
// This is the suite that matters most for sharing: isolation here is the only
// thing between "Pablo's folder" and "everything Pablo wrote". It asserts the
// negative cases — that a listing, a tree, a search and a graph all stop at the
// owner's boundary — because those are the ones that fail quietly.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listBacklinksSafely } from './lib/backlinks.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const { users } = pgSchema;

const hosted = { deployment: 'hosted' as const };

let database: TestDatabase;
let notes: NoteService;
let search: SearchService;
let sharing: SharingService;
let crossOwner: CrossOwnerReader;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();

  for (const [id, email] of [
    ['alice', 'alice@brain.test'],
    ['bob', 'bob@brain.test'],
  ] as const) {
    await database.db.insert(users).values({ id, email, createdAt: Date.now(), updatedAt: 0 });
  }

  notes = new NoteService({ db: database.db, cfg: hosted });
  search = new SearchService({ db: database.db, cfg: hosted });
  sharing = new SharingService({ db: database.db, deployment: 'hosted' });
  crossOwner = new CrossOwnerReader({ db: database.db, sharing, vaultCfg: hosted });
});

describe('hosted multi-user isolation', () => {
  beforeEach(async () => {
    await notes.create('alice', 'Proyectos/zuno.md', '# Zuno\n\npresupuesto de alice');
    await notes.create('alice', 'Privado/diario.md', '# Diario\n\nsecreto de alice');
    await notes.create('bob', 'Proyectos/otro.md', '# Otro\n\npresupuesto de bob');
  });

  it('list only returns the caller’s own notes', async () => {
    const mine = await notes.list('alice');
    const paths = mine.map((n) => n.path).sort();

    expect(paths).toEqual(['Privado/diario.md', 'Proyectos/zuno.md']);
    // Same logical path as alice's, different owner: it must not appear.
    expect(paths).not.toContain('Proyectos/otro.md');
  });

  it('the same logical path can belong to both users at once', async () => {
    await notes.create('bob', 'Privado/diario.md', '# Diario\n\nsecreto de bob');

    expect((await notes.get('alice', 'Privado/diario.md')).body).toContain('alice');
    expect((await notes.get('bob', 'Privado/diario.md')).body).toContain('bob');
  });

  it('the tree stops at the owner boundary', async () => {
    const tree = await notes.listTree('alice');
    const serialised = JSON.stringify(tree);

    expect((tree.children ?? []).map((c) => c.name).sort()).toEqual(['Privado', 'Proyectos']);
    expect(serialised).not.toContain('otro.md');
    // No owner prefix leaks into what the caller sees.
    expect(serialised).not.toContain('alice/');
  });

  it('search does not cross owners by default', async () => {
    const hits = await search.search('alice', 'presupuesto');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('Proyectos/zuno.md');
    expect(hits[0]?.ownerId).toBe('alice');
  });

  it('the graph only contains the caller’s notes', async () => {
    const { nodes } = await notes.graph('alice');
    expect(nodes.every((n) => n.ownerId === 'alice')).toBe(true);
    expect(nodes).toHaveLength(2);
  });

  it('every note is written with its owner recorded', async () => {
    const mine = await notes.list('alice');
    expect(mine).toHaveLength(2);

    const { nodes } = await notes.graph('alice');
    expect(nodes.map((n) => n.ownerId)).toEqual(['alice', 'alice']);
  });
});

describe('hosted multi-user with a shared folder', () => {
  beforeEach(async () => {
    await notes.create('alice', 'Proyectos/zuno.md', '# Zuno\n\npresupuesto compartido');
    await notes.create('alice', 'Privado/diario.md', '# Diario\n\npresupuesto privado');
    await sharing.grant({
      ownerId: 'alice',
      sharedWithUserId: 'bob',
      folderPath: 'Proyectos',
      grantedBy: 'alice',
    });
  });

  it('search with the shared scope reaches the folder and stops there', async () => {
    const scopes = (await sharing.listSharedRoots('bob')).map((r) => ({
      ownerId: r.ownerId,
      folderPath: r.folderPath,
    }));

    const hits = await search.search('bob', 'presupuesto', {
      includeMine: true,
      sharedScopes: scopes,
    });

    expect(hits.map((h) => h.path)).toEqual(['Proyectos/zuno.md']);
    expect(hits[0]?.ownerId).toBe('alice');
    // The private note matches the query and must still not surface.
    expect(JSON.stringify(hits)).not.toContain('diario');
  });

  it('search without the shared scope finds nothing of alice’s', async () => {
    const hits = await search.search('bob', 'presupuesto');
    expect(hits).toEqual([]);
  });

  it('bob can read a shared note and not a private one', async () => {
    const note = await crossOwner.getNote('bob', 'alice', 'Proyectos/zuno.md');
    expect(note.body).toContain('compartido');

    await expect(
      crossOwner.getNote('bob', 'alice', 'Privado/diario.md'),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('a backlink from an unshared sibling folder does not leak to bob', async () => {
    // Privado/ is not shared, and this note (distinct from the beforeEach's
    // diario.md) links into the folder that is.
    await notes.create('alice', 'Privado/secreto.md', '# Secreto\n\nVer [[Proyectos/zuno]].');

    const asOwner = await listBacklinksSafely('alice', 'alice', 'Proyectos/zuno.md', {
      notes,
      crossOwner,
    });
    expect(asOwner.map((b) => b.sourcePath)).toContain('Privado/secreto.md');

    const asBob = await listBacklinksSafely('bob', 'alice', 'Proyectos/zuno.md', {
      notes,
      crossOwner,
    });
    expect(asBob.map((b) => b.sourcePath)).not.toContain('Privado/secreto.md');
    expect(JSON.stringify(asBob)).not.toContain('secreto');
  });

  it('revoking the grant closes the door again', async () => {
    await sharing.revoke({
      ownerId: 'alice',
      sharedWithUserId: 'bob',
      folderPath: 'Proyectos',
    });

    await expect(
      crossOwner.getNote('bob', 'alice', 'Proyectos/zuno.md'),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});

/**
 * The stored path carries the owner's id as its first segment. That is an
 * implementation detail of how one database holds several vaults, and it kept
 * escaping: into the graph, into a backlink target, into the text of a
 * "not found". Users saw an id they never typed, in a URL they could not share.
 */
describe('el id interno no se escapa a las respuestas', () => {
  beforeEach(async () => {
    await notes.createFolder('alice', 'proyectos');
    // El destino primero: enlazar a una nota que todavia no existe es su propio
    // caso, y vive en el test de enlaces pendientes.
    await notes.create('alice', 'proyectos/dos.md', '# Dos');
    await notes.create('alice', 'proyectos/uno.md', '# Uno\n\nMira [[proyectos/dos]].');
  });

  it('el grafo muestra rutas sin el dueño, y las une por id aparte', async () => {
    const g = await notes.graph('alice');

    for (const node of g.nodes) {
      expect(node.path).not.toContain('alice/');
      expect(node.id).toContain('alice/');
    }
    expect(g.nodes.map((n) => n.path).sort()).toEqual(['proyectos/dos.md', 'proyectos/uno.md']);

    // Las aristas siguen hablando en ids, que es lo que las mantiene únicas
    // cuando el grafo incluye carpetas de otro dueño.
    for (const edge of g.edges) {
      expect(g.nodes.some((n) => n.id === edge.source)).toBe(true);
      expect(g.nodes.some((n) => n.id === edge.target)).toBe(true);
    }
  });

  it('el backlink no expone el dueño en el destino', async () => {
    const back = await notes.listLinks('alice', 'proyectos/dos.md');
    expect(back).toHaveLength(1);
    expect(back[0]!.sourcePath).toBe('proyectos/uno.md');
    expect(back[0]!.targetPath).toBe('proyectos/dos.md');
  });

  it('el "no encontrado" nombra la ruta que pidió el usuario', async () => {
    await expect(notes.get('alice', 'proyectos/no-existe.md')).rejects.toThrow(
      'note not found: proyectos/no-existe.md',
    );
  });

  it('el "ya existe" tampoco lo expone', async () => {
    await expect(
      notes.create('alice', 'proyectos/uno.md', 'otra cosa'),
    ).rejects.toThrow('note already exists: proyectos/uno.md');
  });
});

/**
 * El caso tal como apareció probando la app a mano: crear la nota que enlaza
 * antes que su destino, con el prefijo de dueño en el medio. Ahí el backlink no
 * salía marcado como no resuelto — no salía en absoluto, porque el destino
 * pendiente se guarda sin prefijo y la búsqueda lo pide con prefijo.
 */
describe('afinidad en hosted', () => {
  it('no une notas de dueños distintos aunque compartan un tema', async () => {
    await notes.create('alice', 'A/uno.md', '# Uno', { technologies: ['gemini-api'] });
    await notes.create('alice', 'A/dos.md', '# Dos', { technologies: ['gemini-api'] });
    await notes.create('bob', 'B/tres.md', '# Tres', { technologies: ['gemini-api'] });

    const { topics, edges } = await notes.affinity('alice');
    expect(topics).toHaveLength(1);
    expect(topics[0]!.notes).toEqual(['alice/A/dos.md', 'alice/A/uno.md']);
    expect(edges).toHaveLength(1);
    expect(JSON.stringify({ topics, edges })).not.toContain('bob');
  });
});

describe('menciones sin enlazar en hosted', () => {
  it('no lee ni reescribe la bóveda de otro dueño', async () => {
    await notes.create('alice', 'Atlas/_Atlas.md', '# Atlas');
    await notes.create('bob', 'Suyo/nota.md', '# Nota de bob\n\nhabla de Atlas');

    expect((await notes.unlinkedMentions('alice', 'Atlas/_Atlas.md')).incoming).toEqual([]);
    await expect(notes.linkMentions('alice', 'Suyo/nota.md', 'Atlas/_Atlas.md')).rejects.toThrow();
    expect((await notes.get('bob', 'Suyo/nota.md')).body).toContain('habla de Atlas');
  });

  it('el enlace escrito no lleva el id del dueño', async () => {
    await notes.create('alice', 'Atlas/_Atlas.md', '# Atlas');
    await notes.create('alice', 'Otra/nota.md', '# Otra\n\nusa Atlas');
    await notes.linkMentions('alice', 'Otra/nota.md', 'Atlas/_Atlas.md');

    const body = (await notes.get('alice', 'Otra/nota.md')).body;
    expect(body).toContain('[[Atlas/_Atlas|Atlas]]');
    expect(body).not.toContain('alice/');
  });
});

describe('mover dentro de una bóveda hosted', () => {
  it('la nota movida conserva su dueño y sus enlaces siguen resueltos', async () => {
    await notes.create('alice', 'Ideas/bot/concepto.md', '# Concepto\n\nver [[prerrequisitos]]');
    await notes.create('alice', 'Ideas/bot/prerrequisitos.md', '# Pre\n\nver [[concepto]]');

    await notes.move('alice', 'Ideas', 'ideas');

    const { nodes } = await notes.graph('alice');
    expect(nodes.map((n) => n.ownerId)).toEqual(['alice', 'alice']);

    const fromConcepto = await notes.listOutboundLinks('alice', 'ideas/bot/concepto.md');
    expect(fromConcepto).toMatchObject([
      { targetPath: 'ideas/bot/prerrequisitos.md', targetType: 'note' },
    ]);
    const fromPre = await notes.listOutboundLinks('alice', 'ideas/bot/prerrequisitos.md');
    expect(fromPre).toMatchObject([{ targetPath: 'ideas/bot/concepto.md', targetType: 'note' }]);
  });
});

describe('enlaces pendientes con varios dueños', () => {
  it('el backlink aparece cuando alice crea el destino después', async () => {
    await notes.createFolder('alice', 'proyectos');
    await notes.create('alice', 'proyectos/brainstack.md', 'Ver [[proyectos/ideas]].');
    expect(await notes.listLinks('alice', 'proyectos/ideas.md')).toHaveLength(0);

    await notes.create('alice', 'proyectos/ideas.md', '# Ideas');

    const back = await notes.listLinks('alice', 'proyectos/ideas.md');
    expect(back).toHaveLength(1);
    expect(back[0]!.sourcePath).toBe('proyectos/brainstack.md');
    expect(back[0]!.targetType).toBe('note');
  });

  it('la nota de bob no reclama los enlaces pendientes de alice', async () => {
    await notes.createFolder('alice', 'proyectos');
    await notes.create('alice', 'proyectos/uno.md', 'Ver [[proyectos/compartida]].');

    // Bob crea una nota en la misma ruta lógica: no es la que alice esperaba.
    await notes.createFolder('bob', 'proyectos');
    await notes.create('bob', 'proyectos/compartida.md', '# La de bob');

    expect(await notes.listLinks('alice', 'proyectos/compartida.md')).toHaveLength(0);
    expect(await notes.listLinks('bob', 'proyectos/compartida.md')).toHaveLength(0);

    // Y cuando alice sí la crea, el enlace se conecta con la suya.
    await notes.create('alice', 'proyectos/compartida.md', '# La de alice');
    const back = await notes.listLinks('alice', 'proyectos/compartida.md');
    expect(back).toHaveLength(1);
    expect(back[0]!.sourcePath).toBe('proyectos/uno.md');
  });
});
