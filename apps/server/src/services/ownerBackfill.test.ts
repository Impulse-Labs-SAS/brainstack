// Tests for the owner_id backfill.

import { pgSchema } from '@brainstack/core/pg';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { backfillOwnerId } from './OwnerBackfill.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { notes, users } = pgSchema;
const logger = pino({ level: 'silent' });

let database: TestDatabase;

async function seedUser(id: string, email: string): Promise<void> {
  await database.db.insert(users).values({ id, email, createdAt: Date.now(), updatedAt: 0 });
}

async function seedNote(path: string, ownerId: string | null = null): Promise<void> {
  await database.db.insert(notes).values({
    path,
    title: path,
    frontmatter: {},
    body: `body of ${path}`,
    checksum: `cs-${path}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerId,
  });
}

async function ownerOf(path: string): Promise<string | null> {
  const [row] = await database.db
    .select({ ownerId: notes.ownerId })
    .from(notes)
    .where(eq(notes.path, path))
    .limit(1);
  return row?.ownerId ?? null;
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

describe('backfillOwnerId in self-host', () => {
  it('does nothing when there are no nulls', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('a.md', 'u1');

    const res = await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });

  it('assigns unowned notes to the only user', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('a.md');
    await seedNote('b.md');
    await seedNote('c.md', 'u1');

    const res = await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    expect(res.notesUpdated).toBe(2);
    expect(res.skipped).toBe(false);

    for (const path of ['a.md', 'b.md', 'c.md']) {
      expect(await ownerOf(path)).toBe('u1');
    }
  });

  it('defers when there is no user yet', async () => {
    await seedNote('a.md');
    const res = await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-users' });
  });

  it('refuses to guess when self-host somehow has two users', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedUser('u2', 'u2@x.com');
    await seedNote('a.md');

    const res = await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'multiple-users-in-self-host' });
    expect(await ownerOf('a.md')).toBeNull();
  });

  it('is idempotent', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('a.md');

    await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    const res = await backfillOwnerId(database.db, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });
});

describe('backfillOwnerId in hosted', () => {
  // The sqlite line left these alone for an admin to sort out, because the
  // owner lived in a directory the database could not see. Here the stored path
  // starts with the owner, so an unowned row names its own owner.
  it('takes the owner from the path prefix', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md');

    const res = await backfillOwnerId(database.db, { deployment: 'hosted', logger });
    expect(res.notesUpdated).toBe(1);
    expect(await ownerOf('u1/a.md')).toBe('u1');
  });

  it('does nothing when every note already has an owner', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md', 'u1');

    const res = await backfillOwnerId(database.db, { deployment: 'hosted', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });
});
