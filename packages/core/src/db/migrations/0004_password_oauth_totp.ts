// Extends the auth schema for email + password, Google OAuth and optional
// TOTP 2FA. Adds:
//   - users.email_verified, users.password_hash, users.google_id,
//     users.totp_secret, users.updated_at
//   - password_reset_tokens, email_verification_tokens (hashed tokens, TTL,
//     single-use via used_at)
//   - totp_backup_codes (sha256 hashes, single-use)

export const name = '0004_password_oauth_totp';

export const sql = `
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN google_id TEXT;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id)
  WHERE google_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens (token_hash);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens (token_hash);

CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes (user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
`;
