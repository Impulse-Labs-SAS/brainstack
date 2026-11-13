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

import { createBrainStack } from '../../apps/server/src/boot.js';
import { loadConfig } from '../../apps/server/src/config/env.js';
import { getLogger } from '../../apps/server/src/lib/logger.js';

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
  // A boot that failed is not remembered: the next request tries again rather
  // than every request answering 500 until the container is recycled.
  cached ??= boot().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

async function boot(): Promise<Hono<never>> {
  const { app } = await createBrainStack({
    config: loadConfig(),
    logger: getLogger(),
    // One origin serves both, which is what keeps the session cookie
    // first-party and takes CORS out of the picture entirely.
    sameOrigin: true,
    // Netlify's edge writes the client address into its own header.
    trustedProxy: 'netlify',
    // No process outlives a request here, so expired rows are purged when a
    // container starts, which createBrainStack does on every boot.
  });
  return app as unknown as Hono<never>;
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
