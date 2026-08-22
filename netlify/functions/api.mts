// Everything BrainStack serves over HTTP, on one Netlify function.
//
// The API, the auth endpoints, tRPC and the MCP endpoint all live under `/api`,
// so one path pattern routes them all here. Hono is runtime-agnostic and the
// request is already a Fetch Request, so this is the entire adapter: no Node
// http objects, no server to listen.
//
// The web app is served from the same site, which keeps the session cookie
// first-party and removes CORS from the picture.
//
// One file on purpose. The bootstrap used to live in `_shared.mts`, imported
// from here as `./_shared.mjs` — correct TypeScript, since NodeNext wants the
// output extension. Netlify's bundler does not do that rewrite: it followed the
// import to something else entirely and shipped a bundle with no `default`
// export in it, which the runtime answers as 502. Nothing to resolve, nothing
// to get wrong.

import { ensurePgSchema, openPgDatabase } from '@brainstack/core/pg';

import { API_BASE_PATH } from '../../apps/server/src/config/api.js';
import { loadConfig } from '../../apps/server/src/config/env.js';
import { buildApp } from '../../apps/server/src/http/app.js';
import { getLogger } from '../../apps/server/src/lib/logger.js';
import { buildMcpServer } from '../../apps/server/src/mcp/server.js';
import { backfillOwnerId } from '../../apps/server/src/services/OwnerBackfill.js';
import { buildServices } from '../../apps/server/src/wiring.js';

import type { Config } from '@netlify/functions';
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
    // MCP hosts (claude.ai, Claude Code, Cursor) authenticate via OAuth: the
    // `.well-known` documents, /api/oauth/* and provider-issued tokens all
    // hang off this. The issuer is the configured origin, never the request's.
    oauth: { service: services.oauthProvider, issuer: cfg.PUBLIC_ORIGIN },
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

export default async (req: Request): Promise<Response> => {
  const app = await getApp();
  return app.fetch(req);
};

/*
 * No `path` on purpose. Declaring one enters this function in the same routing
 * table as the Next.js catch-all, and which of the two wins `/api/*` turned
 * out to vary between otherwise identical deploys — same config, one deploy
 * answers 200 and the next 404. With no path the function keeps only its
 * canonical `/.netlify/functions/api` route and the `[[redirects]] /api/*`
 * rule in netlify.toml does the routing, which nothing competes with.
 */
export const config: Config = {};
