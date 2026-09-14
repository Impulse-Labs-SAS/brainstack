// Which driver a connection string gets.
//
// Getting this wrong fails quietly in one direction and loudly in the other: a
// self-hosted Postgres sent to the Neon HTTP driver cannot connect at all, and
// Neon sent to a TCP pool works — until a burst of cold serverless functions
// opens more connections than the database allows.

import { describe, expect, it } from 'vitest';

import { pgDriverFor } from './client.js';

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
