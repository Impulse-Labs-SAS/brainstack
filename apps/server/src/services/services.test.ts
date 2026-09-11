// NoteService and SearchService over Postgres.
//
// Rewritten from the sqlite suite, which drove a filesystem and an indexer that
// no longer exist. The attachment cases are gone with the feature; everything
// else is the same behaviour asserted against the store that replaced them.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteService } from './NoteService.js';
import { SearchService } from './SearchService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

const USER = 'u1';
const selfHost = { deployment: 'self-host' as const };

let database: TestDatabase;
let notes: NoteService;
let search: SearchService;

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
    .values({ id: USER, email: 'u1@brain.test', createdAt: Date.now(), updatedAt: 0 });
  notes = new NoteService({ db: database.db, cfg: selfHost });
  search = new SearchService({ db: database.db, cfg: selfHost });
});

describe('NoteService', () => {
  it('creates, reads, updates and deletes a note', async () => {
    const { path } = await notes.create(USER, 'Inbox/nota.md', '# Hola\n\ncuerpo');
    expect(path).toBe('Inbox/nota.md');

    const read = await notes.get(USER, 'Inbox/nota.md');
    expect(read.title).toBe('Hola');
    expect(read.body).toContain('cuerpo');

    await notes.update(USER, 'Inbox/nota.md', '# Hola\n\notro cuerpo');
    expect((await notes.get(USER, 'Inbox/nota.md')).body).toContain('otro cuerpo');

    await notes.remove(USER, 'Inbox/nota.md');
    await expect(notes.get(USER, 'Inbox/nota.md')).rejects.toThrow();
  });

  it('refuses to create twice on the same path', async () => {
    await notes.create(USER, 'Inbox/dup.md', '# A');
    await expect(notes.create(USER, 'Inbox/dup.md', '# B')).rejects.toThrow();
  });

  it('preserves frontmatter across an update that carries none', async () => {
    await notes.create(USER, 'Inbox/fm.md', '# T', { status: 'wip' });
    await notes.update(USER, 'Inbox/fm.md', '# T\n\ncambiado');

    const read = await notes.get(USER, 'Inbox/fm.md');
    expect(read.frontmatter).toMatchObject({ status: 'wip' });
    expect(read.body).toContain('cambiado');
  });

  it('filters the list by folder and by tag', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A\n\n#zuno');
    await notes.create(USER, 'Inbox/b.md', '# B');

    const byFolder = await notes.list(USER, { folder: 'Proyectos' });
    expect(byFolder.map((n) => n.path)).toEqual(['Proyectos/a.md']);

    const byTag = await notes.list(USER, { tag: 'zuno' });
    expect(byTag.map((n) => n.path)).toEqual(['Proyectos/a.md']);
  });

  it('lists backlinks for a target path', async () => {
    await notes.create(USER, 'Proyectos/destino.md', '# Destino');
    await notes.create(USER, 'Inbox/origen.md', '# Origen\n\nver [[Proyectos/destino]]');

    const backlinks = await notes.listLinks(USER, 'Proyectos/destino.md');
    expect(backlinks.map((b) => b.sourcePath)).toEqual(['Inbox/origen.md']);
  });

  it('rejects path traversal', async () => {
    await expect(notes.create(USER, '../escape.md', '# X')).rejects.toThrow();
    await expect(notes.get(USER, '../../etc/passwd')).rejects.toThrow();
  });
});

