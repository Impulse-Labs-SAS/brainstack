// The OAuth endpoints that make BrainStack a provider: discovery documents,
// dynamic client registration, the authorize/consent pair and the token
// endpoint. An MCP host (claude.ai, Claude Code, Cursor) walks them in that
// order and ends up holding a token it obtained itself — nobody pastes keys.
//
// Everything that decides is in OAuthProviderService; this file parses,
// validates shape, and renders. Error style follows the RFCs rather than the
// rest of the API: OAuth clients read `{"error":"invalid_grant"}`, not
// `{"error":"..."}` prose.

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { AuthService } from '../../services/AuthService.js';
import {
  isAllowedRedirectUri,
  narrowScope,
  OAUTH_SCOPES,
  type OAuthClient,
  type OAuthProviderService,
} from '../../services/OAuthProviderService.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

export interface OAuthProviderRouterOptions {
  oauth: OAuthProviderService;
  auth: AuthService;
  logger: Logger;
  /** Public origin, e.g. https://brain.example.com. The issuer. */
  issuer: string;
  /** Where the login page lives. Same origin deployed; :3001 in dev. */
  appHome: string;
  /** Prefix the API answers under, e.g. `/api`. Used to build endpoint URLs. */
  basePath: string;
}

const DEFAULT_SCOPE = OAUTH_SCOPES.join(' ');

/**
 * RFC 8414 authorization server metadata and RFC 9728 protected resource
 * metadata. Mounted at the app root, not under the API prefix — `.well-known`
 * is only well-known at the origin root.
 *
 * Clients derive path-suffixed variants of both URLs (RFC 9728 §3.1), so each
 * route also answers under a wildcard.
 */
export function createOAuthMetadataRouter(
  opts: Pick<OAuthProviderRouterOptions, 'issuer' | 'basePath'>,
): Hono {
  const router = new Hono();
  const mcpResource = `${opts.issuer}${opts.basePath}/mcp`;

  const protectedResource = {
    resource: mcpResource,
    authorization_servers: [opts.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'BrainStack',
  };

  const authorizationServer = {
    issuer: opts.issuer,
    authorization_endpoint: `${opts.issuer}${opts.basePath}/oauth/authorize`,
    token_endpoint: `${opts.issuer}${opts.basePath}/oauth/token`,
    registration_endpoint: `${opts.issuer}${opts.basePath}/oauth/register`,
    revocation_endpoint: `${opts.issuer}${opts.basePath}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };

  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
  ]) {
    router.get(path, (c) => c.json(protectedResource));
  }
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/*',
  ]) {
    router.get(path, (c) => c.json(authorizationServer));
  }

  return router;
}

/** The WWW-Authenticate challenge a 401 carries so clients find the metadata. */
export function buildOAuthChallenge(issuer: string): string {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${DEFAULT_SCOPE}"`;
}

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().max(2048).optional(),
  scope: z.string().max(256).optional(),
  resource: z.string().max(2048).optional(),
});

