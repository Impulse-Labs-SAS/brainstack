// createBrainStack with plugins, over an in-process database: a plugin's
// migrations run after BrainStack's and once, its setup runs after them and
// before its routes are built, and a plugin that fails to set up fails the boot.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBrainStack } from './boot.js';
import { _resetConfigForTests, loadConfig } from './config/env.js';
import type { AuthBindings } from './http/middleware/auth.js';
import { pluginMigrations, type BrainStackPlugin } from './plugin.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const logger = pino({ level: 'silent' });
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  process.env.DATABASE_URL ??= 'postgres://unused/unused';
  _resetConfigForTests();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await database.db.execute(sql.raw('DROP TABLE IF EXISTS demo_items'));
  await database.db.execute(
    sql.raw(`DELETE FROM _brainstack_migrations WHERE name LIKE 'plugin:%'`),
  );
});

const boot = (plugins: BrainStackPlugin[]) =>
  createBrainStack({
    config: loadConfig(),
    logger,
    plugins,
    // The suite owns the database; the app must not close it.
    database: { db: database.db, close: async () => undefined },
  });

/** A plugin with a table, a service built at setup, and a route that uses it. */
function demoPlugin(order: string[]): BrainStackPlugin {
  let count: (() => Promise<number>) | null = null;
  return {
    name: 'demo',
    migrations: [
      {
        name: '0001_items',
        statements: ['CREATE TABLE IF NOT EXISTS demo_items (id TEXT PRIMARY KEY)'],
      },
    ],
    async setup({ db, services }) {
      order.push('setup');
      // Its table is already there, and so are BrainStack's services.
      expect(services.notes).toBeDefined();
      await db.execute(sql.raw(`INSERT INTO demo_items (id) VALUES ('a') ON CONFLICT DO NOTHING`));
      count = async () => {
        const res = await db.execute<{ n: number }>(
          sql.raw('SELECT count(*)::int AS n FROM demo_items'),
        );
        return res.rows[0]!.n;
      };
    },
    routes() {
      order.push('routes');
      const routes = new Hono<AuthBindings>();
      routes.get('/count', async (c) => c.json({ count: await count!() }));
      return routes;
    },
  };
}

const ledger = async () =>
  (
    await database.db.execute<{ name: string }>(
      sql.raw(`SELECT name FROM _brainstack_migrations WHERE name LIKE 'plugin:%' ORDER BY name`),
    )
  ).rows.map((r) => r.name);

describe('plugin migrations and setup', () => {
  it('run in order at boot: migrations, setup, then routes', async () => {
    const order: string[] = [];
    const bs = await boot([demoPlugin(order)]);
    expect(order).toEqual(['setup', 'routes']);
    expect(await ledger()).toEqual(['plugin:demo:0001_items']);

    const res = await bs.app.fetch(new Request('http://test/api/plugins/demo/count'));
    expect(await res.json()).toEqual({ count: 1 });
  });

  it('apply a migration once, however many boots', async () => {
    await boot([demoPlugin([])]);
    await database.db.execute(sql.raw(`INSERT INTO demo_items (id) VALUES ('b')`));
    await boot([demoPlugin([])]);
    // Re-running the CREATE would have been harmless; re-recording would not.
    expect(await ledger()).toEqual(['plugin:demo:0001_items']);
    const rows = await database.db.execute<{ n: number }>(
      sql.raw('SELECT count(*)::int AS n FROM demo_items'),
    );
    expect(rows.rows[0]!.n).toBe(2);
  });

  it('leave the ledger alone when no plugin is passed', async () => {
    const bs = await boot([]);
    expect(await ledger()).toEqual([]);
    expect((await bs.app.fetch(new Request('http://test/api/health'))).status).toBe(200);
  });

  it('let a plugin recognise bearer tokens of its own on /mcp', async () => {
    let userId = '';
    const sso: BrainStackPlugin = {
      name: 'sso',
      async setup({ services }) {
        userId = (await services.auth.ensureUser('frodo@example.com')).id;
      },
      authenticate: (token) =>
        token === 'signed-elsewhere' ? { userId, scopes: ['notes:read'], ref: 'test' } : null,
    };
    const bs = await boot([sso]);
    const list = (authorization: string) =>
      bs.app.fetch(
        new Request('http://test/api/mcp', {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }),
      );
    expect((await list('Bearer signed-elsewhere')).status).toBe(200);
    expect((await list('Bearer forged')).status).toBe(401);
  });

  it('fail the boot when a setup throws', async () => {
    const broken: BrainStackPlugin = {
      name: 'broken',
      setup() {
        throw new Error('no licence');
      },
    };
    await expect(boot([broken])).rejects.toThrow('no licence');
  });
});

describe('pluginMigrations', () => {
  it('records each under plugin:<name>:<migration>, in plugin order', () => {
    const list = pluginMigrations([
      { name: 'a', migrations: [{ name: '0001', statements: ['SELECT 1'] }] },
      { name: 'b' },
      { name: 'c', migrations: [{ name: '0001', statements: [] }] },
    ]);
    expect(list.map((m) => m.name)).toEqual(['plugin:a:0001', 'plugin:c:0001']);
  });

  it('refuses a repeated or empty migration name', () => {
    const m = { name: '0001', statements: [] };
    expect(() => pluginMigrations([{ name: 'a', migrations: [m, m] }])).toThrow(/twice/);
    expect(() =>
      pluginMigrations([{ name: 'a', migrations: [{ name: '', statements: [] }] }]),
    ).toThrow(/no name/);
  });
});
