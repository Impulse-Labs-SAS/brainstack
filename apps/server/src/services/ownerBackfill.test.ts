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

describe('backfillOwnerId', () => {
  // The sqlite line left these alone for an admin to sort out, because the
  // owner lived in a directory the database could not see. Here the stored path
  // starts with the owner, so an unowned row names its own owner.
  it('takes the owner from the path prefix', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md');

    const res = await backfillOwnerId(database.db, { logger });
    expect(res.notesUpdated).toBe(1);
    expect(await ownerOf('u1/a.md')).toBe('u1');
  });

  it('does nothing when every note already has an owner', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md', 'u1');

    const res = await backfillOwnerId(database.db, { logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });

  it('is idempotent', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md');

    await backfillOwnerId(database.db, { logger });
    const res = await backfillOwnerId(database.db, { logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls', unattributed: 0 });
  });

  // An unprefixed path names no account. Claiming it would break the foreign
  // key and fail the boot; guessing would hand it to the wrong person.
  it('leaves a note whose first segment is not a user alone, and reports it', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('u1/a.md');
    await seedNote('Inbox/orphan.md');

    const errors: unknown[] = [];
    const spy = pino({ level: 'error' }, { write: (line: string) => errors.push(JSON.parse(line)) });

    const res = await backfillOwnerId(database.db, { logger: spy });
    expect(res.notesUpdated).toBe(1);
    expect(res.unattributed).toBe(1);
    expect(await ownerOf('u1/a.md')).toBe('u1');
    expect(await ownerOf('Inbox/orphan.md')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ count: 1, sample: ['Inbox/orphan.md'] });
  });

  it('reports a note whose owner does not match its path', async () => {
    await seedUser('u1', 'u1@x.com');
    await seedNote('a.md', 'u1');

    const res = await backfillOwnerId(database.db, { logger });
    expect(res).toMatchObject({ skipped: true, unattributed: 1 });
  });
});