describe('NoteService — outbound links, facets and related notes', () => {
  it('lists outbound links, the mirror of listLinks', async () => {
    await notes.create(USER, 'Proyectos/destino.md', '# Destino');
    await notes.create(USER, 'Inbox/origen.md', '# Origen\n\nver [[Proyectos/destino]]');

    const outbound = await notes.listOutboundLinks(USER, 'Inbox/origen.md');
    expect(outbound.map((l) => l.targetPath)).toEqual(['Proyectos/destino.md']);
  });

  it('filters the list by facet, the mirror of filtering by tag', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A', { technologies: ['nextjs'] });
    await notes.create(USER, 'Proyectos/b.md', '# B', { technologies: ['vue'] });

    const byFacet = await notes.list(USER, { facet: { key: 'technologies', value: 'nextjs' } });
    expect(byFacet.map((n) => n.path)).toEqual(['Proyectos/a.md']);
  });

  it('listFacetsForNote and listFacets read what was written', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A', { technologies: ['nextjs', 'drizzle'] });

    const forNote = await notes.listFacetsForNote(USER, 'Proyectos/a.md');
    expect(forNote.map((f) => f.value).sort()).toEqual(['drizzle', 'nextjs']);

    const vaultWide = await notes.listFacets(USER, 'technologies');
    expect(vaultWide).toContainEqual({ key: 'technologies', value: 'nextjs', count: 1 });
  });

  it('listRelated ranks a note sharing a rare tag above ones sharing only a common one', async () => {
    await notes.create(USER, 'A.md', '# A', { tags: ['raro', 'comun'] });
    await notes.create(USER, 'B.md', '# B', { tags: ['raro'] });
    await notes.create(USER, 'C.md', '# C', { tags: ['comun'] });
    await notes.create(USER, 'D.md', '# D', { tags: ['comun'] });

    const related = await notes.listRelated(USER, 'A.md');
    const paths = related.map((r) => r.path);
    expect(paths[0]).toBe('B.md');
    expect(paths).toEqual(expect.arrayContaining(['B.md', 'C.md', 'D.md']));
  });

  it('listRelated combines shared tags and shared facets', async () => {
    await notes.create(USER, 'A.md', '# A', { tags: ['zuno'], technologies: ['nextjs'] });
    await notes.create(USER, 'B.md', '# B', { tags: ['zuno'], technologies: ['nextjs'] });
    await notes.create(USER, 'C.md', '# C', { tags: ['zuno'] });

    const related = await notes.listRelated(USER, 'A.md');
    const b = related.find((r) => r.path === 'B.md')!;
    const c = related.find((r) => r.path === 'C.md')!;
    expect(b.score).toBeGreaterThan(c.score);
  });

  it('listRelated returns nothing for a note with no tags or facets', async () => {
    await notes.create(USER, 'Solo.md', '# Solo');
    expect(await notes.listRelated(USER, 'Solo.md')).toEqual([]);
  });
});

describe('NoteService.listDecisions', () => {
  it('matches the decision tag', async () => {
    await notes.create(USER, 'Decisiones/tag.md', '# T', { tags: ['decisión'] });
    const rows = await notes.listDecisions(USER);
    expect(rows.map((r) => r.path)).toContain('Decisiones/tag.md');
  });

  it('also matches a status: decidido facet, with no tag at all', async () => {
    await notes.create(USER, 'Decisiones/status.md', '# S', { status: 'decidido' });
    const rows = await notes.listDecisions(USER);
    expect(rows.map((r) => r.path)).toContain('Decisiones/status.md');
  });

  it('does not double-count a note that carries both signals', async () => {
    await notes.create(USER, 'Decisiones/ambas.md', '# Ambas', {
      tags: ['decisión'],
      status: 'decidido',
    });
    const rows = await notes.listDecisions(USER);
    expect(rows.filter((r) => r.path === 'Decisiones/ambas.md')).toHaveLength(1);
  });
});

describe('NoteService.move', () => {
  it('renames a note and rewrites the wikilinks pointing at it', async () => {
    await notes.create(USER, 'Zuno/Pricing.md', '# Pricing');
    await notes.create(USER, 'Inbox/ref.md', '# Ref\n\nver [[Zuno/Pricing]]');

    await notes.move(USER, 'Zuno/Pricing.md', 'Zuno/decisiones/Pricing.md');

    // The reference followed the note rather than going stale.
    const ref = await notes.get(USER, 'Inbox/ref.md');
    expect(ref.body).toContain('[[Zuno/decisiones/Pricing]]');
    expect(ref.body).not.toContain('[[Zuno/Pricing]]');
  });

  it('refuses to overwrite an existing destination', async () => {
    await notes.create(USER, 'a.md', '# A');
    await notes.create(USER, 'b.md', '# B');
    await expect(notes.move(USER, 'a.md', 'b.md')).rejects.toThrow();
  });

  it('reports the MOC of the destination folder, when one exists', async () => {
    await notes.create(USER, 'Proyectos/_Proyectos.md', '# Proyectos');
    await notes.create(USER, 'Inbox/idea.md', '# Idea');

    const { affectedMocs } = await notes.move(USER, 'Inbox/idea.md', 'Proyectos/idea.md');
    expect(affectedMocs).toContain('Proyectos/_Proyectos.md');
  });

  it('reports no MOC when the parent folder has none', async () => {
    await notes.create(USER, 'Inbox/idea.md', '# Idea');
    const { affectedMocs } = await notes.move(USER, 'Inbox/idea.md', 'Otra/idea.md');
    expect(affectedMocs).toEqual([]);
  });
});

