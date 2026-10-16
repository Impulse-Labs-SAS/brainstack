// Which driver a connection string gets.
//
// Getting this wrong fails quietly in one direction and loudly in the other: a
// self-hosted Postgres sent to the Neon HTTP driver cannot connect at all, and
// Neon sent to a TCP pool works — until a burst of cold serverless functions
// opens more connections than the database allows.

import { describe, expect, it } from 'vitest';

import { pgDriverFor, runStatements, type PgDb, type PgStatement } from './client.js';

describe('runStatements', () => {
  // Stand-ins for built statements: each records when it is run.
  const ran: string[] = [];
  const statement = (name: string) =>
    ({
      then: (resolve: (v: unknown) => void) => {
        ran.push(name);
        resolve(undefined);
      },
    }) as unknown as PgStatement;

  it('sends every statement in one batch, in order, where the driver has one (Neon HTTP)', async () => {
    const batches: unknown[][] = [];
    const db = { batch: async (items: unknown[]) => void batches.push(items) } as unknown as PgDb;
    const a = statement('a');
    const b = statement('b');
    const c = statement('c');
    await runStatements(db, [[a, b], [c]]);
    expect(batches).toEqual([[a, b, c]]);
  });

  it('runs each group in order elsewhere, and sends nothing for no statements', async () => {
    ran.length = 0;
    const db = {} as PgDb;
    await runStatements(db, [[statement('delete links'), statement('insert links')], []]);
    expect(ran).toEqual(['delete links', 'insert links']);
    await runStatements(db, [[], []]);
    expect(ran).toHaveLength(2);
  });
});

describe('pgDriverFor', () => {
  it('sends Neon over HTTP', () => {
    expect(
      pgDriverFor(
        'postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require',
      ),
    ).toBe('neon-http');
    expect(pgDriverFor('postgres://u:p@ep-x-pooler.eastus2.azure.neon.tech/db')).toBe('neon-http');
  });

  it('sends every other Postgres over node-postgres', () => {
    expect(pgDriverFor('postgres://brainstack:secret@postgres:5432/brainstack')).toBe(
      'node-postgres',
    );
    expect(pgDriverFor('postgresql://u:p@localhost/db')).toBe('node-postgres');
    expect(pgDriverFor('postgres://u:p@db.abcdefgh.supabase.co:5432/postgres')).toBe(
      'node-postgres',
    );
  });

  it('matches the hostname, not the string', () => {
    // A database name, a user or a lookalike domain is not Neon.
    expect(pgDriverFor('postgres://neon.tech:p@localhost/neon.tech')).toBe('node-postgres');
    expect(pgDriverFor('postgres://u:p@neon.tech.example.com/db')).toBe('node-postgres');
    expect(pgDriverFor('postgres://u:p@notneon.tech/db')).toBe('node-postgres');
  });

  it('leaves what URL cannot parse to node-postgres', () => {
    expect(pgDriverFor('host=localhost dbname=brainstack')).toBe('node-postgres');
  });
});
