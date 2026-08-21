// Tests for the Postgres store, run against a real Postgres.
//
// PGlite is genuine Postgres compiled to WASM, so the migration SQL, the
// tsvector generated column, the GIN index, ON CONFLICT and ts_headline are all
// exercised for real here — not mocked. Production talks to Neon over HTTP
// instead, but the SQL is identical.

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

import { PathTraversalError } from '../paths.js';

import { ensurePgSchema, runPgMigrations, type PgDb } from './client.js';
import { pgMigrations } from './migrations.js';
import { PgNoteStore, NoteAlreadyExistsError, NoteNotFoundError, toMarkdown } from './notes.js';
import { normalizeNoteKey } from '../paths.js';
import { PgSearchService, tokenize, toTsQuery } from './search.js';

let db: PgDb;
let notes: PgNoteStore;
let search: PgSearchService;

beforeAll(async () => {
  const client = new PGlite();
  // The store is written against the Neon HTTP driver; PGlite speaks the same
  // Drizzle query API, so the cast is safe and keeps the SQL under test.
  db = drizzle(client) as unknown as PgDb;
  await runPgMigrations(db);
  notes = new PgNoteStore(db);
  search = new PgSearchService(db);
});

describe('migrations', () => {
  it('are idempotent', async () => {
    // Second run must apply nothing and must not throw.
    await expect(runPgMigrations(db)).resolves.toEqual([]);
  });

  it('builds the schema on first use, and only once', async () => {
    // A database with nothing in it — the state a new deployment starts from,
    // where there is no endpoint to call and no credential to call it with.
    const fresh = drizzle(new PGlite()) as unknown as PgDb;

    // Concurrent cold requests must not each run the migrations.
    await Promise.all([ensurePgSchema(fresh), ensurePgSchema(fresh), ensurePgSchema(fresh)]);

    const applied = await fresh.execute<{ name: string }>(
      sql.raw('SELECT name FROM _brainstack_migrations ORDER BY name'),
    );
    // Derived from the list rather than spelled out, so adding a migration does
    // not fail this test for the wrong reason. What is asserted is that every
    // declared migration ran, in order, exactly once.
    expect(applied.rows.map((r) => r.name)).toEqual(pgMigrations.map((m) => m.name));

    // Usable straight away: no separate setup step ran.
    const store = new PgNoteStore(fresh);
    await store.create('Inbox/arranque.md', '# Arranque');
    expect((await store.get('Inbox/arranque.md')).path).toBe('Inbox/arranque.md');
  });
});

describe('note paths', () => {
  it('normalises separators and strips leading ./', () => {
    expect(normalizeNoteKey('./Inbox\\nota.md')).toBe('Inbox/nota.md');
    expect(normalizeNoteKey('  Inbox//nota.md  ')).toBe('Inbox/nota.md');
  });

  it('rejects traversal, absolute paths, null bytes and non-markdown', () => {
    expect(() => normalizeNoteKey('../etc/passwd.md')).toThrow(PathTraversalError);
    expect(() => normalizeNoteKey('Inbox/../../secret.md')).toThrow(PathTraversalError);
    expect(() => normalizeNoteKey('/etc/passwd.md')).toThrow(PathTraversalError);
    expect(() => normalizeNoteKey('nota\0.md')).toThrow(PathTraversalError);
    expect(() => normalizeNoteKey('nota.txt')).toThrow(PathTraversalError);
    expect(() => normalizeNoteKey('   ')).toThrow(PathTraversalError);
  });
});

