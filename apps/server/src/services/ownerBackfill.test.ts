// Tests del backfill de owner_id.

import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { backfillOwnerId } from './OwnerBackfill.js';

const logger = pino({ level: 'silent' });

let bs: BrainStackDatabase;

function seedUser(id: string, email: string): void {
  bs.sqlite
    .prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, email, Date.now(), Date.now());
}

function seedNote(path: string, ownerId: string | null = null): void {
  bs.sqlite
    .prepare(
      `INSERT INTO notes (path, title, frontmatter, body, mtime, checksum, owner_id)
       VALUES (?, ?, '{}', ?, ?, ?, ?)`,
    )
    .run(path, path, `body of ${path}`, Date.now(), 'cs-' + path, ownerId);
}

beforeEach(() => {
  bs = openDatabase(':memory:');
});

afterEach(() => {
  bs.close();
});

describe('backfillOwnerId — self-host', () => {
  it('no hace nada si no hay nulls', () => {
    seedUser('u1', 'u1@x.com');
    seedNote('a.md', 'u1');
    const res = backfillOwnerId(bs, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });

  it('asigna NULLs al único user', () => {
    seedUser('u1', 'u1@x.com');
    seedNote('a.md');
    seedNote('b.md');
    seedNote('c.md', 'u1');
    const res = backfillOwnerId(bs, { deployment: 'self-host', logger });
    expect(res.notesUpdated).toBe(2);
    expect(res.skipped).toBe(false);
    const rows = bs.sqlite
      .prepare<unknown[], { path: string; owner_id: string | null }>(
        'SELECT path, owner_id FROM notes ORDER BY path',
      )
      .all();
    for (const r of rows) expect(r.owner_id).toBe('u1');
  });

  it('skip cuando no hay users (backfill diferido)', () => {
    seedNote('a.md');
    const res = backfillOwnerId(bs, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-users' });
  });

  it('skip cuando hay más de un user en self-host', () => {
    seedUser('u1', 'u1@x.com');
    seedUser('u2', 'u2@x.com');
    seedNote('a.md');
    const res = backfillOwnerId(bs, { deployment: 'self-host', logger });
    expect(res).toMatchObject({
      skipped: true,
      reason: 'multiple-users-in-self-host',
    });
  });

  it('es idempotente — segunda corrida no toca nada', () => {
    seedUser('u1', 'u1@x.com');
    seedNote('a.md');
    backfillOwnerId(bs, { deployment: 'self-host', logger });
    const res = backfillOwnerId(bs, { deployment: 'self-host', logger });
    expect(res).toMatchObject({ skipped: true, reason: 'no-nulls' });
  });
});

describe('backfillOwnerId — hosted', () => {
  it('nunca asigna en hosted (deja para fix manual)', () => {
    seedUser('u1', 'u1@x.com');
    seedNote('a.md');
    const res = backfillOwnerId(bs, { deployment: 'hosted', logger });
    expect(res).toMatchObject({ skipped: true });
    const owner = bs.sqlite
      .prepare<[string], { owner_id: string | null }>('SELECT owner_id FROM notes WHERE path=?')
      .get('a.md')!.owner_id;
    expect(owner).toBeNull();
  });
});
