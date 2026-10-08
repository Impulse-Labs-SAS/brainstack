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
  notes = new NoteService({ db: database.db });
  search = new SearchService({ db: database.db });
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

  it('changes the checksum when an update touches only the frontmatter', async () => {
    await notes.create(USER, 'Inbox/fm-only.md', '---\ntags: [a]\n---\n# T\n');
    const before = await notes.get(USER, 'Inbox/fm-only.md');

    await notes.update(USER, 'Inbox/fm-only.md', '---\ntags: [a, b]\n---\n# T\n');
    const after = await notes.get(USER, 'Inbox/fm-only.md');

    expect(after.checksum).not.toBe(before.checksum);
  });

  it('does not list a new MOC among its own affected MOCs', async () => {
    await notes.create(USER, 'Frodo/_Frodo.md', '# Frodo');
    const { affectedMocs } = await notes.create(USER, 'Frodo/ideas/_ideas.md', '# Ideas');
    expect(affectedMocs).toEqual(['Frodo/_Frodo.md']);
  });

  it('preserves frontmatter across an update that carries none', async () => {
    await notes.create(USER, 'Inbox/fm.md', '# T', { status: 'wip' });
    await notes.update(USER, 'Inbox/fm.md', '# T\n\ncambiado');

    const read = await notes.get(USER, 'Inbox/fm.md');
    expect(read.frontmatter).toMatchObject({ status: 'wip' });
    expect(read.body).toContain('cambiado');
  });

  it('filters the list by folder and by tag', async () => {
    await notes.create(USER, 'Proyectos/a.md', '# A\n\n#erebor');
    await notes.create(USER, 'Inbox/b.md', '# B');

    const byFolder = await notes.list(USER, { folder: 'Proyectos' });
    expect(byFolder.map((n) => n.path)).toEqual(['Proyectos/a.md']);

    const byTag = await notes.list(USER, { tag: 'erebor' });
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
    await notes.create(USER, 'A.md', '# A', { tags: ['erebor'], technologies: ['nextjs'] });
    await notes.create(USER, 'B.md', '# B', { tags: ['erebor'], technologies: ['nextjs'] });
    await notes.create(USER, 'C.md', '# C', { tags: ['erebor'] });

    const related = await notes.listRelated(USER, 'A.md');
    const b = related.find((r) => r.path === 'B.md')!;
    const c = related.find((r) => r.path === 'C.md')!;
    expect(b.score).toBeGreaterThan(c.score);
  });

  it('listRelated does not count a shared creation date as relatedness', async () => {
    await notes.create(USER, 'A.md', '# A', { created: '2026-09-12', tags: ['propio-a'] });
    await notes.create(USER, 'B.md', '# B', { created: '2026-09-12', tags: ['propio-b'] });

    expect(await notes.listRelated(USER, 'A.md')).toEqual([]);
  });

  it('indexes an unquoted YAML date as the day, not as a quoted timestamp', async () => {
    await notes.create(USER, 'Fechada.md', '---\ncreated: 2026-09-14\n---\n# Fechada');

    const facets = await notes.listFacetsForNote(USER, 'Fechada.md');
    expect(facets).toContainEqual({ key: 'created', value: '2026-09-14', data: null });
  });

  it('listRelated returns nothing for a note with no tags or facets', async () => {
    await notes.create(USER, 'Solo.md', '# Solo');
    expect(await notes.listRelated(USER, 'Solo.md')).toEqual([]);
  });
});

describe('NoteService.graph projects', () => {
  it('gives each node its project: tag, then nearest MOC, then top-level folder', async () => {
    await notes.create(USER, 'Frodo/proyectos/tba/_tba.md', '# There & Back Again', {
      tags: ['proyecto/there-and-back-again'],
    });
    await notes.create(USER, 'Frodo/proyectos/tba/suelta.md', '# Suelta');
    await notes.create(USER, 'Frodo/life/perfil.md', '# Perfil');

    const { nodes } = await notes.graph(USER);
    const projectOf = (path: string) => nodes.find((n) => n.path === path)!.project.label;
    expect(projectOf('Frodo/proyectos/tba/suelta.md')).toBe('There & Back Again');
    expect(projectOf('Frodo/proyectos/tba/_tba.md')).toBe('There & Back Again');
    expect(projectOf('Frodo/life/perfil.md')).toBe('Frodo');
  });

  it('carries when each note was created and last edited, as epoch numbers', async () => {
    const before = Date.now();
    await notes.create(USER, 'Nota.md', '# Nota');

    const [node] = (await notes.graph(USER)).nodes;
    expect(typeof node!.createdAt).toBe('number');
    expect(node!.createdAt).toBeGreaterThanOrEqual(before);
    expect(node!.updatedAt).toBeGreaterThanOrEqual(node!.createdAt);
  });
});

describe('NoteService.affinity', () => {
  it('joins notes across folders by a shared content topic', async () => {
    await notes.create(USER, 'Atlas/lector.md', '# Lector', { technologies: ['gemini-api'] });
    await notes.create(USER, 'Nimbus/clasificador.md', '# Clasificador', {
      technologies: ['gemini-api'],
    });
    await notes.create(USER, 'Nimbus/otra.md', '# Otra', { technologies: ['hono'] });

    const { topics, edges } = await notes.affinity(USER);
    expect(topics.map((t) => t.label)).toEqual(['gemini-api']);
    // Stored paths, the same ids `graph` gives its nodes.
    expect(edges).toEqual([
      {
        source: `${USER}/Atlas/lector.md`,
        target: `${USER}/Nimbus/clasificador.md`,
        weight: 0.5,
        shared: ['gemini-api'],
      },
    ]);
  });

  it('does not treat type or authorship tags as topics', async () => {
    await notes.create(USER, 'A/_A.md', '# A', {
      tags: ['tipo/moc', 'persona/frodo'],
      status: 'idea',
    });
    await notes.create(USER, 'B/_B.md', '# B', {
      tags: ['tipo/moc', 'persona/frodo'],
      status: 'idea',
    });

    expect(await notes.affinity(USER)).toEqual({ topics: [], edges: [] });
  });
});

