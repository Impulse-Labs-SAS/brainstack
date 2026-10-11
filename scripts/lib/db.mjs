// The database, for the repair scripts, through the same driver selection as
// the server: Neon over HTTP for a Neon URL, node-postgres for everything
// else. The scripts used to import the Neon driver directly, which cannot
// reach any other Postgres — so they did nothing for a self-hosted instance.
//
// `sql` is a tagged template, as before; values become bound parameters, and
// an array becomes a parenthesised list (`id IN ${ids}`).

import { openPgDatabase } from '@brainstack/core/pg';
import { sql as drizzleSql } from 'drizzle-orm';

export function connect(connectionString) {
  const { db, close } = openPgDatabase(connectionString);
  const sql = async (strings, ...values) => {
    const result = await db.execute(drizzleSql(strings, ...values));
    return Array.isArray(result) ? result : result.rows;
  };
  return { sql, close };
}
