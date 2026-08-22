// Auth middleware. Resolves the caller as either a logged-in user (session
// cookie) or an MCP client (Bearer API key). Attaches the principal to
// `c.var` so downstream handlers don't repeat the work.

import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

import type { ApiKey, ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService, User } from '../../services/AuthService.js';
import type { OAuthProviderService } from '../../services/OAuthProviderService.js';

export const SESSION_COOKIE = 'bs_session';

export type Principal =
  | { kind: 'user'; user: User }
  | { kind: 'apiKey'; apiKey: ApiKey; user: User };

export interface AuthBindings {
  Variables: {
    principal: Principal;
  };
}

export interface AuthMiddlewareOptions {
  auth: AuthService;
  apiKeys: ApiKeyService;
  /** Resolve the user behind a valid API key (defaults to AuthService.ensureUser). */
  resolveUser(apiKey: ApiKey): Promise<User>;
  /** When present, bearer tokens minted by the OAuth provider also count. */
  oauthTokens?: OAuthProviderService;
  /**
   * `WWW-Authenticate` value for 401s. The MCP spec requires it: the challenge
   * carries the resource-metadata URL that starts a client's OAuth discovery.
   */
  challenge?: string;
}

export function buildAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<AuthBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c, options);
    if (!principal) {
      return c.json(
        { error: 'unauthorized' },
        401,
        options.challenge ? { 'WWW-Authenticate': options.challenge } : {},
      );
    }
    c.set('principal', principal);
    return next();
  };
}

/** Variant that lets unauthenticated callers through but still attaches the principal if available. */
export function buildOptionalAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<AuthBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c, options);
    if (principal) c.set('principal', principal);
    return next();
  };
}

async function resolvePrincipal(
  c: Parameters<MiddlewareHandler<AuthBindings>>[0],
  options: AuthMiddlewareOptions,
): Promise<Principal | null> {
  const { auth, apiKeys, resolveUser } = options;
  // 1. Bearer API key.
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const apiKey = await apiKeys.validate(token);
    if (apiKey) {
      const user = await resolveUser(apiKey);
      return { kind: 'apiKey', apiKey, user };
    }

    // 1b. Bearer OAuth access token, minted by our own provider. Dressed as an
    // ApiKey principal so everything downstream (MCP included) works unchanged.
    if (options.oauthTokens) {
      const grant = await options.oauthTokens.validateAccessToken(token);
      if (grant) {
        const asApiKey: ApiKey = {
          id: `oauth:${grant.clientId}`,
          userId: grant.userId,
          name: 'oauth client',
          prefix: token.slice(0, 11),
          scopes: grant.scopes,
          createdAt: 0,
          lastUsedAt: null,
          revokedAt: null,
        };
        const user = await resolveUser(asApiKey);
        return { kind: 'apiKey', apiKey: asApiKey, user };
      }
    }
  }

  // 2. Session cookie.
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken) {
    const user = await auth.validateSession(sessionToken);
    if (user) return { kind: 'user', user };
  }

  return null;
}
