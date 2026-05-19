// Adds owner_id (nullable, indexed) to notes and attachments to enable
// multi-tenant support in the hosted deployment. Self-host treats it as
// implicit single-user and a runtime backfill assigns the unique user.
// See docs/Sharing-design.md.

export const name = '0005_owner_id';

export const sql = `
ALTER TABLE notes ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE attachments ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_id);
`;