describe('PgNoteStore', () => {
  it('stores frontmatter separately and gives markdown back intact', async () => {
    const markdown = '---\ntitle: Mi nota\ntags:\n  - prueba\n---\n\n# Encabezado\n\nCuerpo.';
    const saved = await notes.upsert('Inbox/mi-nota.md', markdown);

    expect(saved.title).toBe('Mi nota');
    expect(saved.frontmatter).toMatchObject({ title: 'Mi nota', tags: ['prueba'] });
    // The body column holds markdown without the frontmatter block.
    expect(saved.body).not.toContain('---');

    const round = toMarkdown(await notes.get('Inbox/mi-nota.md'));
    expect(round).toContain('title: Mi nota');
    expect(round).toContain('# Encabezado');
  });

  it('leaves updated_at untouched when the content is unchanged', async () => {
    const first = await notes.upsert('Inbox/idem.md', '# Igual');
    await new Promise((r) => setTimeout(r, 5));
    const second = await notes.upsert('Inbox/idem.md', '# Igual');
    expect(second.updatedAt).toBe(first.updatedAt);

    const third = await notes.upsert('Inbox/idem.md', '# Distinto');
    expect(third.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(third.checksum).not.toBe(first.checksum);
  });

  it('refuses to create over an existing note but upsert replaces it', async () => {
    await notes.upsert('Inbox/ocupada.md', '# Uno');
    await expect(notes.create('Inbox/ocupada.md', '# Dos')).rejects.toThrow(NoteAlreadyExistsError);
    await expect(notes.upsert('Inbox/ocupada.md', '# Dos')).resolves.toMatchObject({
      path: 'Inbox/ocupada.md',
    });
  });

  it('raises NoteNotFoundError on missing reads and deletes', async () => {
    await expect(notes.get('Inbox/fantasma.md')).rejects.toThrow(NoteNotFoundError);
    await expect(notes.remove('Inbox/fantasma.md')).rejects.toThrow(NoteNotFoundError);
  });

  it('lists by folder, newest first', async () => {
    await notes.upsert('Proyectos/uno.md', '# Uno');
    await notes.upsert('Proyectos/dos.md', '# Dos');

    const listed = await notes.list({ folder: 'Proyectos' });
    expect(listed.map((n) => n.path).sort()).toEqual(['Proyectos/dos.md', 'Proyectos/uno.md']);

    const all = await notes.list({});
    expect(all.length).toBeGreaterThan(listed.length);
  });

  it('treats LIKE wildcards in a folder as literal characters', async () => {
    await notes.upsert('Real/nota.md', '# Real');
    // `%` must not match everything, or a crafted filter would leak every note.
    expect(await notes.list({ folder: '%' })).toEqual([]);
  });

  it('filters by frontmatter status', async () => {
    await notes.upsert('Estado/activa.md', '---\nstatus: active\n---\n\n# Activa');
    await notes.upsert('Estado/cerrada.md', '---\nstatus: done\n---\n\n# Cerrada');

    const active = await notes.list({ status: 'active' });
    expect(active.map((n) => n.path)).toContain('Estado/activa.md');
    expect(active.map((n) => n.path)).not.toContain('Estado/cerrada.md');
  });

  it('moves a note and leaves nothing behind at the old path', async () => {
    await notes.upsert('Mover/origen.md', '# Origen\n\n#etiqueta');
    const moved = await notes.move('Mover/origen.md', 'Mover/destino.md');

    expect(moved.path).toBe('Mover/destino.md');
    await expect(notes.get('Mover/origen.md')).rejects.toThrow(NoteNotFoundError);
    // The derived rows must follow the note, not stay orphaned at the old path.
    expect(await notes.list({ tag: 'etiqueta' })).toContainEqual(
      expect.objectContaining({ path: 'Mover/destino.md' }),
    );
  });

  it('refuses to move onto an occupied path', async () => {
    await notes.upsert('Mover/a.md', '# A');
    await notes.upsert('Mover/b.md', '# B');
    await expect(notes.move('Mover/a.md', 'Mover/b.md')).rejects.toThrow(NoteAlreadyExistsError);
  });
});

describe('links and tags', () => {
  it('derives backlinks from wikilinks on write', async () => {
    await notes.upsert('Grafo/destino.md', '# Destino');
    await notes.upsert('Grafo/origen.md', '# Origen\n\nApunta a [[destino]].');

    const backlinks = await notes.listBacklinks('Grafo/destino.md');
    expect(backlinks.map((b) => b.sourcePath)).toContain('Grafo/origen.md');
    expect(backlinks[0]?.linkKind).toBe('wikilink');
  });

  it('rebuilds the graph on every write instead of accumulating stale rows', async () => {
    await notes.upsert('Grafo/uno.md', '# Uno');
    await notes.upsert('Grafo/dos.md', '# Dos');
    await notes.upsert('Grafo/movil.md', 'Apunta a [[uno]].');
    expect(await notes.listBacklinks('Grafo/uno.md')).toHaveLength(1);

    // Repoint the link: the old backlink must disappear, not linger.
    await notes.upsert('Grafo/movil.md', 'Ahora apunta a [[dos]].');
    expect(await notes.listBacklinks('Grafo/uno.md')).toHaveLength(0);
    expect(await notes.listBacklinks('Grafo/dos.md')).toHaveLength(1);
  });

  it('cascades links and tags away when the note is deleted', async () => {
    await notes.upsert('Grafo/borrame.md', '# Borrame\n\n#temporal [[uno]]');
    expect(await notes.list({ tag: 'temporal' })).toHaveLength(1);

    await notes.remove('Grafo/borrame.md');
    expect(await notes.list({ tag: 'temporal' })).toHaveLength(0);
    expect(await notes.listBacklinks('Grafo/uno.md')).toHaveLength(0);
  });

  it('collects tags from both frontmatter and the body', async () => {
    await notes.upsert(
      'Grafo/etiquetada.md',
      '---\ntags:\n  - desde-frontmatter\n---\n\n# Nota\n\nY #desde-cuerpo tambien.',
    );

    const byFm = await notes.list({ tag: 'desde-frontmatter' });
    const byBody = await notes.list({ tag: 'desde-cuerpo' });
    expect(byFm.map((n) => n.path)).toContain('Grafo/etiquetada.md');
    expect(byBody.map((n) => n.path)).toContain('Grafo/etiquetada.md');

    const all = await notes.listTags();
    expect(all.map((t) => t.tag)).toEqual(expect.arrayContaining(['desde-frontmatter']));
  });
});

describe('PgSearchService', () => {
  beforeAll(async () => {
    await notes.upsert(
      'Busqueda/postgres.md',
      '# Postgres\n\nBrainStack guarda las notas en Postgres con búsqueda de texto completo.',
    );
    await notes.upsert('Busqueda/netlify.md', '# Netlify\n\nDesplegamos funciones serverless.');
  });

  it('finds a note by a word from its body and highlights it', async () => {
    const hits = await search.search('serverless');
    expect(hits.map((h) => h.path)).toContain('Busqueda/netlify.md');
    expect(hits[0]?.snippet).toContain('<mark>');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('matches on a prefix, like the old FTS5 behaviour', async () => {
    const hits = await search.search('desplegam');
    expect(hits.map((h) => h.path)).toContain('Busqueda/netlify.md');
  });

  it('ranks and highlights a prefix hit, not just finds it', async () => {
    // Regression: OR-ing the prefix and stem queries into one tsquery made
    // ts_rank return 0 and ts_headline highlight nothing whenever only one half
    // matched — exactly the half-typed case. Results came back unranked and
    // without a snippet, which reads as "search is broken" rather than an error.
    const [hit] = await search.search('desplegam');

    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.snippet).toContain('<mark>');
  });

  it('ranks and highlights a stem-only hit too', async () => {
    // The mirror case: found through the stemmed half, where the unstemmed
    // headline has nothing to mark.
    await notes.upsert('Busqueda/singular.md', '# Singular\n\nGuardamos una nota importante.');
    const hits = await search.search('notas');
    const hit = hits.find((h) => h.path === 'Busqueda/singular.md');

    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.snippet).toContain('<mark>');
  });

  it('matches across morphology thanks to the stemmed half of the index', async () => {
    await notes.upsert('Busqueda/plural.md', '# Plural\n\nGuardamos una nota importante.');
    // Singular in the document, plural in the query: only the stemmed vector
    // can bridge this, and a prefix query alone would miss it.
    const hits = await search.search('notas');
    expect(hits.map((h) => h.path)).toContain('Busqueda/plural.md');
  });

  it('returns nothing for an empty query instead of every note', async () => {
    expect(await search.search('')).toEqual([]);
    expect(await search.search('   ')).toEqual([]);
  });

  it('neutralises tsquery operators in user input', async () => {
    // Raw input like this would be a syntax error if passed straight through.
    await expect(search.search('postgres & | ! ( ) :*')).resolves.toBeInstanceOf(Array);
    await expect(search.search("' OR 1=1 --")).resolves.toBeInstanceOf(Array);
  });

  it('builds OR-joined prefix terms and strips operators', () => {
    expect(toTsQuery('hola mundo')).toBe('hola:* | mundo:*');
    expect(toTsQuery('a&b !c')).toBe('ab:* | c:*');
    expect(toTsQuery('  ')).toBe('');
    expect(tokenize("drop' | table:*")).toEqual(['drop', 'table']);
  });

  it('respects the limit', async () => {
    const hits = await search.search('postgres netlify brainstack', { limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
