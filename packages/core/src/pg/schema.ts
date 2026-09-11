// Drizzle schema for the BrainStack Postgres store.
//
// This is the source of truth: `notes.body` holds the markdown exactly as
// written, with frontmatter split into its own jsonb column. `links` and `tags`
// are derived from the body on every write and are rebuildable from `notes`
// alone.
//
// It has to describe the database *completely*, not just the parts the queries
// read. Drizzle only needs column names and types to build SQL, so foreign
// keys, indexes and checks were omitted for a long time and nothing broke —
// but `drizzle-kit` diffs new migrations against this file, and what is not
// declared here reads as something to drop. `schema-parity.test.ts` applies
// this schema and `migrations.ts` to two empty databases and fails if the
// results differ.

import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Postgres' full-text type. Drizzle has no built-in for it, and the column is
 * generated anyway, so nothing ever writes this — it exists to be indexed and
 * matched against.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * Text-search configurations used by the generated `body_tsv` column.
 *
 * The vector indexes each note twice, and both halves earn their place:
 *
 *  - `simple` keeps words unstemmed, which is what makes prefix search work.
 *    FTS5 behaved this way, so `despleg` still finds "desplegamos".
 *  - `spanish` stores stems, so "notas" also finds "nota".
 *
 * Inlined as literals in the expression below because Postgres only accepts
 * `to_tsvector` in a generated column when the config is constant — that is
 * what makes it IMMUTABLE. Change them here and in `migrations.ts` together.
 */
export const PREFIX_CONFIG = 'simple';
export const STEM_CONFIG = 'spanish';

const bodyTsvExpression = sql`(
       setweight(to_tsvector('simple',  coalesce(title, '')), 'A') ||
       setweight(to_tsvector('spanish', coalesce(title, '')), 'A') ||
       setweight(to_tsvector('simple',  coalesce(body,  '')), 'B') ||
       setweight(to_tsvector('spanish', coalesce(body,  '')), 'B')
     )`;

export const notes = pgTable(
  'notes',
  {
    /** Posix path relative to the brain root, ending in `.md`. Primary key. */
    path: text('path').primaryKey(),
    title: text('title').notNull(),
    frontmatter: jsonb('frontmatter').notNull().$type<Record<string, unknown>>().default({}),
    body: text('body').notNull(),
    /** Epoch millis of the last write. Mirrors the old `mtime` column. */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** sha256 of the body, so writes stay idempotent like the watcher used to be. */
    checksum: text('checksum').notNull(),
    /**
     * Owning user. Nullable because the notes written before ownership existed
     * have no owner until OwnerBackfill claims them; a null note belongs to
     * nobody and is listed by nobody.
     *
     * No cascade: deleting a user must not silently take their notes with it.
     */
    ownerId: text('owner_id').references(() => users.id),
    /**
     * Maintained by Postgres from `title` and `body`. Never selected by name —
     * it is large, and pulling it over HTTP on every read would double the
     * payload for something only the index uses.
     */
    bodyTsv: tsvector('body_tsv').generatedAlwaysAs(bodyTsvExpression),
  },
  (t) => ({
    tsvIdx: index('idx_notes_tsv').using('gin', t.bodyTsv),
    updatedIdx: index('idx_notes_updated_at').on(desc(t.updatedAt)),
    ownerIdx: index('idx_notes_owner').on(t.ownerId),
  }),
);

export const links = pgTable(
  'links',
  {
    sourcePath: text('source_path')
      .notNull()
      .references(() => notes.path, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    targetType: text('target_type').notNull().$type<'note' | 'attachment' | 'unresolved'>(),
    linkKind: text('link_kind').notNull().$type<'wikilink' | 'embed' | 'markdown'>(),
    alias: text('alias'),
    section: text('section'),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'links_pkey', columns: [t.sourcePath, t.targetPath, t.position] }),
    targetIdx: index('idx_links_target').on(t.targetPath),
    sourceIdx: index('idx_links_source').on(t.sourcePath),
  }),
);

export const tags = pgTable(
  'tags',
  {
    notePath: text('note_path')
      .notNull()
      .references(() => notes.path, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'tags_pkey', columns: [t.notePath, t.tag] }),
    tagIdx: index('idx_tags_tag').on(t.tag),
  }),
);

