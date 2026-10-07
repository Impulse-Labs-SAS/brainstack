// Smoke test for the route prefix: boots the Hono app behind `/api` and checks
// that every surface answers there and nowhere else. No network and no disk —
// the database is Postgres in-process.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';

import { ApiKeyService } from './services/ApiKeyService.js';
import { AuthService } from './services/AuthService.js';
import { CapturingEmailSender } from './services/EmailSender.js';
import { CrawlHistoryService } from './services/CrawlHistoryService.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { InviteService } from './services/InviteService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';
import { buildApp } from './http/app.js';
import { buildMcpServer } from './mcp/server.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const logger = pino({ level: 'silent' });

interface Harness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildHarness(bs: TestDatabase['db'], basePath?: string): Harness {
  const notes = new NoteService({ db: bs });
  const search = new SearchService({ db: bs });
  const email = new CapturingEmailSender();
  const totp = new TotpService({ db: bs, issuer: 'BrainStack' });
  const auth = new AuthService({
    db: bs,
    email,
    logger,
    publicOrigin: 'http://test',
    authorizedEmails: new Set(),
    totp,
  });
  const apiKeys = new ApiKeyService({ db: bs });
  const sharing = new SharingService({ db: bs });
  const invites = new InviteService({
    db: bs,
    email,
    sharing,
    publicOrigin: 'http://test',
  });
  const crossOwner = new CrossOwnerReader({ sharing, db: bs });
  const crawls = new CrawlHistoryService({ db: bs, retentionDays: 30 });

  const app = buildApp({
    buildMcpServer: (principal) =>
      buildMcpServer({ notes, search, sharing, crossOwner, auth, invites, crawls, logger, principal }),
    logger,
    auth,
    apiKeys,
    notes,
    search,
    sharing,
    invites,
    crossOwner,
    crawls,
    resolveUserForApiKey: async (k) => (await auth.findUserById(k.userId ?? ''))!,
    rateLimitPerMinute: 1000,
    secureCookies: false,
    corsOrigins: [],
    appHome: 'http://test',
    ...(basePath ? { basePath } : {}),
  });

  return {
    fetch: (p, init) => Promise.resolve(app.fetch(new Request(`http://test${p}`, init))),
  };
}

/**
 * Netlify routes one path pattern to one function, so deployed the whole API
 * answers under `/api`. Development mounts it the same way: a layout that only
 * exists in production is a layout nobody tests.
 */
describe('basePath', () => {
  let db: TestDatabase;
  let app: Harness;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildHarness(db.db, '/api');
  });

  afterAll(async () => {
    await db.close();
  });

  it('moves every route behind the prefix', async () => {
    expect((await app.fetch('/api/config')).status).toBe(200);
    expect((await app.fetch('/api/health')).status).toBe(200);
    // No session, but routed: the 401 says the route exists.
    expect((await app.fetch('/api/trpc/notes.tree?input=%7B%7D')).status).toBe(401);
  });

  it('answers nothing without the prefix', async () => {
    expect((await app.fetch('/config')).status).toBe(404);
    expect((await app.fetch('/health')).status).toBe(404);
  });

  it('serves MCP under the prefix too', async () => {
    // 401 rather than 404: the route is there, the credential is missing.
    const res = await app.fetch('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
