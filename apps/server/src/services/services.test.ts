import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, writeNote, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { AppError } from '../lib/errors.js';

import { IndexService } from './IndexService.js';
import { NoteService } from './NoteService.js';
import { SearchService } from './SearchService.js';

const logger = pino({ level: 'silent' });
const USER = 'user-test';

let root: string;
let bs: BrainStackDatabase;
let index: IndexService;
let notes: NoteService;
let search: SearchService;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'brain-svc-'));
  bs = openDatabase(':memory:');
  index = new IndexService({ root, db: bs, logger });
  notes = new NoteService({
    cfg: { deployment: 'self-host', notesDirAbs: root },
    db: bs,
    index,
  });
  search = new SearchService({
    db: bs,
    cfg: { deployment: 'self-host', notesDirAbs: root },
  });
  await index.bootstrap();
});

afterEach(async () => {
  bs.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('NoteService', () => {
  it('creates, reads, updates, and deletes a note', async () => {
    const created = await notes.create(USER, 'Zuno/note.md', '# Hello\nbody', {
      created: '2026-05-15',
      tags: ['zuno'],
    });
    expect(created.path).toBe('Zuno/note.md');
    expect(created.affectedMocs).toEqual([]);
    const path = created.path;

    const read = await notes.get(USER, path);
    expect(read.body).toContain('# Hello');
    expect(read.frontmatter).toMatchObject({ created: '2026-05-15' });

    await notes.update(USER, path, '# Hello\nbody updated');
    expect((await notes.get(USER, path)).body).toContain('updated');

    await notes.remove(USER, path);
    await expect(notes.get(USER, path)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to create twice on the same path', async () => {
    await notes.create(USER, 'dupe.md', 'x');
    await expect(notes.create(USER, 'dupe.md', 'y')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('filters list by tag and folder', async () => {
    await notes.create(USER, 'Zuno/a.md', '#zuno body');
    await notes.create(USER, 'BRUTUS/b.md', '#brutus body');
    const zunoOnly = notes.list(USER, { folder: 'Zuno' });
    expect(zunoOnly.map((r) => r.path)).toEqual(['Zuno/a.md']);
    const byTag = notes.list(USER, { tag: 'brutus' });
    expect(byTag.map((r) => r.path)).toEqual(['BRUTUS/b.md']);
  });

  it('lists backlinks for a target path', async () => {
    await writeNote(root, 'a.md', '[[target]]');
    await writeNote(root, 'b.md', '[[target]] again');
    await writeNote(root, 'target.md', '# target');
    await index.bootstrap();
    const links = notes.listLinks(USER, 'target.md');
    expect(links.map((l) => l.sourcePath).sort()).toEqual(['a.md', 'b.md']);
  });
});

describe('NoteService.move', () => {
  it('renames a note and rewrites wikilinks across the vault', async () => {
    await notes.create(USER, 'Zuno/Pricing.md', '# Pricing');
    await notes.create(USER, 'BRUTUS/index.md', '- [[Zuno/Pricing]]\n- [[Zuno/Pricing|el doc]]');
    await notes.create(USER, 'General/notes.md', 'see [[Zuno/Pricing#tier]]');

    const moved = await notes.move(USER, 'Zuno/Pricing.md', 'Zuno/decisiones/Pricing.md');
    expect(moved.path).toBe('Zuno/decisiones/Pricing.md');
    expect(moved.affectedMocs).toEqual([]);

    expect((await notes.get(USER, 'BRUTUS/index.md')).body).toBe(
      '- [[Zuno/decisiones/Pricing]]\n- [[Zuno/decisiones/Pricing|el doc]]',
    );
    expect((await notes.get(USER, 'General/notes.md')).body).toBe(
      'see [[Zuno/decisiones/Pricing#tier]]',
    );
    // old path is gone from the index, new path is queryable
    await expect(notes.get(USER, 'Zuno/Pricing.md')).rejects.toBeInstanceOf(AppError);
    expect((await notes.get(USER, 'Zuno/decisiones/Pricing.md')).path).toBe(
      'Zuno/decisiones/Pricing.md',
    );
  });

  it('moves a whole folder and rewrites references for every contained note', async () => {
    await notes.create(USER, 'Zuno/decisiones/a.md', '# A');
    await notes.create(USER, 'Zuno/decisiones/b.md', '# B');
    await notes.create(USER, 'Index.md', '- [[Zuno/decisiones/a]]\n- [[Zuno/decisiones/b|nota b]]');

    await notes.move(USER, 'Zuno/decisiones', 'Zuno/decisiones-v2');

    expect((await notes.get(USER, 'Index.md')).body).toBe(
      '- [[Zuno/decisiones-v2/a]]\n- [[Zuno/decisiones-v2/b|nota b]]',
    );
    expect((await notes.get(USER, 'Zuno/decisiones-v2/a.md')).body).toContain('# A');
    expect((await notes.get(USER, 'Zuno/decisiones-v2/b.md')).body).toContain('# B');
  });

  it('moves a folder mixing .md and binaries, rewriting both kinds of references', async () => {
    await notes.create(USER, 'Mixed/note.md', '# Note');
    // Drop a binary directly under Mixed/ via the core helper (this is the
    // "raro" case — binaries outside Attachments/ — that move must still
    // handle correctly).
    const { promises: fsp2 } = await import('node:fs');
    const { join: join2 } = await import('node:path');
    await fsp2.mkdir(join2(root, 'Mixed'), { recursive: true });
    await fsp2.writeFile(join2(root, 'Mixed', 'doc.pdf'), Buffer.from([1, 2, 3]));

    await notes.create(USER, 
      'Index.md',
      'see [[Mixed/note]] and ![[Mixed/doc.pdf]] and [[Mixed/note|inline]]',
    );

    await notes.move(USER, 'Mixed', 'Archive/Mixed');

    expect((await notes.get(USER, 'Index.md')).body).toBe(
      'see [[Archive/Mixed/note]] and ![[Archive/Mixed/doc.pdf]] and [[Archive/Mixed/note|inline]]',
    );
    // both files landed at the new path
    expect((await notes.get(USER, 'Archive/Mixed/note.md')).body).toContain('# Note');
    const moved = await fsp2.readFile(join2(root, 'Archive', 'Mixed', 'doc.pdf'));
    expect(Array.from(moved)).toEqual([1, 2, 3]);
  });

  it('returns affectedMocs from both source and dest parents, deduped, and only when the MOC exists', async () => {
    // MOC for Zuno exists; MOC for Zuno/decisiones does not.
    await notes.create(USER, 'Zuno/_Zuno.md', '# Zuno\n## Notas\n- [[note]]');
    await notes.create(USER, 'Zuno/note.md', '# Note');

    const moved = await notes.move(USER, 'Zuno/note.md', 'Zuno/decisiones/note.md');
    expect(moved.affectedMocs).toEqual(['Zuno/_Zuno.md']);

    // same-parent rename → MOC appears once, not twice
    await notes.create(USER, 'Zuno/another.md', '# A');
    const renamed = await notes.move(USER, 'Zuno/another.md', 'Zuno/renamed.md');
    expect(renamed.affectedMocs).toEqual(['Zuno/_Zuno.md']);

    // dest parent MOC also exists → both show up
    await notes.create(USER, 'Zuno/decisiones/_decisiones.md', '# decisiones\n## Notas');
    const both = await notes.move(USER, 'Zuno/renamed.md', 'Zuno/decisiones/renamed.md');
    expect(both.affectedMocs.sort()).toEqual([
      'Zuno/_Zuno.md',
      'Zuno/decisiones/_decisiones.md',
    ]);
  });

  it('returns affectedMocs for create_note when the parent has a MOC', async () => {
    await notes.create(USER, 'Zuno/_Zuno.md', '# Zuno\n## Notas');
    const created = await notes.create(USER, 'Zuno/idea.md', '# Idea');
    expect(created.affectedMocs).toEqual(['Zuno/_Zuno.md']);

    const orphan = await notes.create(USER, 'General/lonely.md', '# Lonely');
    expect(orphan.affectedMocs).toEqual([]);
  });

  it('refuses to overwrite an existing destination', async () => {
    await notes.create(USER, 'a.md', 'one');
    await notes.create(USER, 'b.md', 'two');
    await expect(notes.move(USER, 'a.md', 'b.md')).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });
});

describe('NoteService.createFolder + remove', () => {
  it('creates a folder and refuses to delete it when non-empty without recursive', async () => {
    await notes.createFolder(USER, 'Projects/2026');
    await notes.create(USER, 'Projects/2026/q1.md', 'hi');
    await expect(notes.remove(USER, 'Projects/2026')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // recursive succeeds and drops the note from the index
    const result = await notes.remove(USER, 'Projects/2026', { recursive: true });
    expect(result.deleted).toEqual(['Projects/2026/q1.md']);
    await expect(notes.get(USER, 'Projects/2026/q1.md')).rejects.toBeInstanceOf(AppError);
  });

  it('reports every deleted path under a recursive folder delete', async () => {
    await notes.create(USER, 'Tree/a.md', '#a');
    await notes.create(USER, 'Tree/sub/b.md', '#b');
    await notes.uploadAttachment(USER, {
      path: 'Attachments/2026/05/embed.png',
      dataBase64: Buffer.from('x').toString('base64'),
    });

    // mixed-folder case: a binary alongside a markdown
    const { promises: fsp2 } = await import('node:fs');
    const { join: join2 } = await import('node:path');
    await fsp2.writeFile(join2(root, 'Tree', 'doc.pdf'), Buffer.from([9]));

    const { deleted } = await notes.remove(USER, 'Tree', { recursive: true });
    expect(deleted).toEqual(['Tree/a.md', 'Tree/doc.pdf', 'Tree/sub/b.md']);
  });

  it('returns a single-element list for a file delete', async () => {
    await notes.create(USER, 'alone.md', 'x');
    const result = await notes.remove(USER, 'alone.md');
    expect(result.deleted).toEqual(['alone.md']);
  });

  it('treats recursive on a single file as a permission, not a requirement', async () => {
    await notes.create(USER, 'solo.md', 'x');
    const result = await notes.remove(USER, 'solo.md', { recursive: true });
    expect(result.deleted).toEqual(['solo.md']);
  });

  it('rejects path traversal', async () => {
    await expect(notes.createFolder(USER, '../escape')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('NoteService attachments', () => {
  const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('uploads and reads back an attachment', async () => {
    const path = await notes.uploadAttachment(USER, {
      path: 'Attachments/2026/05/img.png',
      dataBase64: PNG_B64,
      mime: 'image/png',
    });
    expect(path).toBe('Attachments/2026/05/img.png');
    const got = await notes.getAttachment(USER, path);
    expect(got.dataBase64).toBe(PNG_B64);
    expect(got.sizeBytes).toBe(4);
  });

  it('rejects upload outside Attachments/', async () => {
    await expect(
      notes.uploadAttachment(USER, {
        path: 'Zuno/img.png',
        dataBase64: PNG_B64,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('returns 404 when the attachment is missing', async () => {
    await expect(notes.getAttachment(USER, 'Attachments/missing.pdf')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('NoteService.listTree', () => {
  it('builds a folder-first sorted tree from indexed notes and attachments', async () => {
    await notes.create(USER, 'Zuno/a.md', '# A');
    await notes.create(USER, 'Zuno/decisiones/d.md', '# D');
    await notes.create(USER, 'BRUTUS/b.md', '# B');
    await notes.uploadAttachment(USER, {
      path: 'Attachments/2026/05/img.png',
      dataBase64: Buffer.from('x').toString('base64'),
    });
    // Force the attachments table to repopulate; uploadAttachment doesn't
    // touch the index directly (the watcher does on its rescan).
    await index.bootstrap();

    const tree = await notes.listTree(USER);
    const names = (tree.children ?? []).map((c) => `${c.type}:${c.name}`);
    // Folders first, alphabetical.
    expect(names).toEqual(['folder:Attachments', 'folder:BRUTUS', 'folder:Zuno']);

    const zuno = tree.children?.find((c) => c.name === 'Zuno');
    const zunoNames = (zuno?.children ?? []).map((c) => `${c.type}:${c.name}`);
    expect(zunoNames).toEqual(['folder:decisiones', 'note:a.md']);
  });

  it('scopes the tree to a subpath', async () => {
    await notes.create(USER, 'Zuno/decisiones/a.md', '# A');
    await notes.create(USER, 'Zuno/decisiones/b.md', '# B');
    await notes.create(USER, 'BRUTUS/x.md', '# X');

    const tree = await notes.listTree(USER, 'Zuno');
    expect(tree.name).toBe('Zuno');
    const names = (tree.children ?? []).flatMap((c) =>
      c.type === 'folder' ? (c.children ?? []).map((g) => g.name) : [c.name],
    );
    expect(names.sort()).toEqual(['a.md', 'b.md']);
  });
});

describe('NoteService.listDecisions', () => {
  it('returns notes tagged decisión OR with status=decidido, deduped', async () => {
    await notes.create(USER, 'Zuno/d1.md', '# D1', {
      created: '2026-05-15',
      tags: ['decisión', 'proyecto/zuno'],
    });
    await notes.create(USER, 'Zuno/d2.md', '# D2', {
      created: '2026-05-15',
      tags: ['proyecto/zuno'],
      status: 'decidido',
    });
    await notes.create(USER, 'Zuno/d3.md', '# D3', {
      created: '2026-05-15',
      tags: ['decisión'],
      status: 'decidido',
    });
    await notes.create(USER, 'General/idea.md', '# Idea', {
      created: '2026-05-15',
      tags: ['idea'],
    });

    const all = notes.listDecisions(USER);
    expect(all.map((r) => r.path).sort()).toEqual([
      'Zuno/d1.md',
      'Zuno/d2.md',
      'Zuno/d3.md',
    ]);

    const scoped = notes.listDecisions(USER, { folder: 'Zuno' });
    expect(scoped.map((r) => r.path).sort()).toEqual([
      'Zuno/d1.md',
      'Zuno/d2.md',
      'Zuno/d3.md',
    ]);

    const otherFolder = notes.listDecisions(USER, { folder: 'BRUTUS' });
    expect(otherFolder).toEqual([]);
  });
});

describe('SearchService', () => {
  it('returns ranked hits with snippets', async () => {
    await notes.create(USER, 'Zuno/pricing.md', '# Pricing\nWe will use tiered pricing for Zuno.');
    await notes.create(USER, 'BRUTUS/specs.md', 'BRUTUS does not deal with pricing.');
    const hits = search.search(USER,'pricing');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('<mark>');
  });

  it('returns empty array for empty query', () => {
    expect(search.search(USER,'')).toEqual([]);
  });
});