/**
 * Generic `(key, value)` pairs lifted from frontmatter fields other than
 * `tags` — `technologies: [nextjs, drizzle]` yields two rows keyed
 * `technologies`. Nothing here is specific to any field name: whatever a
 * vault happens to use becomes browsable and, combined with `tags`, feeds
 * "related by shared tag or technology" without a schema to register first.
 */
export const facets = pgTable(
  'facets',
  {
    notePath: text('note_path')
      .notNull()
      .references(() => notes.path, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** The raw entry when it was an object (`{url, label}`), else null. */
    data: jsonb('data').$type<Record<string, unknown> | null>(),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'facets_pkey', columns: [t.notePath, t.key, t.position] }),
    keyValueIdx: index('idx_facets_key_value').on(t.key, t.value),
  }),
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique('users_email_key'),
    displayName: text('display_name'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastLoginAt: bigint('last_login_at', { mode: 'number' }),
    /** Until this is true the account exists but cannot sign in. */
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Null for an account that only ever signed in through Google. */
    passwordHash: text('password_hash'),
    googleId: text('google_id'),
    /** Null unless the user turned 2FA on. */
    totpSecret: text('totp_secret'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
  },
  (t) => ({
    emailIdx: index('idx_users_email').on(t.email),
    // Partial, so the many users without a Google account do not collide on null.
    googleIdx: uniqueIndex('idx_users_google_id')
      .on(t.googleId)
      .where(sql`google_id IS NOT NULL`),
  }),
);

