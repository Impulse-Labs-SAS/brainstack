// API keys for MCP clients, backed by Postgres.
//
// Each key is shown to the user once at creation; only the sha256 hash and a
// short prefix are stored. The prefix lets us identify keys in audit logs and
// in the UI without ever holding the secret.

import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';
import { generateToken, LAST_USED_RESOLUTION_MS, sha256 } from '../lib/tokens.js';
import type { EmitEvent } from './events.js';

const { apiKeys } = pgSchema;

export interface ApiKeyServiceOptions {
  db: PgDb;
  now?: () => number;
  /** Told about what this service changes. See `events.ts`. */
  emit?: EmitEvent;
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

  async create(userId: string, name: string, scopes: string[] = []): Promise<CreatedApiKey> {
    const random = generateToken(TOKEN_BYTES);
    const token = `${API_KEY_PREFIX}${random}`;
    const prefix = token.slice(0, API_KEY_PREFIX.length + PREFIX_VISIBLE_CHARS);
    const id = nanoid();
    const createdAt = this.now();

    await this.opts.db.insert(apiKeys).values({
      id,
      userId,
      name,
      prefix,
      tokenHash: sha256(token),
      scopes,
      createdAt,
    });
    await this.opts.emit?.({ type: 'api_key.created', userId, keyId: id, name, scopes });

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

  /**
   * Resolve a bearer token to its key, stamping `last_used_at` (at most once
   * per `LAST_USED_RESOLUTION_MS`).
   *
   * Returns null for unknown, malformed and revoked tokens alike — callers get
   * no signal about which, by design.
   */
  async validate(token: string): Promise<ApiKey | null> {
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    return this.validateByHash(sha256(token));
  }

  /**
   * Same as `validate`, for callers that already hashed the token. The MCP
   * endpoint uses this so the plaintext never travels further than it must.
   */
  async validateByHash(tokenHash: string): Promise<ApiKey | null> {
    const now = this.now();
    // A read, not a stamp-and-fetch: the revoked filter is what keeps a
    // revoked key out, and a key revoked a moment after this read is the same
    // as one revoked a moment after the request.
    const [row] = await this.opts.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (!row || row.userId === null) return null;
    const stale = row.lastUsedAt === null || Number(row.lastUsedAt) <= now - LAST_USED_RESOLUTION_MS;
    if (!stale) return toApiKey({ ...row, userId: row.userId });

    // Guarded on the stamp, so concurrent requests write it once.
    await this.opts.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, row.id),
          or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, now - LAST_USED_RESOLUTION_MS)),
        ),
      );
    return toApiKey({ ...row, lastUsedAt: now, userId: row.userId });
  }

  /**
   * Delete a key outright.
   *
   * It used to be marked revoked and kept, which left a list of struck-through
   * rows that say nothing anyone acts on. The key is gone the moment the row
   * is: `validate` finds nothing to match against.
   *
   * `userId` is required. It used to be optional, and the one caller that left
   * it out — a REST route, since removed — deleted keys by id alone: any
   * signed-in user could retire anyone else's key, given its id.
   */
  async revoke(id: string, userId: string): Promise<void> {
    const revoked = await this.opts.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });

    if (revoked.length === 0) {
      throw new AppError('api key not found', 'NOT_FOUND', 404);
    }
  }

  async list(userId: string): Promise<ApiKey[]> {
    const rows = await this.opts.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));

    return rows.map((row) => toApiKey({ ...row, userId }));
  }
}

function toApiKey(row: {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}): ApiKey {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes ?? [],
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : Number(row.lastUsedAt),
    revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  };
}
