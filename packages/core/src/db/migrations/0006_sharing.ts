// Tablas de sharing: folder_shares (grants efectivos) y folder_share_invites
// (tokens pendientes de aceptar). Existen en ambos deployments; en self-host
// se ignoran. Ver docs/Sharing-design.md §4.2.

export const name = '0006_sharing';

export const sql = `
CREATE TABLE IF NOT EXISTS folder_shares (
  id                   TEXT PRIMARY KEY,
  folder_path          TEXT NOT NULL,
  owner_id             TEXT NOT NULL,
  shared_with_user_id  TEXT NOT NULL,
  granted_at           INTEGER NOT NULL,
  granted_by           TEXT NOT NULL,
  UNIQUE (folder_path, owner_id, shared_with_user_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folder_shares_target
  ON folder_shares (shared_with_user_id, folder_path);
CREATE INDEX IF NOT EXISTS idx_folder_shares_owner
  ON folder_shares (owner_id, folder_path);

CREATE TABLE IF NOT EXISTS folder_share_invites (
  id                    TEXT PRIMARY KEY,
  folder_path           TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  mode                  TEXT NOT NULL CHECK (mode IN ('email','link')),
  invitee_email         TEXT,
  token_hash            TEXT NOT NULL UNIQUE,
  expires_at            INTEGER NOT NULL,
  accepted_at           INTEGER,
  accepted_by_user_id   TEXT,
  revoked_at            INTEGER,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_folder_share_invites_owner
  ON folder_share_invites (owner_id, folder_path);
CREATE INDEX IF NOT EXISTS idx_folder_share_invites_email
  ON folder_share_invites (invitee_email);
`;
