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

import { loadConfig } from './config/env.js';
import { buildApp } from './http/app.js';
import { getLogger } from './lib/logger.js';
import { buildMcpServer } from './mcp/server.js';
import { backfillOwnerId } from './services/OwnerBackfill.js';
import { buildServices } from './wiring.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = getLogger();

  const { db } = openPgDatabase(cfg.DATABASE_URL);
  await ensurePgSchema(db);

  const services = buildServices({
    db,
    logger,
    publicOrigin: cfg.PUBLIC_ORIGIN,
    authorizedEmails: cfg.authorizedEmails,
    deployment: cfg.BRAINSTACK_DEPLOYMENT,
    resendApiKey: cfg.RESEND_API_KEY,
    emailFrom: cfg.AUTH_EMAIL_FROM,
    googleClientId: cfg.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
    googleRedirectUri: cfg.GOOGLE_OAUTH_REDIRECT_URI,
  });

  const backfill = await backfillOwnerId(db, {
    deployment: cfg.BRAINSTACK_DEPLOYMENT,
    logger,
  });
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
    totp: services.totp,
    ...(services.google ? { google: services.google } : {}),
    resolveUserForApiKey: services.resolveUserForApiKey,
    rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
    // A Secure cookie only means anything over https, and the origin says so.
    secureCookies: cfg.PUBLIC_ORIGIN.startsWith('https://'),
    corsOrigins: cfg.corsOrigins,
    appHome: cfg.corsOrigins[0] ?? cfg.PUBLIC_ORIGIN,
    // Dev only: lets the web app read tokens the email would otherwise carry.
    exposeDevTokens: cfg.NODE_ENV === 'development',
    publicConfig: {
      deployment: cfg.BRAINSTACK_DEPLOYMENT,
      features: { sharing: cfg.BRAINSTACK_DEPLOYMENT === 'hosted' },
    },
    vaultCfg: { deployment: cfg.BRAINSTACK_DEPLOYMENT },
    buildMcpServer: (principal) =>
      buildMcpServer({
        notes: services.notes,
        search: services.search,
        sharing: services.sharing,
        logger,
        principal,
      }),
  });

  serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    logger.info(
      { port: info.port, deployment: cfg.BRAINSTACK_DEPLOYMENT },
      'BrainStack server listening',
    );
  });
}

main().catch((err: unknown) => {
  // No logger yet if config failed, so this goes to stderr directly.
  console.error(err);
  process.exit(1);
});
