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

let root: string;
let bs: BrainStackDatabase;
let index: IndexService;
let notes: NoteService;
let search: SearchService;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'brain-svc-'));
  bs = openDatabase(':memory:');
  index = new IndexService({ root, db: bs, logger });
  notes = new NoteService({ root, db: bs, index });
  search = new SearchService(bs);
  await index.bootstrap();
});

afterEach(async () => {
  bs.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('NoteService', () => {
  it('creates, reads, updates, and deletes a note', async () => {
    const path = await notes.create('Zuno/note.md', '# Hello\nbody', {
      created: '2026-05-15',
      tags: ['zuno'],
    });
    expect(path).toBe('Zuno/note.md');

    const read = await notes.get(path);
    expect(read.body).toContain('# Hello');
    expect(read.frontmatter).toMatchObject({ created: '2026-05-15' });

    await notes.update(path, '# Hello\nbody updated');
    expect((await notes.get(path)).body).toContain('updated');

    await notes.remove(path);
    await expect(notes.get(path)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to create twice on the same path', async () => {
    await notes.create('dupe.md', 'x');
    await expect(notes.create('dupe.md', 'y')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('filters list by tag and folder', async () => {
    await notes.create('Zuno/a.md', '#zuno body');
    await notes.create('BRUTUS/b.md', '#brutus body');
    const zunoOnly = notes.list({ folder: 'Zuno' });
    expect(zunoOnly.map((r) => r.path)).toEqual(['Zuno/a.md']);
    const byTag = notes.list({ tag: 'brutus' });
    expect(byTag.map((r) => r.path)).toEqual(['BRUTUS/b.md']);
  });

  it('addToInbox saves under Inbox/ with a date-prefixed slug', async () => {
    const path = await notes.addToInbox('quick note', 'Pablo idea');
    expect(path.startsWith('Inbox/')).toBe(true);
    expect(path).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2}-pablo-idea\.md$/);
  });

  it('lists backlinks for a target path', async () => {
    await writeNote(root, 'a.md', '[[target]]');
    await writeNote(root, 'b.md', '[[target]] again');
    await writeNote(root, 'target.md', '# target');
    await index.bootstrap();
    const links = notes.listLinks('target.md');
    expect(links.map((l) => l.sourcePath).sort()).toEqual(['a.md', 'b.md']);
  });
});

describe('SearchService', () => {
  it('returns ranked hits with snippets', async () => {
    await notes.create('Zuno/pricing.md', '# Pricing\nWe will use tiered pricing for Zuno.');
    await notes.create('BRUTUS/specs.md', 'BRUTUS does not deal with pricing.');
    const hits = search.search('pricing');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('<mark>');
  });

  it('returns empty array for empty query', () => {
    expect(search.search('')).toEqual([]);
  });
});
