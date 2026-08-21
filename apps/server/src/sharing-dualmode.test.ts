// Dual-mode smoke test: boots the Hono app in both deployments and checks the
// gating of sharing and /api/config. No network and no disk — the database is
// Postgres in-process.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';

import { ApiKeyService } from './services/ApiKeyService.js';
import { AuthService } from './services/AuthService.js';
import { CapturingEmailSender } from './services/EmailSender.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { InviteService } from './services/InviteService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService, type Deployment } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';
import { buildApp } from './http/app.js';
import { buildMcpServer } from './mcp/server.js';
import { createTestDatabase, type TestDatabase } from './services/testDb.js';

const logger = pino({ level: 'silent' });

interface Harness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildHarness(deployment: Deployment, bs: TestDatabase['db']): Harness {
  const vaultCfg = { deployment };
  const notes = new NoteService({ cfg: vaultCfg, db: bs });
  const search = new SearchService({ db: bs, cfg: vaultCfg });
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
  const sharing = new SharingService({ db: bs, deployment });
  const invites = new InviteService({
    db: bs,
    email,
    sharing,
    publicOrigin: 'http://test',
  });
  const crossOwner = new CrossOwnerReader({ sharing, vaultCfg, db: bs });

  const app = buildApp({
    buildMcpServer: (principal) =>
      buildMcpServer({ notes, search, sharing, logger, principal }),
    logger,
    auth,
    apiKeys,
    notes,
    search,
    sharing,
    invites,
    crossOwner,
    resolveUserForApiKey: async (k) => (await auth.findUserById(k.userId ?? ''))!,
    rateLimitPerMinute: 1000,
    secureCookies: false,
    corsOrigins: [],
    appHome: 'http://test',
    exposeDevTokens: false,
    publicConfig: {
      deployment,
      features: { sharing: deployment === 'hosted' },
    },
    vaultCfg,
  });

  return {
    fetch: (p, init) => Promise.resolve(app.fetch(new Request(`http://test${p}`, init))),
  };
}

describe('dual-mode: /api/config', () => {
  let database: TestDatabase;
  let selfHost: Harness;
  let hosted: Harness;

  beforeAll(async () => {
    database = await createTestDatabase();
    selfHost = buildHarness('self-host', database.db);
    hosted = buildHarness('hosted', database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  it('reporta deployment y feature flag por modo', async () => {
    const a = await (await selfHost.fetch('/api/config')).json();
    expect(a).toEqual({
      deployment: 'self-host',
      features: { sharing: false },
    });

    const b = await (await hosted.fetch('/api/config')).json();
    expect(b).toEqual({
      deployment: 'hosted',
      features: { sharing: true },
    });
  });

  it('endpoint /api/config no requiere auth en ningún modo', async () => {
    expect((await selfHost.fetch('/api/config')).status).toBe(200);
    expect((await hosted.fetch('/api/config')).status).toBe(200);
  });
});
