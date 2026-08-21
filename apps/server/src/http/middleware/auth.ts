// Auth middleware. Resolves the caller as either a logged-in user (session
// cookie) or an MCP client (Bearer API key). Attaches the principal to
// `c.var` so downstream handlers don't repeat the work.

import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

import type { ApiKey, ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService, User } from '../../services/AuthService.js';

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
}

export function buildAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<AuthBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c, options);
    if (!principal) {
      return c.json({ error: 'unauthorized' }, 401);
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
  { auth, apiKeys, resolveUser }: AuthMiddlewareOptions,
): Promise<Principal | null> {
  // 1. Bearer API key.
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const apiKey = await apiKeys.validate(token);
    if (apiKey) {
      const user = await resolveUser(apiKey);
      return { kind: 'apiKey', apiKey, user };
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
