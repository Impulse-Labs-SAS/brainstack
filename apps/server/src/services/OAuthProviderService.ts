// BrainStack as an OAuth 2.1 provider, so MCP hosts (claude.ai, Claude Code,
// Cursor) obtain their own tokens instead of asking the user to paste an API
// key. This service owns every credential decision; the HTTP layer above it
// only parses requests and renders responses.
//
// The shape follows the MCP authorization spec: PKCE (S256 only) proves the
// client that started the flow is the one finishing it, codes are single-use
// and short-lived, refresh rotates the whole pair. Secrets are stored as
// sha256 hashes, the same rule as api_keys.

import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { generateToken, sha256 } from '../lib/tokens.js';

const { oauthClients, oauthAuthorizationCodes, oauthTokens } = pgSchema;

/** Distinct from api keys (`bs_`), so a glance at a log says which kind leaked. */
export const OAUTH_ACCESS_PREFIX = 'bsoa_';
export const OAUTH_REFRESH_PREFIX = 'bsor_';

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

/** The only scope there is. Kept as a list of one so more can exist later. */
export const OAUTH_SCOPES = ['mcp'] as const;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  hasSecret: boolean;
}

export interface RegisteredClient extends OAuthClient {
  /** Plaintext secret. Present once, only for confidential clients. */
  secret?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface OAuthAccessGrant {
  userId: string;
  clientId: string;
  scopes: string[];
}

export interface OAuthProviderServiceOptions {
  db: PgDb;
  now?: () => number;
}

/**
 * What a client may register as a callback. Three shapes cover the MCP hosts:
 *
 *  - `https://…` for web clients (claude.ai).
 *  - loopback `http://` for native clients that catch the callback on a local
 *    port (Claude Code).
 *  - a private-use scheme like `cursor://…` for native clients that register a
 *    deep link instead (Cursor). Per RFC 8252 §7.1 these are legitimate; the OS
 *    owns which app answers the scheme, and our exact-match check at authorize
 *    time is what makes accepting them safe here.
 *
 * Plain `http://` to any non-loopback host is the one thing refused: that is a
 * token delivered in the clear to a named server.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1'
    );
  }
  // A private-use / custom scheme (cursor:, vscode:, …). Require an actual
  // scheme with something after it, and reject the schemes that would turn a
  // redirect into code execution or data exfiltration.
  const scheme = parsed.protocol.replace(/:$/, '');
  const dangerous = new Set(['javascript', 'data', 'vbscript', 'file', 'blob']);
  if (dangerous.has(scheme)) return false;
  return scheme.length > 0 && uri.length > parsed.protocol.length + 1;
}

/**
 * Keep only the scopes this server actually grants. An MCP host that asks for
 * more (or for something we do not know) gets the intersection rather than a
 * hard rejection — refusing outright breaks discovery for a client that was
 * being reasonable. Empty intersection falls back to the default scope.
 */
export function narrowScope(requested: string | undefined): string {
  if (!requested?.trim()) return OAUTH_SCOPES.join(' ');
  const kept = requested
    .trim()
    .split(/\s+/)
    .filter((s) => (OAUTH_SCOPES as readonly string[]).includes(s));
  return kept.length > 0 ? kept.join(' ') : OAUTH_SCOPES.join(' ');
}

/** BASE64URL(SHA256(verifier)) — the S256 transform from RFC 7636. */
export function pkceChallengeFrom(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class OAuthProviderService {
  constructor(private readonly opts: OAuthProviderServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Open registration (RFC 7591). The rate limiter above is the gate. */
  async registerClient(params: {
    name: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: string;
  }): Promise<RegisteredClient> {
    const method = params.tokenEndpointAuthMethod ?? 'none';
    const confidential = method !== 'none';
    const secret = confidential ? `bsoc_${generateToken(TOKEN_BYTES)}` : undefined;

    const id = nanoid();
    await this.opts.db.insert(oauthClients).values({
      id,
      secretHash: secret ? sha256(secret) : null,
      name: params.name,
      redirectUris: params.redirectUris,
      tokenEndpointAuthMethod: method,
      createdAt: this.now(),
    });

    return {
      id,
      name: params.name,
      redirectUris: params.redirectUris,
      tokenEndpointAuthMethod: method,
      hasSecret: confidential,
      ...(secret ? { secret } : {}),
    };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const [row] = await this.opts.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      redirectUris: row.redirectUris,
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
      hasSecret: row.secretHash !== null,
    };
  }

  /**
   * Check a client's secret. Public clients have nothing to check — they carry
   * PKCE instead — so a secret presented for one is an error, not a pass.
   */
  async verifyClientSecret(clientId: string, secret: string | undefined): Promise<boolean> {
    const [row] = await this.opts.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .limit(1);
    if (!row) return false;
    if (row.secretHash === null) return secret === undefined;
    if (!secret) return false;
    return row.secretHash === sha256(secret);
  }

  /** Issue an authorization code after the user consented. */
  async createAuthorizationCode(params: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource?: string;
  }): Promise<string> {
    const code = `bsac_${generateToken(TOKEN_BYTES)}`;
    const now = this.now();
    await this.opts.db.insert(oauthAuthorizationCodes).values({
      id: nanoid(),
      codeHash: sha256(code),
      clientId: params.clientId,
      userId: params.userId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope: params.scope,
      resource: params.resource ?? null,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    });
    return code;
  }

  /**
   * Trade a code for tokens. Every check that fails returns null and the
   * caller answers `invalid_grant` — OAuth deliberately says no more than that.
   *
   * Consuming is an UPDATE guarded on `consumed_at IS NULL`, so two exchanges
   * racing on the same code cannot both win.
   */
  async exchangeAuthorizationCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<IssuedTokens | null> {
    const now = this.now();
    const [row] = await this.opts.db
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthAuthorizationCodes.codeHash, sha256(params.code)),
          isNull(oauthAuthorizationCodes.consumedAt),
        ),
      )
      .returning();
    if (!row) return null;
    if (row.expiresAt < now) return null;
    if (row.clientId !== params.clientId) return null;
    if (row.redirectUri !== params.redirectUri) return null;
    if (pkceChallengeFrom(params.codeVerifier) !== row.codeChallenge) return null;

    // A fresh authorization begins a new token family.
    return this.issuePair({
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
      familyId: nanoid(),
    });
  }

  /**
   * Rotate: the presented refresh token and its access sibling die, a new pair
   * is born carrying the same family id.
   *
   * If the token is valid but already revoked, it is a replay — the canonical
   * signal of a stolen refresh token that was used once and is now being used
   * again. The honest client and the thief cannot both hold a live token, so
   * the safe move is to revoke the whole family and issue nothing; both sides
   * re-authorize, and the thief's descendants die with it.
   */
  async refresh(params: { refreshToken: string; clientId: string }): Promise<IssuedTokens | null> {
    const now = this.now();
    const tokenHash = sha256(params.refreshToken);

    const [row] = await this.opts.db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthTokens.tokenHash, tokenHash),
          eq(oauthTokens.kind, 'refresh'),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning();

    if (!row) {
      // Nothing live matched. If a revoked row carries this exact hash, the
      // token is being replayed after rotation — burn the family it belonged
      // to. (An entirely unknown hash matches nothing here and is a plain no.)
      const [revoked] = await this.opts.db
        .select({ familyId: oauthTokens.familyId })
        .from(oauthTokens)
        .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, 'refresh')))
        .limit(1);
      if (revoked) {
        await this.opts.db
          .update(oauthTokens)
          .set({ revokedAt: now })
          .where(and(eq(oauthTokens.familyId, revoked.familyId), isNull(oauthTokens.revokedAt)));
      }
      return null;
    }

    // Retire the access token issued alongside, whatever happens next.
    await this.opts.db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.pairId, row.pairId), isNull(oauthTokens.revokedAt)));

    if (row.expiresAt < now) return null;
    if (row.clientId !== params.clientId) return null;

    return this.issuePair({
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
      familyId: row.familyId,
    });
  }

  /**
   * Revoke a token (RFC 7009). Given an access or refresh token, the whole
   * family it belongs to is retired, so revoking either half kills the grant.
   * Silent on unknown tokens, exactly as the RFC requires.
   */
  async revokeToken(token: string): Promise<void> {
    const now = this.now();
    const [row] = await this.opts.db
      .select({ familyId: oauthTokens.familyId })
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenHash, sha256(token)))
      .limit(1);
    if (!row) return;
    await this.opts.db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.familyId, row.familyId), isNull(oauthTokens.revokedAt)));
  }

  /**
   * Resolve a bearer access token, stamping `last_used_at`. Null for unknown,
   * expired and revoked alike — same silence as ApiKeyService.validate.
   */
  async validateAccessToken(token: string): Promise<OAuthAccessGrant | null> {
    if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
    const now = this.now();
    const [row] = await this.opts.db
      .update(oauthTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthTokens.tokenHash, sha256(token)),
          eq(oauthTokens.kind, 'access'),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning();
    if (!row) return null;
    if (row.expiresAt < now) return null;
    return { userId: row.userId, clientId: row.clientId, scopes: row.scope.split(' ') };
  }

  private async issuePair(params: {
    clientId: string;
    userId: string;
    scope: string;
    familyId: string;
  }): Promise<IssuedTokens> {
    const accessToken = `${OAUTH_ACCESS_PREFIX}${generateToken(TOKEN_BYTES)}`;
    const refreshToken = `${OAUTH_REFRESH_PREFIX}${generateToken(TOKEN_BYTES)}`;
    const pairId = nanoid();
    const now = this.now();

    await this.opts.db.insert(oauthTokens).values([
      {
        id: nanoid(),
        kind: 'access' as const,
        tokenHash: sha256(accessToken),
        clientId: params.clientId,
        userId: params.userId,
        scope: params.scope,
        pairId,
        familyId: params.familyId,
        createdAt: now,
        expiresAt: now + ACCESS_TTL_MS,
      },
      {
        id: nanoid(),
        kind: 'refresh' as const,
        tokenHash: sha256(refreshToken),
        clientId: params.clientId,
        userId: params.userId,
        scope: params.scope,
        pairId,
        familyId: params.familyId,
        createdAt: now,
        expiresAt: now + REFRESH_TTL_MS,
      },
    ]);

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000),
      scope: params.scope,
    };
  }
}