/** Single-use, hashed, short-lived: the three properties every token here has. */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('password_reset_tokens_token_hash_key'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => ({ userIdx: index('idx_password_reset_user').on(t.userId) }),
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored alongside the user so changing an email re-verifies it. */
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique('email_verification_tokens_token_hash_key'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => ({ userIdx: index('idx_email_verification_user').on(t.userId) }),
);

/** The codes that get a user back in when they lose the authenticator. */
export const totpBackupCodes = pgTable(
  'totp_backup_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique('totp_backup_codes_code_hash_key'),
    usedAt: bigint('used_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({ userIdx: index('idx_totp_backup_user').on(t.userId) }),
);

/** In-flight OAuth handshakes, holding the PKCE verifier until Google returns. */
export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  redirectTo: text('redirect_to'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('sessions_token_hash_key'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => ({ userIdx: index('idx_sessions_user').on(t.userId) }),
);

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique('magic_link_tokens_token_hash_key'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    consumedAt: bigint('consumed_at', { mode: 'number' }),
  },
  (t) => ({ hashIdx: index('idx_magic_token_hash').on(t.tokenHash) }),
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    /**
     * Nullable only because migration 0001 shipped this table without it. Every
     * key issued through ApiKeyService has an owner; a null means a leftover row
     * from the spike, which belongs to nobody and is listed by nobody.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First few chars of the token, shown in the UI to identify the key. */
    prefix: text('prefix').notNull(),
    /** sha256 of the full token. The plaintext is only ever shown once. */
    tokenHash: text('token_hash').notNull().unique('api_keys_token_hash_key'),
    scopes: jsonb('scopes').notNull().$type<string[]>().default([]),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => ({
    hashIdx: index('idx_api_keys_hash').on(t.tokenHash),
    userIdx: index('idx_api_keys_user').on(t.userId),
  }),
);

/**
 * A folder that exists without anything in it yet.
 *
 * Folders with notes under them are implied by those paths and are not listed
 * here; the tree unions both sources.
 */
export const folders = pgTable(
  'folders',
  {
    /** Stored path, owner prefix included. No trailing slash. */
    path: text('path').primaryKey(),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({ ownerIdx: index('idx_folders_owner').on(t.ownerId) }),
);

/**
 * An effective grant: this folder, of this owner, is readable by this user.
 *
 * Keyed by folder rather than by note so a share keeps covering notes created
 * after it was granted. `granted_by` is almost always the owner, and is stored
 * anyway so an audit can tell who actually handed the access over.
 */
export const folderShares = pgTable(
  'folder_shares',
  {
    id: text('id').primaryKey(),
    /** Relative to the owner's root, no leading slash. */
    folderPath: text('folder_path').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sharedWithUserId: text('shared_with_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * What the grant allows: 'read' or 'write'.
     *
     * Defaulted rather than backfilled, because 'read' is what every grant
     * made before this column meant. A share that predates writing keeps
     * behaving exactly as it did.
     */
    permission: text('permission').notNull().default('read').$type<'read' | 'write'>(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
    grantedBy: text('granted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    permissionValues: check('folder_shares_permission_check', sql`permission IN ('read', 'write')`),
    /** Granting the same folder to the same person twice is one grant. */
    oneGrant: unique('folder_shares_folder_path_owner_id_shared_with_user_id_key').on(
      t.folderPath,
      t.ownerId,
      t.sharedWithUserId,
    ),
    targetIdx: index('idx_folder_shares_target').on(t.sharedWithUserId, t.folderPath),
    ownerIdx: index('idx_folder_shares_owner').on(t.ownerId, t.folderPath),
  }),
);

/** A share that has been offered but not yet accepted. */
export const folderShareInvites = pgTable(
  'folder_share_invites',
  {
    id: text('id').primaryKey(),
    folderPath: text('folder_path').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().$type<'email' | 'link'>(),
    /** Null when the invite is a link anyone holding it can accept. */
    inviteeEmail: text('invitee_email'),
    /**
     * What accepting will grant. Carried on the invite because the owner
     * chooses it when inviting, and acceptance can be days later.
     */
    permission: text('permission').notNull().default('read').$type<'read' | 'write'>(),
    /** sha256 of the token. The plaintext only ever exists in the invite URL. */
    tokenHash: text('token_hash').notNull().unique('folder_share_invites_token_hash_key'),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
    /** Cleared rather than cascaded: the invite is a record of what happened. */
    acceptedByUserId: text('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    modeValues: check('folder_share_invites_mode_check', sql`mode IN ('email', 'link')`),
    permissionValues: check(
      'folder_share_invites_permission_check',
      sql`permission IN ('read', 'write')`,
    ),
    ownerIdx: index('idx_share_invites_owner').on(t.ownerId, t.folderPath),
    emailIdx: index('idx_share_invites_email').on(t.inviteeEmail),
  }),
);

/**
 * OAuth clients that connect MCP hosts (claude.ai, Claude Code, Cursor) to the
 * API. Most register themselves (RFC 7591): the row is the registration.
 *
 * `secretHash` is null for public clients, which is what MCP hosts are — they
 * cannot keep a secret and prove themselves with PKCE instead.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  /** Null for public clients. sha256 of the secret otherwise, shown once. */
  secretHash: text('secret_hash'),
  name: text('name').notNull(),
  /** Exact-match allowlist. The authorize endpoint refuses anything else. */
  redirectUris: jsonb('redirect_uris').notNull().$type<string[]>().default([]),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** Single-use, hashed, ten minutes to live: an authorization code in flight. */
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull().unique('oauth_authorization_codes_code_hash_key'),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored at issuance and compared verbatim at exchange (OAuth 2.1). */
    redirectUri: text('redirect_uri').notNull(),
    /** S256 challenge. The verifier never reaches this table. */
    codeChallenge: text('code_challenge').notNull(),
    scope: text('scope').notNull(),
    /** RFC 8707 audience the client asked for, when it sent one. */
    resource: text('resource'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    consumedAt: bigint('consumed_at', { mode: 'number' }),
  },
  (t) => ({ userIdx: index('idx_oauth_codes_user').on(t.userId) }),
);

/**
 * Access and refresh tokens, one row each, linked by `pairId` so a refresh
 * rotation can retire both halves of the pair it replaces.
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<'access' | 'refresh'>(),
    tokenHash: text('token_hash').notNull().unique('oauth_tokens_token_hash_key'),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    /** Shared by the access/refresh pair issued together. */
    pairId: text('pair_id').notNull(),
    /**
     * Constant across every rotation descended from one authorization. When a
     * revoked refresh token is presented again — the signal of a stolen token
     * that was already used — the whole family is revoked at once.
     */
    familyId: text('family_id').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => ({
    kindValues: check('oauth_tokens_kind_check', sql`kind IN ('access', 'refresh')`),
    userIdx: index('idx_oauth_tokens_user').on(t.userId),
    pairIdx: index('idx_oauth_tokens_pair').on(t.pairId),
    familyIdx: index('idx_oauth_tokens_family').on(t.familyId),
  }),
);
