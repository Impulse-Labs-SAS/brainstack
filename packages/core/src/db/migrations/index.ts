// Registry of migrations applied in order by `runMigrations`.
// Each entry is a `{ name, sql }` module; new migrations append here.

import * as m0001 from './0001_init.js';
import * as m0002 from './0002_auth.js';
import * as m0003 from './0003_drop_magic_link.js';
import * as m0004 from './0004_password_oauth_totp.js';
import * as m0005 from './0005_owner_id.js';

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005];