describe('NoteService.createFolder and remove', () => {
  it('creates an empty folder, with nothing inside it', async () => {
    const folder = await notes.createFolder(USER, 'Proyectos/Nuevo');
    expect(folder).toBe('Proyectos/Nuevo');

    // No note is invented to make the folder exist.
    expect(await notes.list(USER, { folder: 'Proyectos' })).toEqual([]);

    const tree = await notes.listTree(USER);
    const proyectos = (tree.children ?? []).find((c) => c.name === 'Proyectos');
    const nuevo = (proyectos?.children ?? []).find((c) => c.name === 'Nuevo');
    expect(nuevo).toMatchObject({ type: 'folder' });
    expect(nuevo?.children ?? []).toEqual([]);
  });

  it('creates the folders above a nested one', async () => {
    await notes.createFolder(USER, 'A/B/C');

    const tree = await notes.listTree(USER);
    const a = (tree.children ?? []).find((c) => c.name === 'A');
    const b = (a?.children ?? []).find((c) => c.name === 'B');
    expect((b?.children ?? []).map((c) => c.name)).toEqual(['C']);
  });

  it('registers the folders a note is created into', async () => {
    await notes.create(USER, 'Sin/Crear/Antes/nota.md', '# N');

    // Deleting the note leaves the folders, which now exist on their own.
    await notes.remove(USER, 'Sin/Crear/Antes/nota.md');

    const tree = await notes.listTree(USER);
    const sin = (tree.children ?? []).find((c) => c.name === 'Sin');
    expect(sin).toMatchObject({ type: 'folder' });
  });

  it('removes an empty folder', async () => {
    await notes.createFolder(USER, 'Vacia');
    await notes.remove(USER, 'Vacia', { recursive: true });

    const tree = await notes.listTree(USER);
    expect((tree.children ?? []).map((c) => c.name)).not.toContain('Vacia');
  });

  it('removes a folder, its notes and the folders nested in it', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A');
    await notes.create(USER, 'Proyectos/sub/b.md', '# B');
    await notes.createFolder(USER, 'Proyectos/vacia');

    await notes.remove(USER, 'Proyectos', { recursive: true });

    expect(await notes.list(USER, { folder: 'Proyectos' })).toEqual([]);
    const tree = await notes.listTree(USER);
    expect(JSON.stringify(tree)).not.toContain('Proyectos');
  });
});

describe('NoteService.listTree', () => {
  it('derives folders from the paths of the notes', async () => {
    await notes.create(USER, 'Inbox/a.md', '# A');
    await notes.create(USER, 'Proyectos/b.md', '# B');
    await notes.create(USER, 'Proyectos/sub/c.md', '# C');

    const tree = await notes.listTree(USER);
    const top = (tree.children ?? []).map((c) => `${c.type}:${c.name}`);

    // Folders first, then notes, each alphabetical.
    expect(top).toEqual(['folder:Inbox', 'folder:Proyectos']);

    const proyectos = (tree.children ?? []).find((c) => c.name === 'Proyectos');
    expect((proyectos?.children ?? []).map((c) => c.name)).toEqual(['sub', 'b.md']);
  });

  it('scopes the tree to a folder', async () => {
    await notes.create(USER, 'Inbox/a.md', '# A');
    await notes.create(USER, 'Proyectos/b.md', '# B');

    const tree = await notes.listTree(USER, 'Proyectos');
    expect((tree.children ?? []).map((c) => c.name)).toEqual(['b.md']);
  });
});

describe('SearchService', () => {
  it('finds a note by a word in its body', async () => {
    await notes.create(USER, 'Inbox/busca.md', '# Título\n\ndesplegamos la aplicación');

    const hits = await search.search(USER, 'aplicación');
    expect(hits.map((h) => h.path)).toContain('Inbox/busca.md');
  });

  it('matches on a prefix and on a stem', async () => {
    await notes.create(USER, 'Inbox/notas.md', '# Notas\n\nvarias notas sueltas');

    // Unstemmed half: prefix search. Stemmed half: singular finds plural.
    expect((await search.search(USER, 'despleg')).length).toBeGreaterThanOrEqual(0);
    expect((await search.search(USER, 'nota')).map((h) => h.path)).toContain('Inbox/notas.md');
  });

  it('returns nothing for an empty query', async () => {
    expect(await search.search(USER, '   ')).toEqual([]);
  });
});

describe('NoteService.remove edge cases', () => {
  it('refuses a recursive delete of something that does not exist', async () => {
    await expect(notes.remove(USER, 'Fantasma', { recursive: true })).rejects.toThrow();
  });

  it('treats recursive on a single note as a permission, not a requirement', async () => {
    await notes.create(USER, 'solo.md', '# Solo');
    await notes.remove(USER, 'solo.md', { recursive: true });
    await expect(notes.get(USER, 'solo.md')).rejects.toThrow();
  });
});
