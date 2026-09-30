// Folder names that carry LIKE's pattern characters.
//
// Every "everything under this folder" query is a `LIKE 'folder/%'`. Built from
// the raw path, a folder named `a_b` also matched `aXb` — `_` is any single
// character — so deleting, moving or sharing one reached into the other. These
// tests keep a neighbour next to each folder whose name the pattern would match.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CrossOwnerReader } from './CrossOwnerReader.js';
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
  for (const id of ['owner', 'viewer']) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@x.com`, createdAt: Date.now(), updatedAt: 0 });
  }
  notes = new NoteService({ db: database.db });
});

const paths = async (ownerId = 'owner'): Promise<string[]> =>
  (await notes.list(ownerId, {})).map((n) => n.path).sort();

const tagged = (body: string): string => `---\ntags: [shared-topic]\n---\n${body}`;

describe('a folder name with % or _ matches only itself', () => {
  it('deleting `a_b` leaves `aXb` intact', async () => {
    await notes.create('owner', 'a_b/gone.md', 'a');
    await notes.create('owner', 'aXb/kept.md', 'b');
    await notes.createFolder('owner', 'aXb/empty');

    await notes.remove('owner', 'a_b', { recursive: true });

    expect(await paths()).toEqual(['aXb/kept.md']);
    const tree = await notes.listTree('owner', 'aXb');
    expect(tree.children?.map((c) => c.name).sort()).toEqual(['empty', 'kept.md']);
  });

  it('moving `a%b` does not move `aZZb`', async () => {
    await notes.create('owner', 'a%b/moved.md', 'a');
    await notes.create('owner', 'aZZb/stays.md', 'b');

    await notes.move('owner', 'a%b', 'dest');

    expect(await paths()).toEqual(['aZZb/stays.md', 'dest/moved.md']);
  });

  it('moving `a_b` to another vault leaves `aXb` behind', async () => {
    await notes.create('owner', 'a_b/moved.md', 'a');
    await notes.create('owner', 'aXb/stays.md', 'b');

    await notes.moveAcrossVaults({
      fromOwnerId: 'owner',
      fromPath: 'a_b',
      toOwnerId: 'viewer',
      toPath: 'a_b',
    });

    expect(await paths('owner')).toEqual(['aXb/stays.md']);
    expect(await paths('viewer')).toEqual(['a_b/moved.md']);
  });

  it('a share on `a_b` does not surface `aXb` among related notes', async () => {
    await notes.create('owner', 'a_b/inside.md', tagged('in'));
    await notes.create('owner', 'aXb/outside.md', tagged('out'));
    await notes.create('viewer', 'mine.md', tagged('mine'));

    const related = await notes.listRelated('viewer', 'mine.md', {
      sharedScopes: [{ ownerId: 'owner', folderPath: 'a_b' }],
    });

    expect(related.map((r) => r.path)).toEqual(['a_b/inside.md']);
  });

  it('a share on `a_b` does not put `aXb` in the graph', async () => {
    await notes.create('owner', 'a_b/inside.md', 'in');
    await notes.create('owner', 'aXb/outside.md', 'out');

    const graph = await notes.graph('viewer', {
      sharedScopes: [{ ownerId: 'owner', folderPath: 'a_b' }],
    });

    expect(graph.nodes.map((n) => n.path)).toEqual(['a_b/inside.md']);
  });

  it('a shared tree of `a_b` does not list `aXb`', async () => {
    const sharing = new SharingService({ db: database.db });
    const reader = new CrossOwnerReader({ sharing, db: database.db });
    await notes.create('owner', 'a_b/inside.md', 'in');
    await notes.create('owner', 'aXb/outside.md', 'out');
    await sharing.grant({
      ownerId: 'owner',
      sharedWithUserId: 'viewer',
      folderPath: 'a_b',
      grantedBy: 'owner',
    });

    const tree = await reader.listTree('viewer', 'owner', 'a_b');

    expect(JSON.stringify(tree)).not.toContain('outside.md');
    expect(JSON.stringify(tree)).toContain('inside.md');
  });

  it('decisions filtered to `a_b` leave out `aXb`', async () => {
    const decision = (body: string): string => `---\ntags: [decision]\n---\n${body}`;
    await notes.create('owner', 'a_b/in.md', decision('in'));
    await notes.create('owner', 'aXb/out.md', decision('out'));

    const found = await notes.listDecisions('owner', { folder: 'a_b' });

    expect(found.map((d) => d.path)).toEqual(['a_b/in.md']);
  });
});
