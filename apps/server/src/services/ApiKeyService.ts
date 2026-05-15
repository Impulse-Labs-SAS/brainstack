// API keys for MCP clients. Each key is shown to the user once at creation;
// only the sha256 hash and a short prefix are stored. Prefix lets us identify
// keys in audit logs without leaking the secret.

import type { BrainStackDatabase } from '@brainstack/core';
import { nanoid } from 'nanoid';

import { AppError } from '../lib/errors.js';
import { generateToken, sha256 } from '../lib/tokens.js';

export interface ApiKeyServiceOptions {
  db: BrainStackDatabase;
  now?: () => number;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreatedApiKey extends ApiKey {
  /** Plaintext token. Shown once. */
  token: string;
}

export const API_KEY_PREFIX = 'bs_';
const TOKEN_BYTES = 32;
const PREFIX_VISIBLE_CHARS = 6;

export class ApiKeyService {
  constructor(private readonly opts: ApiKeyServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  create(userId: string, name: string, scopes: string[] = []): CreatedApiKey {
    const random = generateToken(TOKEN_BYTES);
    const token = `${API_KEY_PREFIX}${random}`;
    const prefix = token.slice(0, API_KEY_PREFIX.length + PREFIX_VISIBLE_CHARS);
    const id = nanoid();
    const createdAt = this.now();

    this.opts.db.sqlite
      .prepare(
        `INSERT INTO api_keys (id, user_id, name, prefix, token_hash, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, name, prefix, sha256(token), JSON.stringify(scopes), createdAt);

    return {
      id,
      userId,
      name,
      prefix,
      scopes,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
      token,
    };
  }

  validate(token: string): ApiKey | null {
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    const hash = sha256(token);
    const row = this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        user_id: string;
        name: string;
        prefix: string;
        scopes: string;
        created_at: number;
        last_used_at: number | null;
        revoked_at: number | null;
      }>(
        `SELECT id, user_id, name, prefix, scopes, created_at, last_used_at, revoked_at
         FROM api_keys WHERE token_hash = ?`,
      )
      .get(hash);
    if (!row || row.revoked_at != null) return null;

    const now = this.now();
    this.opts.db.sqlite
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(now, row.id);

    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      prefix: row.prefix,
      scopes: JSON.parse(row.scopes) as string[],
      createdAt: row.created_at,
      lastUsedAt: now,
      revokedAt: null,
    };
  }

  revoke(id: string): void {
    const now = this.now();
    const result = this.opts.db.sqlite
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id);
    if (result.changes === 0) {
      throw new AppError('api key not found or already revoked', 'NOT_FOUND', 404);
    }
  }

  list(userId: string): ApiKey[] {
    return this.opts.db.sqlite
      .prepare<[string], {
        id: string;
        user_id: string;
        name: string;
        prefix: string;
        scopes: string;
        created_at: number;
        last_used_at: number | null;
        revoked_at: number | null;
      }>(
        `SELECT id, user_id, name, prefix, scopes, created_at, last_used_at, revoked_at
         FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId)
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        prefix: row.prefix,
        scopes: JSON.parse(row.scopes) as string[],
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      }));
  }
}
