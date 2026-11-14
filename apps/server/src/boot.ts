// Boots a BrainStack server: one composition root for every entrypoint.
//
// The long-lived server (`serve.ts`, Docker and development) and the Netlify
// function used to repeat this wiring line for line, and a step added to one
// and not the other is a bug that only exists in one deployment. What differs
// between them is what this takes as options; everything else happens here, in
// the order it must.
//
// Boot order matters. The schema is built before anything queries it, and the
// owner backfill runs before the first listing, so notes written before
// ownership existed are not invisible on the first page load.

import { ensurePgSchema, openPgDatabase, runPgMigrations, type PgDb } from '@brainstack/core/pg';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Logger } from 'pino';

import { API_BASE_PATH } from './config/api.js';
import type { AppConfig } from './config/env.js';
import { buildApp } from './http/app.js';
import type { AuthBindings } from './http/middleware/auth.js';
import type { TrustedProxy } from './lib/clientIp.js';
import { buildMcpServer, type McpPrincipal } from './mcp/server.js';
import { assertPluginNames, pluginMigrations, type BrainStackPlugin } from './plugin.js';
import { purgeExpired } from './services/Maintenance.js';
import { backfillOwnerId } from './services/OwnerBackfill.js';
import { pluginTrpc, withPluginRouters } from './trpc/router.js';
import { buildServices, type Services } from './wiring.js';

export interface CreateBrainStackOptions {
  config: AppConfig;
  logger: Logger;
  /**
   * The web app and the API share one origin, as on Netlify: no cross-origin
   * request to allow, and links in emails point at `PUBLIC_ORIGIN`. Otherwise
   * the web app is the first CORS origin, as in development.
   */
  sameOrigin?: boolean;
  /** Overrides `TRUSTED_PROXY`, for a host whose edge names the client itself. */
  trustedProxy?: TrustedProxy;
  /** Optional additions; see `plugin.ts`. None by default. */
  plugins?: readonly BrainStackPlugin[];
  /**
   * An open database to use instead of opening `DATABASE_URL`: tests, a
   * plugin's included, pass an in-process one. `close` is whatever releases it.
   */
  database?: { db: PgDb; close(): Promise<void> };
}

export interface BrainStack {
  /** The HTTP app: API, MCP and OAuth, behind `API_BASE_PATH`. */
  app: Hono<AuthBindings>;
  services: Services;
  db: PgDb;
  /** Clears expired sessions, links and OAuth rows. Logs and never throws. */
  purgeExpired(): Promise<void>;
  /** Closes the database pool, where there is one. */
  close(): Promise<void>;
}

