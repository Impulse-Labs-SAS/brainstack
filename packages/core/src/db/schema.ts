// Drizzle schema for the BrainStack sqlite cache.
// The filesystem is the source of truth; this schema is regenerable.
// Auth tables (users, sessions, api_keys) live in the same database for V1
// simplicity.

import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  path: text('path').primaryKey(),
  title: text('title').notNull(),
  frontmatter: text('frontmatter', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  body: text('body').notNull(),
  mtime: integer('mtime').notNull(),
  checksum: text('checksum').notNull(),
});

export const attachments = sqliteTable('attachments', {
  path: text('path').primaryKey(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationS: integer('duration_s'),
  createdAt: integer('created_at').notNull(),
});

export const links = sqliteTable(
  'links',
  {
    sourcePath: text('source_path').notNull(),
    targetPath: text('target_path').notNull(),
    targetType: text('target_type', { enum: ['note', 'attachment', 'unresolved'] }).notNull(),
    linkKind: text('link_kind', { enum: ['wikilink', 'embed', 'markdown'] }).notNull(),
    alias: text('alias'),
    section: text('section'),
    position: integer('position').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sourcePath, table.targetPath, table.position] }),
  }),
);

export const tags = sqliteTable(
  'tags',
  {
    notePath: text('note_path').notNull(),
    tag: text('tag').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.notePath, table.tag] }),
  }),
);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => ({ userIdx: index('idx_sessions_user').on(t.userId) }),
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => ({ userIdx: index('idx_api_keys_user').on(t.userId) }),
);
