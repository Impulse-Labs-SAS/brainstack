// Hono application factory. Combines middlewares and routers so that
// `index.ts` only worries about boot order and shutdown.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from 'pino';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ApiKeyService } from '../services/ApiKeyService.js';
import type { AuthService, User } from '../services/AuthService.js';
import type { ApiKey } from '../services/ApiKeyService.js';
import type { GoogleOAuthService } from '../services/GoogleOAuthService.js';
import type { TotpService } from '../services/TotpService.js';

import { createLoginRateLimiter, type LoginRateLimiter } from '../lib/rateLimitLogin.js';

import { buildAuthMiddleware, type AuthBindings } from './middleware/auth.js';
import { buildRateLimitMiddleware } from './middleware/rateLimit.js';
import { createAuthRouter } from './routes/auth.js';
import { createMcpHttpRouter } from './routes/mcp.js';
import { createOAuthGoogleRouter } from './routes/oauthGoogle.js';
import { createTotpRouter } from './routes/totp.js';
import { createTrpcRouter } from './routes/trpc.js';
import { healthRouter } from './routes/health.js';
import { createConfigRouter, type PublicConfig } from './routes/config.js';
import { createInviteRouter } from './routes/invite.js';
import { buildOptionalAuthMiddleware } from './middleware/auth.js';
import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import type { InviteService } from '../services/InviteService.js';
import type { NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';
import type { SharingService } from '../services/SharingService.js';

import type { McpPrincipal } from '../mcp/server.js';
import type { VaultConfig } from '../lib/vault.js';

export interface BuildAppOptions {
  buildMcpServer(principal: McpPrincipal | null): McpServer;
  logger: Logger;
  auth: AuthService;
  apiKeys: ApiKeyService;
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  invites: InviteService;
  crossOwner: CrossOwnerReader;
  resolveUserForApiKey(apiKey: ApiKey): Promise<User>;
  rateLimitPerMinute: number;
  secureCookies: boolean;
  /** Allowed origins for CORS (web app, etc.). Empty array disables CORS. */
  corsOrigins: string[];
  /** First CORS origin or PUBLIC_ORIGIN — where verify/reset redirect lands. */
  appHome: string;
  /** When true (dev), responses include verification/reset URLs. */
  exposeDevTokens: boolean;
  /** Inject a custom limiter (tests). Defaults to an in-memory one. */
  loginLimiter?: LoginRateLimiter;
  /** Google OAuth service. When omitted, /auth/google* routes are disabled. */
  google?: GoogleOAuthService;
  /** TOTP service. When omitted, /auth/totp/* routes are disabled. */
  totp?: TotpService;
  /** Public deployment config exposed at GET /api/config. */
  publicConfig: PublicConfig;
  /** Deployment mode: decides whether paths carry an owner prefix. */
  vaultCfg: VaultConfig;
}

export function buildApp(opts: BuildAppOptions): Hono<AuthBindings> {
  const app = new Hono<AuthBindings>();

  if (opts.corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: (origin) =>
          opts.corsOrigins.includes(origin) ? origin : opts.corsOrigins[0] ?? null,
        credentials: true,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'x-session-token'],
      }),
    );
  }

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    opts.logger.debug(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
      'http',
    );
  });

  const middlewareOpts = {
    auth: opts.auth,
    apiKeys: opts.apiKeys,
    resolveUser: opts.resolveUserForApiKey,
  };

  const loginLimiter = opts.loginLimiter ?? createLoginRateLimiter();

  app.route('/health', healthRouter);
  app.route('/api/config', createConfigRouter(opts.publicConfig));

  // /invite/accept/:token corre con optional-auth: el handler maneja
  // los casos logueado/no-logueado y redirige al frontend acorde.
  const optionalAuth = buildOptionalAuthMiddleware(middlewareOpts);
  app.use('/invite/*', optionalAuth);
  app.route(
    '/invite',
    createInviteRouter({ invites: opts.invites, appHome: opts.appHome }),
  );
  app.route(
    '/auth',
    createAuthRouter({
      ...middlewareOpts,
      auth: opts.auth,
      apiKeys: opts.apiKeys,
      logger: opts.logger,
      secureCookies: opts.secureCookies,
      loginLimiter,
      appHome: opts.appHome,
      exposeDevTokens: opts.exposeDevTokens,
    }),
  );

  if (opts.google) {
    app.route(
      '/auth',
      createOAuthGoogleRouter({
        google: opts.google,
        auth: opts.auth,
        logger: opts.logger,
        secureCookies: opts.secureCookies,
        appHome: opts.appHome,
      }),
    );
  }

  if (opts.totp) {
    app.route(
      '/auth/totp',
      createTotpRouter({ ...middlewareOpts, auth: opts.auth, totp: opts.totp }),
    );
  }

  const requireAuth = buildAuthMiddleware(middlewareOpts);
  const rateLimit = buildRateLimitMiddleware({ perMinute: opts.rateLimitPerMinute });
  const mcpRouter = createMcpHttpRouter({ buildServer: opts.buildMcpServer, logger: opts.logger });

  app.use('/mcp/*', requireAuth);
  app.use('/mcp/*', rateLimit);
  app.use('/mcp', requireAuth);
  app.use('/mcp', rateLimit);
  app.route('/mcp', mcpRouter);

  app.route(
    '/trpc',
    createTrpcRouter({
      notes: opts.notes,
      search: opts.search,
      auth: opts.auth,
      apiKeys: opts.apiKeys,
      sharing: opts.sharing,
      invites: opts.invites,
      crossOwner: opts.crossOwner,
      resolveUserForApiKey: opts.resolveUserForApiKey,
    }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}