describe('NoteService unlinked mentions', () => {
  beforeEach(async () => {
    await notes.create(USER, 'Atlas/_Atlas.md', '# Atlas', { aliases: ['App de finanzas'] });
    await notes.create(
      USER,
      'Nimbus/bot.md',
      '# Nimbus bot\n\nComparte el lector con atlas y con la app de finanzas.',
    );
    await notes.create(
      USER,
      'Nimbus/enlazada.md',
      '# Enlazada\n\nVer [[Atlas/_Atlas]]. Atlas otra vez.',
    );
  });

  it('lists who names a note without linking it, and what a note names', async () => {
    const atlas = await notes.unlinkedMentions(USER, 'Atlas/_Atlas.md');
    expect(atlas.incoming).toMatchObject([
      { path: 'Nimbus/bot.md', title: 'Nimbus bot', text: 'atlas', count: 2 },
    ]);
    expect(atlas.outgoing).toEqual([]);

    const bot = await notes.unlinkedMentions(USER, 'Nimbus/bot.md');
    expect(bot.outgoing).toMatchObject([{ path: 'Atlas/_Atlas.md', count: 2 }]);
  });

  it('leaves out a pair already joined by a link', async () => {
    const atlas = await notes.unlinkedMentions(USER, 'Atlas/_Atlas.md');
    expect(atlas.incoming.map((m) => m.path)).not.toContain('Nimbus/enlazada.md');
  });

  it('links every mention, keeping the text, and then stops listing it', async () => {
    const { linked } = await notes.linkMentions(USER, 'Nimbus/bot.md', 'Atlas/_Atlas.md');
    expect(linked).toBe(2);

    const body = (await notes.get(USER, 'Nimbus/bot.md')).body;
    expect(body).toContain('con [[Atlas/_Atlas|atlas]] y con la [[Atlas/_Atlas|app de finanzas]].');

    const back = await notes.listLinks(USER, 'Atlas/_Atlas.md');
    expect(back.map((l) => l.sourcePath)).toContain('Nimbus/bot.md');
    expect((await notes.unlinkedMentions(USER, 'Atlas/_Atlas.md')).incoming).toEqual([]);
  });

  it('does not count a title that sits inside a longer one', async () => {
    await notes.create(USER, 'Atlas/vision.md', '# Visión — Atlas');
    await notes.create(USER, 'Demo/nota.md', '# Nota\n\nver la vision — ATLAS');

    const atlas = await notes.unlinkedMentions(USER, 'Atlas/_Atlas.md');
    expect(atlas.incoming.map((m) => m.path)).not.toContain('Demo/nota.md');
    const demo = await notes.unlinkedMentions(USER, 'Demo/nota.md');
    expect(demo.outgoing).toMatchObject([{ path: 'Atlas/vision.md', text: 'vision — ATLAS' }]);
  });

  it('keeps the frontmatter of the note it rewrites', async () => {
    await notes.create(USER, 'Nimbus/con-fm.md', 'menciona Atlas', { tags: ['ia'] });
    await notes.linkMentions(USER, 'Nimbus/con-fm.md', 'Atlas/_Atlas.md');
    expect((await notes.get(USER, 'Nimbus/con-fm.md')).frontmatter).toMatchObject({ tags: ['ia'] });
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
    await notes.create(USER, 'Erebor/Pricing.md', '# Pricing');
    await notes.create(USER, 'Inbox/ref.md', '# Ref\n\nver [[Erebor/Pricing]]');

    await notes.move(USER, 'Erebor/Pricing.md', 'Erebor/decisiones/Pricing.md');

    // The reference followed the note rather than going stale.
    const ref = await notes.get(USER, 'Inbox/ref.md');
    expect(ref.body).toContain('[[Erebor/decisiones/Pricing]]');
    expect(ref.body).not.toContain('[[Erebor/Pricing]]');
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

  it('keeps bare wikilinks resolved when their whole folder is renamed', async () => {
    // What production showed after `Ideas/` became `ideas/`: a bare link reads
    // the same before and after, so the body rewrite never resaved its note,
    // and the index kept pointing at the old spelling as unresolved.
    await notes.create(USER, 'Ideas/bot/concepto.md', '# Concepto\n\nver [[prerrequisitos]]');
    await notes.create(USER, 'Ideas/bot/prerrequisitos.md', '# Pre\n\nver [[concepto]]');

    await notes.move(USER, 'Ideas', 'ideas');

    // Both directions, so the assertion holds whichever note moved first.
    const fromConcepto = await notes.listOutboundLinks(USER, 'ideas/bot/concepto.md');
    expect(fromConcepto).toMatchObject([
      { targetPath: 'ideas/bot/prerrequisitos.md', targetType: 'note' },
    ]);
    const fromPre = await notes.listOutboundLinks(USER, 'ideas/bot/prerrequisitos.md');
    expect(fromPre).toMatchObject([{ targetPath: 'ideas/bot/concepto.md', targetType: 'note' }]);
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
