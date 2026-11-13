// Plugin routes and tRPC procedures, through the whole app: they answer under
// the plugin's own name, behind the same limits and auth as BrainStack's own
// routes, and never in place of one of them.

import { Hono } from 'hono';
import superjson from 'superjson';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertPluginNames } from '../plugin.js';
import { createTestDatabase, type TestDatabase } from '../services/testDb.js';
import { buildTestApp, type TestApp } from '../testApp.js';
import { pluginTrpc, withPluginRouters } from '../trpc/router.js';

import type { PluginAuth } from './app.js';
import type { AuthBindings } from './middleware/auth.js';

let database: TestDatabase;
let app: TestApp;

/** Routes a plugin named `echo` would bring: one open, one behind sign-in. */
function echoRoutes({ requireAuth }: PluginAuth): Hono<AuthBindings> {
  const routes = new Hono<AuthBindings>();
  routes.get('/open', (c) => c.json({ hello: 'anyone' }));
  routes.use('/me', requireAuth);
  routes.get('/me', (c) => c.json({ userId: c.var.principal.user.id }));
  // Tries to answer for a BrainStack route from inside its own mount.
  routes.get('/health', (c) => c.json({ hijacked: true }));
  return routes;
}

/** Procedures a plugin named `echo` would bring. */
const echoRouter = pluginTrpc.router({
  hello: pluginTrpc.publicProcedure.query(() => 'hello'),
  whoami: pluginTrpc.protectedProcedure.query(({ ctx }) => ctx.user.id),
  touch: pluginTrpc.protectedProcedure
    .input(z.object({ path: z.string() }))
    .mutation(({ input }) => input.path),
});

function appWith(rateLimitPerMinute = 1000): TestApp {
  return buildTestApp(database, {
    rateLimitPerMinute,
    pluginRoutes: (auth) => [{ name: 'echo', routes: echoRoutes(auth) }],
    trpcRouter: withPluginRouters({ echo: echoRouter }),
  });
}

const trpcGet = (procedure: string, init: RequestInit = {}) =>
  app.request(`/api/trpc/${procedure}`, init);

const trpcPost = (procedure: string, input: unknown, headers: Record<string, string>) =>
  app.request(`/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize(input)),
  });

const data = async (res: Response) =>
  superjson.deserialize(((await res.json()) as { result: { data: never } }).result.data);

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  app = appWith();
});

describe('plugin routes', () => {
  it('answer under /plugins/<name>, behind the API prefix', async () => {
    const res = await app.request('/api/plugins/echo/open');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'anyone' });
  });

  it('use requireAuth the way BrainStack routes do', async () => {
    expect((await app.request('/api/plugins/echo/me')).status).toBe(401);

    const { id, cookie } = await app.signIn('ana');
    const bySession = await app.request('/api/plugins/echo/me', { headers: { cookie } });
    expect(await bySession.json()).toEqual({ userId: id });

    const { token } = await app.services.apiKeys.create(id, 'key');
    const byKey = await app.request('/api/plugins/echo/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await byKey.json()).toEqual({ userId: id });
  });

  it('cannot answer for a BrainStack route', async () => {
    const res = await app.request('/api/health');
    expect(await res.json()).not.toHaveProperty('hijacked');
  });

  it('are rate limited per client address', async () => {
    app = appWith(2);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.request('/api/plugins/echo/open')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('cap request bodies like the small routes do', async () => {
    const res = await app.request('/api/plugins/echo/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe('plugin tRPC procedures', () => {
  it('are served as plugins.<name>.*, next to the built-in ones', async () => {
    const hello = await trpcGet('plugins.echo.hello');
    expect(hello.status).toBe(200);
    expect(await data(hello)).toBe('hello');
    expect((await trpcGet('auth.me')).status).toBe(200);
  });

  it('get the same checks as protectedProcedure', async () => {
    expect((await trpcGet('plugins.echo.whoami')).status).toBe(401);

    const { id, cookie } = await app.signIn('ana');
    expect(await data(await trpcGet('plugins.echo.whoami', { headers: { cookie } }))).toBe(id);

    const { token } = await app.services.apiKeys.create(id, 'reader', ['notes:read']);
    const refused = await trpcPost(
      'plugins.echo.touch',
      { path: 'a.md' },
      { authorization: `Bearer ${token}` },
    );
    expect(refused.status).toBe(403);
  });
});

describe('plugin names', () => {
  it('must be URL- and path-safe and used once', () => {
    expect(() => assertPluginNames([{ name: 'sso' }, { name: 'audit-log' }])).not.toThrow();
    for (const name of ['', 'SSO', 'a.b', 'a/b', '-x', 'x'.repeat(41)]) {
      expect(() => assertPluginNames([{ name }]), name).toThrow(/must match/);
    }
    expect(() => assertPluginNames([{ name: 'sso' }, { name: 'sso' }])).toThrow(/twice/);
  });
});
