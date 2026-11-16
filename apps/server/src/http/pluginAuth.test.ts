// Bearer tokens a plugin recognises, through the whole app: they authenticate
// where OAuth tokens do (MCP, plugin routes) and nowhere else, carry the
// scopes the plugin gives them, and never take the place of a credential
// BrainStack issued.

import { Hono } from 'hono';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../services/testDb.js';
import { buildTestApp, type TestApp } from '../testApp.js';

import type { PluginCredential } from '../plugin.js';
import type { AuthBindings, BearerPlugin } from './middleware/auth.js';

let database: TestDatabase;
let app: TestApp;
let userId: string;
let asked: string[];

/**
 * A plugin that accepts `ext.<scope>.<userId>` — a stand-in for a signed
 * token another system issues — and throws on `ext.boom`.
 */
const extPlugin: BearerPlugin = {
  name: 'ext',
  authenticate(token): PluginCredential | null {
    asked.push(token);
    if (token === 'ext.boom') throw new Error('broken verifier');
    const [prefix, scope, id] = token.split('.');
    if (prefix !== 'ext' || !scope || !id) return null;
    return {
      userId: id,
      scopes: scope === 'read' ? ['notes:read'] : ['notes:write'],
      ref: 'signed',
    };
  },
};

function appWith(plugins: BearerPlugin[]): TestApp {
  return buildTestApp(database, {
    bearerPlugins: plugins,
    pluginRoutes: ({ requireAuth }) => {
      const routes = new Hono<AuthBindings>();
      routes.use('/me', requireAuth);
      routes.get('/me', (c) => c.json({ userId: c.var.principal.user.id }));
      return [{ name: 'ext', routes }];
    },
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  asked = [];
  app = appWith([extPlugin]);
  userId = (await app.signIn('frodo')).id;
  await app.services.notes.create(userId, 'Atlas/plan.md', '# Atlas plan');
});

const mcp = (token: string, method: string, params: Record<string, unknown> = {}) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const call = async (token: string, name: string, args: Record<string, unknown>) =>
  (await mcp(token, 'tools/call', { name, arguments: args })).text();

describe('a bearer token a plugin recognises', () => {
  it('authenticates on MCP as the account the plugin names', async () => {
    expect(await call(`ext.write.${userId}`, 'get_note', { path: 'Atlas/plan.md' })).toContain(
      'Atlas plan',
    );
    await call(`ext.write.${userId}`, 'create_note', { path: 'Atlas/new.md', content: '# New' });
    expect(await app.services.notes.exists(userId, 'Atlas/new.md')).toBe(true);
  });

  it('carries the scopes the plugin gives it: read-only refuses every change', async () => {
    expect(await call(`ext.read.${userId}`, 'get_note', { path: 'Atlas/plan.md' })).toContain(
      'Atlas plan',
    );
    expect(
      await call(`ext.read.${userId}`, 'create_note', { path: 'Atlas/x.md', content: 'x' }),
    ).toContain('read-only');
    expect(await app.services.notes.exists(userId, 'Atlas/x.md')).toBe(false);
  });

  it('authenticates on a plugin route behind requireAuth', async () => {
    const res = await app.request('/api/plugins/ext/me', {
      headers: { authorization: `Bearer ext.read.${userId}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId });
  });

  it('does not authenticate on the web app’s tRPC', async () => {
    const input = encodeURIComponent(
      JSON.stringify(superjson.serialize({ path: 'Atlas/plan.md' })),
    );
    const res = await app.request(`/api/trpc/notes.get?input=${input}`, {
      headers: { authorization: `Bearer ext.write.${userId}` },
    });
    expect(res.status).toBe(401);
  });

  it('is refused when the plugin does not recognise it', async () => {
    expect((await mcp('someone-elses-token', 'tools/list')).status).toBe(401);
  });

  it('is refused when it names an account that does not exist', async () => {
    expect((await mcp('ext.write.no-such-user', 'tools/list')).status).toBe(401);
  });

  it('is refused, not a 500, when the plugin throws', async () => {
    expect((await mcp('ext.boom', 'tools/list')).status).toBe(401);
  });

  it('never stands in for a credential BrainStack issued', async () => {
    const key = (await app.services.apiKeys.create(userId, 'mine', ['notes:read'])).token;
    expect((await mcp(key, 'tools/list')).status).toBe(200);
    expect(asked).toEqual([]);
  });

  it('asks the plugins in order, and the first to answer wins', async () => {
    const order: string[] = [];
    const first: BearerPlugin = {
      name: 'first',
      authenticate: () => {
        order.push('first');
        return null;
      },
    };
    const second: BearerPlugin = {
      name: 'second',
      authenticate: async (token) => {
        order.push('second');
        return token === 'mine' ? { userId, scopes: ['notes:read'] } : null;
      },
    };
    app = appWith([first, second, extPlugin]);
    expect((await mcp('mine', 'tools/list')).status).toBe(200);
    expect(order).toEqual(['first', 'second']);
    expect(asked).toEqual([]);
  });
});
