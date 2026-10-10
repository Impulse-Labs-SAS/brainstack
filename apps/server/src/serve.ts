// Standalone HTTP server, for local development.
//
// In production the Hono app is served from inside the Next app, because
// Netlify's runtime routes every path there. Locally that indirection is only
// in the way: this listens on its own port, the web app runs on another, and
// CORS lets them talk.
//
// Boot order matters. The schema is built before anything queries it, and the
// owner backfill runs before the first listing, so notes written before
// ownership existed are not invisible on the first page load.

import { serve } from '@hono/node-server';
import { ensurePgSchema, openPgDatabase } from '@brainstack/core/pg';

import { API_BASE_PATH } from './config/api.js';
import { loadConfig } from './config/env.js';
import { buildApp } from './http/app.js';
import { getLogger } from './lib/logger.js';
import { buildMcpServer } from './mcp/server.js';
import { backfillOwnerId } from './services/OwnerBackfill.js';
import { buildServices } from './wiring.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = getLogger();

  const { db, close: closeDb } = openPgDatabase(cfg.DATABASE_URL);
  await ensurePgSchema(db);

  const services = buildServices({
    db,
    logger,
    publicOrigin: cfg.PUBLIC_ORIGIN,
    // The web app runs on its own port in development.
    appOrigin: cfg.corsOrigins[0] ?? cfg.PUBLIC_ORIGIN,
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
  if (!services.crawls.enabled) logger.info('CRAWL_HISTORY_DAYS=0: crawls are not kept for the Sentinel view');

  const backfill = await backfillOwnerId(db, { logger });
  if (!backfill.skipped) {
    logger.info({ notesUpdated: backfill.notesUpdated }, 'claimed notes that had no owner');
  }

  const app = buildApp({
    logger,
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
    // A Secure cookie only means anything over https, and the origin says so.
    secureCookies: cfg.PUBLIC_ORIGIN.startsWith('https://'),
    corsOrigins: cfg.corsOrigins,
    appHome: cfg.corsOrigins[0] ?? cfg.PUBLIC_ORIGIN,
    // Same OAuth provider as production, so the whole flow is testable locally.
    oauth: { service: services.oauthProvider, issuer: cfg.PUBLIC_ORIGIN },
    // Same prefix as production, so a URL that works here works deployed.
    basePath: API_BASE_PATH,
    buildMcpServer: (principal) =>
      buildMcpServer({
        notes: services.notes,
        search: services.search,
        sharing: services.sharing,
        crossOwner: services.crossOwner,
        auth: services.auth,
        invites: services.invites,
        crawls: services.crawls,
        logger,
        principal,
      }),
  });

  const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    logger.info({ port: info.port }, 'BrainStack server listening');
  });

  /*
   * `docker stop` sends SIGTERM and waits ten seconds before killing. Node
   * running as a container's first process ignores the signal unless something
   * listens for it, so without this every stop is a kill: requests in flight
   * are cut, and the pool's connections are dropped rather than closed.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      closeDb()
        .catch((err: unknown) => logger.error({ err }, 'closing the database failed'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // No logger yet if config failed, so this goes to stderr directly.
  console.error(err);
  process.exit(1);
});
