// Importing a document through the tRPC procedure the web app calls: what a dry
// run reports, what a save writes, and that a vault the caller cannot write in
// stays shut.

import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildContext } from '../trpc/context.js';
import { appRouter } from '../trpc/router.js';
import { buildServices } from '../wiring.js';

import { createTestDatabase, type TestDatabase } from './testDb.js';
import type { User } from './AuthService.js';

const { users } = pgSchema;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  for (const id of ['alice', 'bob']) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@brain.test`, createdAt: Date.now(), updatedAt: 0 });
  }
});

const asUser = (id: string): User => ({
  id,
  email: `${id}@brain.test`,
  displayName: null,
  emailVerified: true,
  hasPassword: true,
  hasGoogle: false,
  hasTotp: false,
  createdAt: 0,
  lastLoginAt: null,
});

function callerFor(id: string) {
  const services = buildServices({
    db: database.db,
    logger: pino({ level: 'silent' }),
    publicOrigin: 'http://localhost:3000',
    authorizedEmails: new Set(),
  });
  return appRouter.createCaller(buildContext(services, { kind: 'user', user: asUser(id) }));
}

const longDocument = ['## Scope', 'orbit '.repeat(800), '## Terms', 'ledger '.repeat(800)].join(
  '\n\n',
);

describe('notes.importDocument', () => {
  it('reports what a dry run would create and writes nothing', async () => {
    const alice = callerFor('alice');
    const plan = await alice.notes.importDocument({
      fileName: 'Orbit.pdf',
      folder: '',
      markdown: longDocument,
      dryRun: true,
    });
    expect(plan.saved).toBe(false);
    expect(plan.entry).toBe('Documentos/Orbit/_Orbit.md');
    expect(plan.notes.map((n) => n.path)).toEqual([
      'Documentos/Orbit/Orbit 01 - Scope.md',
      'Documentos/Orbit/Orbit 02 - Terms.md',
      'Documentos/Orbit/_Orbit.md',
    ]);
    expect(await alice.notes.list()).toEqual([]);
  });

  it('writes the notes, searchable, with the file as their source', async () => {
    const alice = callerFor('alice');
    await alice.notes.importDocument({
      fileName: 'Orbit.pdf',
      folder: 'clients',
      markdown: longDocument,
    });

    const index = await alice.notes.get({ path: 'clients/Orbit/_Orbit.md' });
    expect(index.body).toContain('[[Orbit 01 - Scope]]');
    expect(index.frontmatter).toMatchObject({ source: 'Orbit.pdf' });
    const part = await alice.notes.get({ path: 'clients/Orbit/Orbit 02 - Terms.md' });
    expect(part.body).toContain('[[clients/Orbit/_Orbit]]');
    const hits = await alice.search.query({ query: 'ledger' });
    expect(hits.map((h: { path: string }) => h.path)).toContain(
      'clients/Orbit/Orbit 02 - Terms.md',
    );
  });

  it('never overwrites: a second import of the same file gets the next name', async () => {
    const alice = callerFor('alice');
    await alice.notes.importDocument({ fileName: 'Atlas.txt', folder: 'x', markdown: 'first' });
    const second = await alice.notes.importDocument({
      fileName: 'Atlas.txt',
      folder: 'x',
      markdown: 'second',
    });
    expect(second.entry).toBe('x/Atlas (2).md');
    expect((await alice.notes.get({ path: 'x/Atlas.md' })).body).toContain('first');
  });

  it('refuses a document with no text', async () => {
    await expect(
      callerFor('alice').notes.importDocument({
        fileName: 'scan.pdf',
        folder: '',
        markdown: '   ',
      }),
    ).rejects.toThrow(/no text/);
  });

  it('cannot write into a vault that shared nothing', async () => {
    await expect(
      callerFor('bob').notes.importDocument({
        fileName: 'Atlas.txt',
        folder: 'Privado',
        markdown: 'text',
        ownerId: 'alice',
        dryRun: true,
      }),
    ).rejects.toThrow(/no write access/);
  });
});
