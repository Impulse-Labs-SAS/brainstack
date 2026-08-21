// Drizzle schema for the BrainStack Postgres store.
//
// This is the source of truth: `notes.body` holds the markdown exactly as
// written, with frontmatter split into its own jsonb column. `links` and `tags`
// are derived from the body on every write and are rebuildable from `notes`
// alone.

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

export const notes = pgTable('notes', {
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
   */
  ownerId: text('owner_id'),
});

export const links = pgTable(
  'links',
  {
    sourcePath: text('source_path').notNull(),
    targetPath: text('target_path').notNull(),
    targetType: text('target_type').notNull().$type<'note' | 'attachment' | 'unresolved'>(),
    linkKind: text('link_kind').notNull().$type<'wikilink' | 'embed' | 'markdown'>(),
    alias: text('alias'),
    section: text('section'),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourcePath, t.targetPath, t.position] }),
    targetIdx: index('idx_links_target').on(t.targetPath),
    sourceIdx: index('idx_links_source').on(t.sourcePath),
  }),
);

export const tags = pgTable(
  'tags',
  {
    notePath: text('note_path').notNull(),
    tag: text('tag').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.notePath, t.tag] }),
    tagIdx: index('idx_tags_tag').on(t.tag),
  }),
);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
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
});

/** Single-use, hashed, short-lived: the three properties every token here has. */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
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
    userId: text('user_id').notNull(),
    /** Stored alongside the user so changing an email re-verifies it. */
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
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
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull().unique(),
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
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => ({ userIdx: index('idx_sessions_user').on(t.userId) }),
);

export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  consumedAt: bigint('consumed_at', { mode: 'number' }),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    /**
     * Nullable only because migration 0001 shipped this table without it. Every
     * key issued through ApiKeyService has an owner; a null means a leftover row
     * from the spike, which belongs to nobody and is listed by nobody.
     */
    userId: text('user_id'),
    name: text('name').notNull(),
    /** First few chars of the token, shown in the UI to identify the key. */
    prefix: text('prefix').notNull(),
    /** sha256 of the full token. The plaintext is only ever shown once. */
    tokenHash: text('token_hash').notNull().unique(),
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
    ownerId: text('owner_id').notNull(),
    sharedWithUserId: text('shared_with_user_id').notNull(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
    grantedBy: text('granted_by').notNull(),
  },
  (t) => ({
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
    ownerId: text('owner_id').notNull(),
    mode: text('mode').notNull().$type<'email' | 'link'>(),
    /** Null when the invite is a link anyone holding it can accept. */
    inviteeEmail: text('invitee_email'),
    /** sha256 of the token. The plaintext only ever exists in the invite URL. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
    acceptedByUserId: text('accepted_by_user_id'),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    ownerIdx: index('idx_share_invites_owner').on(t.ownerId, t.folderPath),
    emailIdx: index('idx_share_invites_email').on(t.inviteeEmail),
  }),
);

/**
 * Text-search configurations used by the generated `body_tsv` column. Change
 * these in `migrations.ts` too — the column is generated, so the two must agree.
 *
 * `PREFIX_CONFIG` is unstemmed and carries prefix matching; `STEM_CONFIG` adds
 * morphology. See the comment on the migration for why both are indexed.
 */
export const PREFIX_CONFIG = 'simple';
export const STEM_CONFIG = 'spanish';
