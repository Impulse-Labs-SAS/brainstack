// Postgres migrations for the BrainStack store.
//
// Same contract as the sqlite ones: ordered and recorded in
// `_brainstack_migrations`. Declared as a list of individual statements rather
// than one blob because the Neon HTTP driver runs a single statement per round
// trip. Every statement is `IF NOT EXISTS`, so a partially applied migration is
// safe to re-run — which is what stands in for the transaction we cannot open
// over HTTP.

export interface PgMigration {
  name: string;
  statements: readonly string[];
}

/**
 * The search vector indexes each note twice, and both halves earn their place:
 *
 *  - `simple` keeps words unstemmed, which is what makes prefix search work.
 *    FTS5 behaved this way, so `despleg` still finds "desplegamos".
 *  - `spanish` stores stems, so "notas" also finds "nota".
 *
 * Querying the union of both gives prefix matching *and* morphology. Configs are
 * inlined as literals because Postgres only accepts `to_tsvector` in a generated
 * column when the config is constant — that is what makes it IMMUTABLE.
 */
const init: PgMigration = {
  name: '0001_pg_init',
  statements: [
    `CREATE TABLE IF NOT EXISTS notes (
       path         TEXT PRIMARY KEY,
       title        TEXT NOT NULL,
       frontmatter  JSONB NOT NULL DEFAULT '{}'::jsonb,
       body         TEXT NOT NULL,
       updated_at   BIGINT NOT NULL,
       created_at   BIGINT NOT NULL,
       checksum     TEXT NOT NULL,
       body_tsv     tsvector GENERATED ALWAYS AS (
         setweight(to_tsvector('simple',  coalesce(title, '')), 'A') ||
         setweight(to_tsvector('spanish', coalesce(title, '')), 'A') ||
         setweight(to_tsvector('simple',  coalesce(body,  '')), 'B') ||
         setweight(to_tsvector('spanish', coalesce(body,  '')), 'B')
       ) STORED
     )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_tsv ON notes USING GIN (body_tsv)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes (updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS api_keys (
       id           TEXT PRIMARY KEY,
       name         TEXT NOT NULL,
       prefix       TEXT NOT NULL,
       token_hash   TEXT NOT NULL UNIQUE,
       created_at   BIGINT NOT NULL,
       last_used_at BIGINT,
       revoked_at   BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (token_hash)`,
  ],
};

/**
 * Added after the spike. Kept as a separate migration rather than folded into
 * 0001 so a database that already ran the spike migrates forward instead of
 * silently missing these tables.
 */