const registerBodySchema = z.object({
  redirect_uris: z.array(z.string().min(1)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_basic', 'client_secret_post'])
    .optional(),
  // Sent by registering clients; accepted and answered, not stored.
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

export function createOAuthProviderRouter(opts: OAuthProviderRouterOptions): Hono {
  const router = new Hono();
  const mcpResource = `${opts.issuer}${opts.basePath}/mcp`;

  /** Valid audiences (RFC 8707): the MCP endpoint, or the origin standing for it. */
  const validResources = new Set([mcpResource, opts.issuer, `${opts.issuer}/`]);

  const redirectBack = (
    redirectUri: string,
    params: Record<string, string | undefined>,
  ): Response => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    url.searchParams.set('iss', opts.issuer);
    return Response.redirect(url.toString(), 302);
  };

  /**
   * client_id + redirect_uri decide whether redirecting is safe at all. When
   * either fails the answer is a page, never a redirect — sending an error to
   * an unvalidated URI is exactly the open redirect OAuth warns about.
   */
  const resolveClientAndRedirect = async (
    clientId: string,
    redirectUri: string,
  ): Promise<OAuthClient | null> => {
    const client = await opts.oauth.getClient(clientId);
    if (!client) return null;
    if (!client.redirectUris.includes(redirectUri)) return null;
    return client;
  };

  router.get('/authorize', async (c) => {
    const parsed = authorizeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.html(errorPage('Malformed authorization request.'), 400);
    const q = parsed.data;

    const client = await resolveClientAndRedirect(q.client_id, q.redirect_uri);
    if (!client) return c.html(errorPage('Unknown client or redirect URI.'), 400);

    if (q.response_type !== 'code') {
      return redirectBack(q.redirect_uri, {
        error: 'unsupported_response_type',
        state: q.state,
      });
    }
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return redirectBack(q.redirect_uri, {
        error: 'invalid_request',
        error_description: 'PKCE with S256 is required',
        state: q.state,
      });
    }
    if (q.resource !== undefined && !validResources.has(q.resource)) {
      return redirectBack(q.redirect_uri, { error: 'invalid_target', state: q.state });
    }
    // Narrow rather than reject: a client asking for scopes we do not grant
    // gets what we do grant, not a dead end.
    const scope = narrowScope(q.scope);

    const sessionToken = getCookie(c, SESSION_COOKIE);
    const user = sessionToken ? await opts.auth.validateSession(sessionToken) : null;
    if (!user) {
      // Round-trip through the web login; redirect_to brings the whole
      // authorize request (query included) back here with a session.
      const back = new URL(c.req.url);
      const login = new URL('/login', opts.appHome);
      login.searchParams.set('redirect_to', `${back.pathname}${back.search}`);
      return Response.redirect(login.toString(), 302);
    }

    return c.html(
      consentPage({
        action: `${c.req.path}/decision`,
        clientName: client.name,
        userEmail: user.email,
        scope,
        fields: {
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          code_challenge: q.code_challenge,
          state: q.state ?? '',
          scope,
          resource: q.resource ?? '',
        },
      }),
    );
  });

  /*
   * The consent form posts here. The session cookie is SameSite=Lax, so a
   * cross-site POST arrives without it and dies on the session check below —
   * that is the CSRF story for this endpoint.
   */
  router.post('/authorize/decision', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    const user = sessionToken ? await opts.auth.validateSession(sessionToken) : null;
    if (!user) return c.html(errorPage('Session expired. Start over from the client.'), 401);

    const body = await c.req.parseBody();
    const field = (name: string): string => (typeof body[name] === 'string' ? body[name] : '');

    // Hidden fields came through the browser; trust nothing, re-validate all.
    const client = await resolveClientAndRedirect(field('client_id'), field('redirect_uri'));
    if (!client) return c.html(errorPage('Unknown client or redirect URI.'), 400);
    const codeChallenge = field('code_challenge');
    if (!codeChallenge) return c.html(errorPage('Malformed consent form.'), 400);
    const resource = field('resource');
    if (resource && !validResources.has(resource)) {
      return c.html(errorPage('Malformed consent form.'), 400);
    }
    const scope = narrowScope(field('scope'));
    const state = field('state') || undefined;

    if (field('decision') !== 'allow') {
      return redirectBack(field('redirect_uri'), { error: 'access_denied', state });
    }

    const code = await opts.oauth.createAuthorizationCode({
      clientId: client.id,
      userId: user.id,
      redirectUri: field('redirect_uri'),
      codeChallenge,
      scope,
      ...(resource ? { resource } : {}),
    });
    opts.logger.info({ clientId: client.id, userId: user.id }, 'oauth code issued');
    return redirectBack(field('redirect_uri'), { code, state });
  });

  router.post('/token', async (c) => {
    const body = await c.req.parseBody();
    const field = (name: string): string | undefined =>
      typeof body[name] === 'string' && body[name] !== '' ? body[name] : undefined;

    // Client credentials arrive as HTTP Basic or in the body; Basic wins.
    let clientId = field('client_id');
    let clientSecret = field('client_secret');
    const header = c.req.header('authorization');
    if (header?.toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, sep));
          const secret = decodeURIComponent(decoded.slice(sep + 1));
          clientSecret = secret === '' ? undefined : secret;
        }
      } catch {
        // Fall through with whatever the body carried.
      }
    }

    const tokenError = (error: string, status: 400 | 401 = 400): Response =>
      c.json({ error }, status, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });

    if (!clientId) return tokenError('invalid_client', 401);
    if (!(await opts.oauth.verifyClientSecret(clientId, clientSecret))) {
      return tokenError('invalid_client', 401);
    }

    const grantType = field('grant_type');
    let issued;
    if (grantType === 'authorization_code') {
      const code = field('code');
      const redirectUri = field('redirect_uri');
      const codeVerifier = field('code_verifier');
      if (!code || !redirectUri || !codeVerifier) return tokenError('invalid_request');
      issued = await opts.oauth.exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri,
        codeVerifier,
      });
    } else if (grantType === 'refresh_token') {
      const refreshToken = field('refresh_token');
      if (!refreshToken) return tokenError('invalid_request');
      issued = await opts.oauth.refresh({ refreshToken, clientId });
    } else {
      return tokenError('unsupported_grant_type');
    }

    if (!issued) return tokenError('invalid_grant');
    opts.logger.info({ clientId, grantType }, 'oauth tokens issued');
    return c.json(
      {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresInSeconds,
        refresh_token: issued.refreshToken,
        scope: issued.scope,
      },
      200,
      { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    );
  });

  /** Open registration (RFC 7591). The rate limiter mounted above is the gate. */
  router.post('/register', async (c) => {
    const parsed = registerBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_client_metadata' }, 400);
    }
    const invalid = parsed.data.redirect_uris.filter((uri) => !isAllowedRedirectUri(uri));
    if (invalid.length > 0) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: `not https or loopback: ${invalid.join(', ')}`,
        },
        400,
      );
    }

    const registered = await opts.oauth.registerClient({
      name: parsed.data.client_name ?? 'MCP client',
      redirectUris: parsed.data.redirect_uris,
      ...(parsed.data.token_endpoint_auth_method
        ? { tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method }
        : {}),
    });
    opts.logger.info({ clientId: registered.id, name: registered.name }, 'oauth client registered');

    return c.json(
      {
        client_id: registered.id,
        ...(registered.secret ? { client_secret: registered.secret } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: registered.name,
        redirect_uris: registered.redirectUris,
        token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: DEFAULT_SCOPE,
      },
      201,
    );
  });

  /**
   * Token revocation (RFC 7009). Public clients hold no secret to present, so
   * possession of the token is the authorization to revoke it — which is the
   * point. Always 200, even for an unknown token, exactly as the RFC says.
   */
  router.post('/revoke', async (c) => {
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token : '';
    if (token) await opts.oauth.revokeToken(token);
    return c.body(null, 200, { 'Cache-Control': 'no-store' });
  });

  return router;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Server-rendered on purpose: the consent screen must exist even when the
 * Next app is down, and it must not load client JS that could be tampered
 * with. Styling matches the app's dark neutrals, nothing more.
 */
