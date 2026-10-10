// Which graph nodes record a decision.
//
// The graph's Sentinel view lights a decision as one, so `graph` says which
// notes are: the same test the decisions list and `gather_context`'s digests
// apply — a `decisión`/`decision` tag, or `status: decidido` — with the same
// scope rules as every other read of a shared folder: a share's notes count
// exactly when the viewer can see them, matched in memory, never by `LIKE`.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteService } from './NoteService.js';
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

/** Each node the graph shows the viewer, by logical path: whether it records a decision. */
async function decisions(
  viewerId: string,
  sharedScopes: Array<{ ownerId: string; folderPath: string }> = [],
): Promise<Record<string, boolean>> {
  const graph = await notes.graph(viewerId, { sharedScopes });
  return Object.fromEntries(graph.nodes.map((n) => [n.path, n.isDecision]));
}

describe('NoteService.graph isDecision', () => {
  it('marks a note tagged `decisión`', async () => {
    await notes.create('owner', 'Orbit/launch.md', '# Launch', { tags: ['decisión'] });
    expect(await decisions('owner')).toEqual({ 'Orbit/launch.md': true });
  });

  it('marks a note tagged `decision`', async () => {
    await notes.create('owner', 'Orbit/launch.md', '# Launch', { tags: ['decision'] });
    expect(await decisions('owner')).toEqual({ 'Orbit/launch.md': true });
  });

  it('marks a note with status: decidido and no tag at all', async () => {
    await notes.create('owner', 'Orbit/launch.md', '# Launch', { status: 'decidido' });
    expect(await decisions('owner')).toEqual({ 'Orbit/launch.md': true });
  });

  it('leaves a note with neither signal unmarked', async () => {
    await notes.create('owner', 'Orbit/draft.md', '# Draft', {
      tags: ['ledger', 'proyecto/orbit'],
      status: 'abierto',
    });
    await notes.create('owner', 'Orbit/plain.md', '# Plain');
    expect(await decisions('owner')).toEqual({
      'Orbit/draft.md': false,
      'Orbit/plain.md': false,
    });
  });

  it('shows a note carrying both signals once, marked', async () => {
    await notes.create('owner', 'Orbit/both.md', '# Both', {
      tags: ['decisión', 'decision'],
      status: 'decidido',
    });
    const graph = await notes.graph('owner');
    expect(graph.nodes.map((n) => [n.path, n.isDecision])).toEqual([['Orbit/both.md', true]]);
  });

  it("marks a decision in a folder shared with the viewer, and shows none from the owner's private ones", async () => {
    await notes.create('owner', 'shared/atlas.md', '# Atlas', { tags: ['decisión'] });
    await notes.create('owner', 'shared/erebor.md', '# Erebor');
    await notes.create('owner', 'private/ledger.md', '# Ledger', { status: 'decidido' });
    await notes.create('viewer', 'mine.md', '# Mine', { tags: ['decision'] });

    expect(await decisions('viewer', [{ ownerId: 'owner', folderPath: 'shared' }])).toEqual({
      'mine.md': true,
      'shared/atlas.md': true,
      'shared/erebor.md': false,
    });
  });

  it('never brings in a decision under `aXb` through a share of `a_b`', async () => {
    await notes.create('owner', 'a_b/inside.md', '# In', { tags: ['decisión'] });
    await notes.create('owner', 'aXb/outside.md', '# Out', { tags: ['decisión'] });
    await notes.create('owner', 'aXb/status.md', '# Out', { status: 'decidido' });

    expect(await decisions('viewer', [{ ownerId: 'owner', folderPath: 'a_b' }])).toEqual({
      'a_b/inside.md': true,
    });
  });
});
