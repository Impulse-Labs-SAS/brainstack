// Drizzle schema for the BrainStack sqlite cache.
// The filesystem is the source of truth; this schema is regenerable.

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

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
