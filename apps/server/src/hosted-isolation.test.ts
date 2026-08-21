// Two users in one database, and what each of them can see.
//
// This is the suite that matters most for sharing: isolation here is the only
// thing between "Pablo's folder" and "everything Pablo wrote". It asserts the
// negative cases — that a listing, a tree, a search and a graph all stop at the
// owner's boundary — because those are the ones that fail quietly.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