const graphAndAuth: PgMigration = {
  name: '0002_pg_graph_auth',
  statements: [
    `CREATE TABLE IF NOT EXISTS links (
       source_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
       target_path TEXT NOT NULL,
       target_type TEXT NOT NULL,
       link_kind   TEXT NOT NULL,
       alias       TEXT,
       section     TEXT,
       position    INTEGER NOT NULL,
       PRIMARY KEY (source_path, target_path, position)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_path)`,
    `CREATE INDEX IF NOT EXISTS idx_links_source ON links (source_path)`,

    `CREATE TABLE IF NOT EXISTS tags (
       note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
       tag       TEXT NOT NULL,
       PRIMARY KEY (note_path, tag)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags (tag)`,

    `CREATE TABLE IF NOT EXISTS users (
       id            TEXT PRIMARY KEY,
       email         TEXT NOT NULL UNIQUE,
       display_name  TEXT,
       created_at    BIGINT NOT NULL,
       last_login_at BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,

    `CREATE TABLE IF NOT EXISTS sessions (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL UNIQUE,
       created_at BIGINT NOT NULL,
       expires_at BIGINT NOT NULL,
       user_agent TEXT,
       ip_address TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,

    `CREATE TABLE IF NOT EXISTS magic_link_tokens (
       id          TEXT PRIMARY KEY,
       email       TEXT NOT NULL,
       token_hash  TEXT NOT NULL UNIQUE,
       created_at  BIGINT NOT NULL,
       expires_at  BIGINT NOT NULL,
       consumed_at BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_magic_token_hash ON magic_link_tokens (token_hash)`,

    // 0001 shipped api_keys without an owner or scopes. Both are nullable/defaulted
    // so an already-migrated spike database takes this without a backfill.
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`,
  ],
};

/**
 * Ownership and folder sharing, ported from the May line (see
 * `rescate/mayo-tree-sharing`, docs/Sharing-design.md §4).
 *
 * `owner_id` is nullable because the notes already in the database predate it;
 * OwnerBackfill assigns them on boot. `links` and `tags` deliberately do not
 * carry it — they inherit the owner of their note through a join, so there is
 * one place where ownership can be wrong instead of three.
 *
 * The May migration also added `owner_id` to `attachments`. That table does not
 * exist here: binaries do not belong in Postgres, and Netlify Blobs is not
 * wired up yet.
 */
const ownerAndSharing: PgMigration = {
  name: '0003_pg_owner_sharing',
  statements: [
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id)`,

    `CREATE TABLE IF NOT EXISTS folder_shares (
       id                  TEXT PRIMARY KEY,
       folder_path         TEXT NOT NULL,
       owner_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       shared_with_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       granted_at          BIGINT NOT NULL,
       granted_by          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       UNIQUE (folder_path, owner_id, shared_with_user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_folder_shares_target
       ON folder_shares (shared_with_user_id, folder_path)`,
    `CREATE INDEX IF NOT EXISTS idx_folder_shares_owner
       ON folder_shares (owner_id, folder_path)`,

    `CREATE TABLE IF NOT EXISTS folder_share_invites (
       id                  TEXT PRIMARY KEY,
       folder_path         TEXT NOT NULL,
       owner_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       mode                TEXT NOT NULL CHECK (mode IN ('email', 'link')),
       invitee_email       TEXT,
       token_hash          TEXT NOT NULL UNIQUE,
       expires_at          BIGINT NOT NULL,
       accepted_at         BIGINT,
       accepted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
       revoked_at          BIGINT,
       created_at          BIGINT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_share_invites_owner
       ON folder_share_invites (owner_id, folder_path)`,
    `CREATE INDEX IF NOT EXISTS idx_share_invites_email
       ON folder_share_invites (invitee_email)`,
  ],
};

/**
 * Email + password, Google OAuth and optional TOTP, ported from the May line
 * (migration 0004_password_oauth_totp).
 *
 * `email_verified` becomes a real BOOLEAN rather than the 0/1 integer sqlite
 * forced, and every timestamp is BIGINT epoch millis like the rest of this
 * schema.
 *
 * `magic_link_tokens` is deliberately left standing. The May line dropped it
 * when it replaced magic links with passwords, but the rows in it belong to
 * sessions handed out by the Netlify line, and dropping a table is not
 * something a migration should do on the way past.
 */
const fullAuth: PgMigration = {
  name: '0004_pg_auth_full',
  statements: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0`,
    // Partial, so the many users without a Google account do not collide on null.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id)
       WHERE google_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL UNIQUE,
       created_at BIGINT NOT NULL,
       expires_at BIGINT NOT NULL,
       used_at    BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id)`,

    `CREATE TABLE IF NOT EXISTS email_verification_tokens (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       email      TEXT NOT NULL,
       token_hash TEXT NOT NULL UNIQUE,
       created_at BIGINT NOT NULL,
       expires_at BIGINT NOT NULL,
       used_at    BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_email_verification_user
       ON email_verification_tokens (user_id)`,

    `CREATE TABLE IF NOT EXISTS totp_backup_codes (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       code_hash  TEXT NOT NULL UNIQUE,
       used_at    BIGINT,
       created_at BIGINT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes (user_id)`,

    `CREATE TABLE IF NOT EXISTS oauth_states (
       state         TEXT PRIMARY KEY,
       code_verifier TEXT NOT NULL,
       redirect_to   TEXT,
       created_at    BIGINT NOT NULL,
       expires_at    BIGINT NOT NULL
     )`,
  ],
};

export const pgMigrations: readonly PgMigration[] = [
  init,
  graphAndAuth,
  ownerAndSharing,
  fullAuth,
];