export async function createBrainStack(opts: CreateBrainStackOptions): Promise<BrainStack> {
  const { config: cfg, logger } = opts;
  const { db, close } = opts.database ?? openPgDatabase(cfg.DATABASE_URL);

  /*
   * Applying migrations here rather than from a deploy step or an admin
   * endpoint: every statement is `IF NOT EXISTS` and the applied ones are
   * recorded, so this is a couple of queries on a warm schema and the right
   * ones exactly once on a new database. It also means a deploy cannot land
   * with code ahead of its schema — the alternative is remembering to call
   * something after every deploy, and forgetting once is an outage.
   */
  await ensurePgSchema(db);

  // Where the web app lives: the same origin, which keeps the session cookie
  // first-party, or the first CORS origin when it runs on a port of its own.
  const appOrigin = opts.sameOrigin ? cfg.PUBLIC_ORIGIN : (cfg.corsOrigins[0] ?? cfg.PUBLIC_ORIGIN);

  const services = buildServices({
    db,
    logger,
    publicOrigin: cfg.PUBLIC_ORIGIN,
    appOrigin,
    authorizedEmails: cfg.authorizedEmails,
    // Verification and reset links point at endpoints, which sit behind it.
    apiBasePath: API_BASE_PATH,
    email: cfg.email,
    openSignup: cfg.OPEN_SIGNUP,
    googleClientId: cfg.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
    googleRedirectUri: cfg.GOOGLE_OAUTH_REDIRECT_URI,
    crawlHistoryDays: cfg.CRAWL_HISTORY_DAYS,
  });

  // Said once, at boot, so whoever runs the instance knows what it cannot do.
  if (!services.auth.canSendEmail) {
    logger.warn(
      'no email configured (RESEND_API_KEY or SMTP_HOST, plus AUTH_EMAIL_FROM): ' +
        'the first account is created without verification, but nobody else can sign up with a password ' +
        'and password resets need the reset-password command',
    );
  }
  if (cfg.OPEN_SIGNUP) logger.info('OPEN_SIGNUP is on: anyone who reaches this server can sign up');

  // Turning the history off, or shortening it, takes effect now rather than
  // at the next crawl.
  await services.crawls.applyRetention();
  if (!services.crawls.enabled) {
    logger.info('CRAWL_HISTORY_DAYS=0: crawls are not kept for the Sentinel view');
  }

  // Housekeeping never stands between the server and its first request: a
  // purge that fails is logged and tried again later.
  const purge = async (): Promise<void> => {
    await purgeExpired(db, { logger }).then(
      () => undefined,
      (err: unknown) => logger.error({ err }, 'purging expired rows failed'),
    );
  };
  await purge();

  // Notes written before ownership existed belong to nobody and are listed by
  // nobody. Claiming them before the first listing keeps them from vanishing.
  const backfill = await backfillOwnerId(db, { logger });
  if (!backfill.skipped) {
    logger.info({ notesUpdated: backfill.notesUpdated }, 'claimed notes that had no owner');
  }

  const plugins = opts.plugins ?? [];
  assertPluginNames(plugins);
  if (plugins.length > 0) logger.info({ plugins: plugins.map((p) => p.name) }, 'plugins loaded');

  // After BrainStack's own schema, so a plugin table may reference one of its
  // tables; before any plugin code runs, so that code meets its tables.
  const migrations = pluginMigrations(plugins);
  if (migrations.length > 0) {
    const ran = await runPgMigrations(db, migrations);
    if (ran.length > 0) logger.info({ migrations: ran }, 'applied plugin migrations');
  }
  for (const plugin of plugins) await plugin.setup?.({ db, services, logger });

  const mcpFor = (principal: McpPrincipal | null) =>
    buildMcpServer({
      notes: services.notes,
      search: services.search,
      sharing: services.sharing,
      // `list_links` masks backlink sources the caller cannot read, and
      // needs the same cross-owner reader the app itself gets above.
      crossOwner: services.crossOwner,
      auth: services.auth,
      crawls: services.crawls,
      logger,
      principal,
      plugins,
    });
  // MCP servers are built per session, so a plugin tool whose name is taken
  // would only fail on the first call. Building one now fails the boot instead.
  if (plugins.length > 0) mcpFor(null);

  const trpcRouters = Object.fromEntries(
    plugins.flatMap((p) => (p.trpc ? [[p.name, p.trpc(pluginTrpc)] as const] : [])),
  );

  /*
   * Derived from the origin rather than NODE_ENV. A Secure cookie only means
   * anything over https and PUBLIC_ORIGIN says so directly; setting
   * NODE_ENV=production on Netlify would also apply to the build, where it
   * makes pnpm skip devDependencies and the build fails.
   */
  const secureCookies = cfg.PUBLIC_ORIGIN.startsWith('https://');

  const app = buildApp({
    logger,
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    auth: services.auth,
    apiKeys: services.apiKeys,
    notes: services.notes,
    search: services.search,
    sharing: services.sharing,
    invites: services.invites,
    crossOwner: services.crossOwner,
    crawls: services.crawls,
    totp: services.totp,
    ...(services.google ? { google: services.google } : {}),
    resolveUserForApiKey: services.resolveUserForApiKey,
    rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
    trustedProxy: opts.trustedProxy ?? cfg.TRUSTED_PROXY,
    secureCookies,
    // On one origin there is no cross-origin request to allow.
    corsOrigins: opts.sameOrigin ? [] : cfg.corsOrigins,
    appHome: appOrigin,
    // MCP hosts (claude.ai, Claude Code, Cursor) authenticate via OAuth: the
    // `.well-known` documents, /api/oauth/* and provider-issued tokens all
    // hang off this. The issuer is the configured origin, never the request's.
    oauth: { service: services.oauthProvider, issuer: cfg.PUBLIC_ORIGIN },
    // The same prefix everywhere, so a URL that works locally works deployed.
    basePath: API_BASE_PATH,
    buildMcpServer: mcpFor,
    trpcRouter: withPluginRouters(trpcRouters),
    pluginRoutes: ({ requireAuth, optionalAuth }) =>
      plugins.flatMap((p) =>
        p.routes
          ? [
              {
                name: p.name,
                routes: p.routes({
                  services,
                  logger,
                  requireAuth,
                  optionalAuth,
                  secureCookies,
                  appHome: appOrigin,
                  mountPath: `${API_BASE_PATH}/plugins/${p.name}`,
                }),
              },
            ]
          : [],
      ),
  });

  return { app, services, db, purgeExpired: purge, close };
}
