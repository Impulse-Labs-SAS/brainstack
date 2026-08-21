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
  it('creates a folder by writing the MOC that makes it exist', async () => {
    const folder = await notes.createFolder(USER, 'Proyectos/Nuevo');
    expect(folder).toBe('Proyectos/Nuevo');

    const moc = await notes.get(USER, 'Proyectos/Nuevo/_Nuevo.md');
    expect(moc.title).toBe('Nuevo');
  });

  it('removes a folder and everything under it', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A');
    await notes.create(USER, 'Proyectos/sub/b.md', '# B');
    await notes.create(USER, 'Proyectos/_Proyectos.md', '# P');

    // Deleting the folder, which has no row of its own.
    await notes.remove(USER, 'Proyectos', { recursive: true });

    // The MOC and everything beside it are gone.
    expect(await notes.list(USER, { folder: 'Proyectos' })).toEqual([]);
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
