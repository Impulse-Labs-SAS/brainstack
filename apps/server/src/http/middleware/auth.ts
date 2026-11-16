// Auth middleware. Resolves the caller as either a logged-in user (session
// cookie) or an MCP client (Bearer API key, OAuth token, or a token a plugin
// recognises). Attaches the principal to
// `c.var` so downstream handlers don't repeat the work.

import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

import type { ApiKey, ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService, User } from '../../services/AuthService.js';
import type { OAuthProviderService } from '../../services/OAuthProviderService.js';
import type { PluginCredential } from '../../plugin.js';
import type { Logger } from 'pino';

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
  /**
   * Plugins that recognise bearer tokens BrainStack did not issue, asked in
   * order once the API key and OAuth checks above have said no. Like OAuth
   * tokens, they authenticate where this middleware runs (/mcp, plugin
   * routes), not on /trpc.
   */
  bearerPlugins?: readonly BearerPlugin[];
  /** Where a plugin that throws while checking a token is logged. */
  logger?: Pick<Logger, 'warn' | 'error'>;
}

/** A plugin's token check, as the middleware asks it. */
export interface BearerPlugin {
  name: string;
  authenticate(token: string): PluginCredential | null | Promise<PluginCredential | null>;
}

export function buildAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<AuthBindings> {
  return async (c, next) => {
    // Hono matches `/mcp/*` for `/mcp` too, so a route can pass through two
    // registrations of this middleware. Resolving once spares a second lookup
    // — and a plugin's second signature check.
    if (c.get('principal')) return next();
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
    if (c.get('principal')) return next();
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

    // 1c. A token a plugin recognises. Last, so a plugin adds a way in and
    // never answers for a credential BrainStack issued.
    for (const plugin of options.bearerPlugins ?? []) {
      const principal = await pluginPrincipal(plugin, token, options);
      if (principal) return principal;
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

/**
 * The caller a plugin says a token stands for, dressed as an API key so
 * everything downstream — scopes, MCP, tool-call hooks — treats it like one.
 * Null when the plugin does not recognise the token, names an account that
 * does not exist, or throws: a bug in a plugin refuses the token rather than
 * failing the request.
 */
async function pluginPrincipal(
  plugin: BearerPlugin,
  token: string,
  options: AuthMiddlewareOptions,
): Promise<Principal | null> {
  let credential: PluginCredential | null;
  try {
    credential = await plugin.authenticate(token);
  } catch (err) {
    options.logger?.error({ err, plugin: plugin.name }, 'plugin failed to check a bearer token');
    return null;
  }
  if (!credential) return null;

  const user = await options.auth.findUserById(credential.userId);
  if (!user) {
    options.logger?.warn(
      { plugin: plugin.name },
      'plugin accepted a bearer token for an account that does not exist',
    );
    return null;
  }
  const apiKey: ApiKey = {
    id: `plugin:${plugin.name}${credential.ref ? `:${credential.ref}` : ''}`,
    userId: user.id,
    name: `plugin ${plugin.name}`,
    prefix: token.slice(0, 11),
    scopes: [...credential.scopes],
    createdAt: 0,
    lastUsedAt: null,
    revokedAt: null,
  };
  return { kind: 'apiKey', apiKey, user };
}
