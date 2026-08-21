// Everything BrainStack serves over HTTP, on one Netlify function.
//
// The API, the auth endpoints, tRPC and the MCP endpoint all live under `/api`,
// so one path pattern routes them all here. Hono is runtime-agnostic and the
// request is already a Fetch Request, so this is the entire adapter: no Node
// http objects, no server to listen.
//
// The web app is served from the same site, which keeps the session cookie
// first-party and removes CORS from the picture.

import { getApp } from './_shared.mjs';

import type { Config } from '@netlify/functions';

export default async (req: Request): Promise<Response> => {
  const app = await getApp();
  return app.fetch(req);
};

export const config: Config = { path: '/api/*' };
