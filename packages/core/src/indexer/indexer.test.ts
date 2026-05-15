import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type BrainStackDatabase } from '../db/client.js';
import { writeNote } from '../fs/notes.js';

import { bootstrapIndex, reindexFile, removeFromIndex } from './bootstrap.js';

let root: string;
let bs: BrainStackDatabase;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'brain-idx-'));
  bs = openDatabase(':memory:');
});

afterEach(async () => {
  bs.close();
  await fsp.rm(root, { recursive: true, force: true });
});

function countNotes(): number {
  const row = bs.sqlite.prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM notes').get();
  return row?.c ?? 0;
}

function linkRows() {
  return bs.sqlite
    .prepare<unknown[], { target_path: string; target_type: string; link_kind: string }>(
      'SELECT target_path, target_type, link_kind FROM links ORDER BY position',
    )
    .all();
}

describe('bootstrapIndex', () => {
  it('indexes every markdown file under root', async () => {
    await writeNote(
      root,
      'Zuno/note-a.md',
      '---\ntitle: A\ntags: [proyecto/zuno]\n---\n[[note-b]] body\n',
    );
    await writeNote(root, 'Zuno/note-b.md', '# B\nrefs [[note-a]] #other');

    const result = await bootstrapIndex(root, bs);
    expect(result.notesScanned).toBe(2);
    expect(result.notesIndexed).toBe(2);
    expect(countNotes()).toBe(2);

    const tags = bs.sqlite
      .prepare<unknown[], { tag: string }>('SELECT tag FROM tags ORDER BY tag')
      .all();
    expect(tags.map((t) => t.tag)).toEqual(['other', 'proyecto/zuno']);
  });

  it('resolves wikilinks to notes and marks unknowns as unresolved', async () => {
    await writeNote(root, 'Zuno/a.md', '[[Zuno/b]] and [[ghost]]');
    await writeNote(root, 'Zuno/b.md', '# B\n');

    await bootstrapIndex(root, bs);
    const rows = linkRows();
    expect(rows.find((r) => r.target_path === 'Zuno/b.md')?.target_type).toBe('note');
    expect(rows.find((r) => r.target_path === 'ghost.md')?.target_type).toBe('unresolved');
  });
});

describe('reindexFile idempotency', () => {
  it('skips work when checksum is unchanged', async () => {
    await writeNote(root, 'a.md', 'body');
    await bootstrapIndex(root, bs);

    const result = await reindexFile(root, bs, 'a.md');
    expect(result.skipped).toBe(true);
  });

  it('updates the note when content changes', async () => {
    await writeNote(root, 'a.md', 'body 1');
    await bootstrapIndex(root, bs);
    await writeNote(root, 'a.md', 'body 2');

    const result = await reindexFile(root, bs, 'a.md');
    expect(result.skipped).toBe(false);

    const row = bs.sqlite
      .prepare<[string], { body: string }>('SELECT body FROM notes WHERE path = ?')
      .get('a.md');
    expect(row?.body.trim()).toBe('body 2');
  });

  it('drops stale links and tags on update', async () => {
    await writeNote(root, 'src.md', '[[old]] #old-tag');
    await writeNote(root, 'old.md', 'old');
    await bootstrapIndex(root, bs);

    await writeNote(root, 'src.md', '[[old]] #new-tag');
    await reindexFile(root, bs, 'src.md');

    const tags = bs.sqlite
      .prepare<[string], { tag: string }>('SELECT tag FROM tags WHERE note_path = ?')
      .all('src.md');
    expect(tags.map((t) => t.tag)).toEqual(['new-tag']);
  });
});

describe('removeFromIndex', () => {
  it('removes the note row and its derived links/tags', async () => {
    await writeNote(root, 'src.md', '[[other]] #t');
    await writeNote(root, 'other.md', 'x');
    await bootstrapIndex(root, bs);

    removeFromIndex(bs, 'src.md');
    expect(countNotes()).toBe(1);
    const links = bs.sqlite
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM links WHERE source_path = ?',
      )
      .get('src.md');
    expect(links?.c).toBe(0);
  });
});
