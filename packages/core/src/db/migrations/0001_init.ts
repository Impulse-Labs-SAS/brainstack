// Initial schema for BrainStack sqlite cache.
// Includes FTS5 virtual table and triggers to keep it in sync with `notes`.

export const name = '0001_init';

export const sql = `
CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  body        TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  checksum    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  path        TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  duration_s  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('note', 'attachment', 'unresolved')),
  link_kind   TEXT NOT NULL CHECK (link_kind   IN ('wikilink', 'embed', 'markdown')),
  alias       TEXT,
  section     TEXT,
  position    INTEGER NOT NULL,
  PRIMARY KEY (source_path, target_path, position)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_path);
CREATE INDEX IF NOT EXISTS idx_links_source ON links (source_path);

CREATE TABLE IF NOT EXISTS tags (
  note_path TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (note_path, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags (tag);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, path, title, body)
  VALUES (new.rowid, new.path, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, path, title, body)
  VALUES ('delete', old.rowid, old.path, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, path, title, body)
  VALUES ('delete', old.rowid, old.path, old.title, old.body);
  INSERT INTO notes_fts (rowid, path, title, body)
  VALUES (new.rowid, new.path, new.title, new.body);
END;
`;