function consentPage(params: {
  action: string;
  clientName: string;
  userEmail: string;
  scope: string;
  fields: Record<string, string>;
}): string {
  const hidden = Object.entries(params.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — BrainStack</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           background: #0a0a0a; color: #ededed;
           font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 24rem; padding: 2rem; }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; }
    p { color: #a3a3a3; font-size: 0.9rem; line-height: 1.5; }
    code { color: #ededed; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.6rem 1rem; border-radius: 0.5rem; border: 1px solid #333;
             font-size: 0.9rem; cursor: pointer; background: #171717; color: #ededed; }
    button.allow { background: #ededed; color: #0a0a0a; border-color: #ededed; }
  </style>
</head>
<body>
  <main>
    <h1>brainstack</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> wants to connect to your
       BrainStack notes as <code>${escapeHtml(params.userEmail)}</code>
       with scope <code>${escapeHtml(params.scope)}</code>.</p>
    <form method="post" action="${escapeHtml(params.action)}">
      ${hidden}
      <div class="actions">
        <button type="submit" name="decision" value="deny">Deny</button>
        <button type="submit" name="decision" value="allow" class="allow">Allow</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>BrainStack</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;
color:#ededed;font-family:system-ui,sans-serif}p{color:#a3a3a3}</style></head>
<body><main><h1>brainstack</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}
