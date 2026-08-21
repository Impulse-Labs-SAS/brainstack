// The service graph, built once per container.
//
// Module scope survives between invocations on a warm container, so the Neon
// client and the services are built once rather than per request. Nothing here
// holds a connection open — the HTTP driver is stateless — so a cold start
// costs a module evaluation and nothing more.

import { ensurePgSchema, openPgDatabase } from '@brainstack/core/pg';

import { API_BASE_PATH } from '../../apps/server/src/config/api.js';
import { loadConfig } from '../../apps/server/src/config/env.js';
import { buildApp } from '../../apps/server/src/http/app.js';
import { getLogger } from '../../apps/server/src/lib/logger.js';
import { buildMcpServer } from '../../apps/server/src/mcp/server.js';
import { backfillOwnerId } from '../../apps/server/src/services/OwnerBackfill.js';
import { buildServices } from '../../apps/server/src/wiring.js';

import type { Hono } from 'hono';

let cached: Promise<Hono<never>> | null = null;

/**
 * The whole Hono app, ready to answer.
 *
 * There is no boot step on Netlify — a function is a request or nothing — so
 * the work `serve.ts` does at startup happens here instead, on the first
 * request a container sees, and is remembered for the rest of its life. The
 * promise itself is cached rather than the result, so two requests arriving
 * together on a cold container share one bootstrap instead of racing it.
 */
export function getApp(): Promise<Hono<never>> {
  cached ??= boot();
  return cached;
}

async function boot(): Promise<Hono<never>> {
  const cfg = loadConfig();
  const logger = getLogger();

  const { db } = openPgDatabase(cfg.DATABASE_URL);

  /*
   * Applying migrations here rather than from a deploy step or an admin
   * endpoint: every statement is `IF NOT EXISTS` and the applied ones are
   * recorded, so this is a couple of queries on a warm schema and the right
   * ones exactly once on a new database. It also means a deploy cannot land
   * with code ahead of its schema — the alternative is remembering to call
   * something after every deploy, and forgetting once is an outage.
   */
  await ensurePgSchema(db);

  const services = buildServices({
    db,
    logger,
    publicOrigin: cfg.PUBLIC_ORIGIN,
    // One origin serves both, which is what keeps the session cookie
    // first-party and takes CORS out of the picture entirely.
    appOrigin: cfg.PUBLIC_ORIGIN,
    authorizedEmails: cfg.authorizedEmails,
    apiBasePath: API_BASE_PATH,
    deployment: cfg.BRAINSTACK_DEPLOYMENT,
    resendApiKey: cfg.RESEND_API_KEY,
    emailFrom: cfg.AUTH_EMAIL_FROM,
    googleClientId: cfg.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
    googleRedirectUri: cfg.GOOGLE_OAUTH_REDIRECT_URI,
  });

  // Notes written before ownership existed belong to nobody and are listed by
  // nobody. Claiming them before the first listing keeps them from vanishing.
  const backfill = await backfillOwnerId(db, {
    deployment: cfg.BRAINSTACK_DEPLOYMENT,
    logger,
  });
  if (!backfill.skipped) {
    logger.info({ notesUpdated: backfill.notesUpdated }, 'claimed notes that had no owner');
  }

  return buildApp({
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
    /*
     * Derived from the origin rather than NODE_ENV. A Secure cookie only means
     * anything over https and PUBLIC_ORIGIN says so directly; setting
     * NODE_ENV=production on Netlify would also apply to the build, where it
     * makes pnpm skip devDependencies and the build fails.
     */
    secureCookies: cfg.PUBLIC_ORIGIN.startsWith('https://'),
    // Same origin, so there is no cross-origin request to allow.
    corsOrigins: [],
    appHome: cfg.PUBLIC_ORIGIN,
    /*
     * Never here. An https origin is not a development machine, and leaving
     * this on would hand a password reset link to anyone who can POST an
     * address to /api/auth/forgot-password — which is the whole account.
     */
    exposeDevTokens: false,
    publicConfig: {
      deployment: cfg.BRAINSTACK_DEPLOYMENT,
      features: { sharing: cfg.BRAINSTACK_DEPLOYMENT === 'hosted' },
    },
    vaultCfg: { deployment: cfg.BRAINSTACK_DEPLOYMENT },
    basePath: API_BASE_PATH,
    buildMcpServer: (principal) =>
      buildMcpServer({
        notes: services.notes,
        search: services.search,
        sharing: services.sharing,
        logger,
        principal,
      }),
  }) as unknown as Hono<never>;
}
