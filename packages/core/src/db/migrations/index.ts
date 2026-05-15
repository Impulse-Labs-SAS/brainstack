// Registry of migrations applied in order by `runMigrations`.
// Each entry is a `{ name, sql }` module; new migrations append here.

import * as m0001 from './0001_init.js';
import * as m0002 from './0002_auth.js';
import * as m0003 from './0003_drop_magic_link.js';

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [m0001, m0002, m0003];
