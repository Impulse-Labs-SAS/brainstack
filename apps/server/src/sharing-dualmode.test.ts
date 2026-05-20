// Smoke test dual-mode: levanta el Hono app en ambos deployments y
// verifica el gating de sharing.* y /api/config. No usa la red ni
// disco real (better-sqlite3 in-memory + tmp dir).

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { ApiKeyService } from './services/ApiKeyService.js';
import { AuthService } from './services/AuthService.js';
import { CapturingEmailSender } from './services/EmailSender.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { IndexService } from './services/IndexService.js';
import { InviteService } from './services/InviteService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService, type Deployment } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';
import { buildApp } from './http/app.js';
import { buildMcpServer } from './mcp/server.js';

const logger = pino({ level: 'silent' });

interface Harness {
  bs: BrainStackDatabase;
  root: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

async function buildHarness(deployment: Deployment): Promise<Harness> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'bs-dual-'));
  const bs = openDatabase(':memory:');
  const vaultCfg = { deployment, notesDirAbs: root };
  const index = new IndexService({ root, db: bs, logger, vaultCfg });
  const notes = new NoteService({ cfg: vaultCfg, db: bs, index });
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
  const crossOwner = new CrossOwnerReader({
    sharing,
    vaultCfg: { deployment, notesDirAbs: root },
  });

  await index.bootstrap();

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
    resolveUserForApiKey: (k) => auth.getUser(k.userId)!,
    rateLimitPerMinute: 1000,
    secureCookies: false,
    corsOrigins: [],
    appHome: 'http://test',
    exposeDevTokens: false,
    publicConfig: {
      deployment,
      features: { sharing: deployment === 'hosted' },
    },
  });

  return {
    bs,
    root,
    fetch: (p, init) => Promise.resolve(app.fetch(new Request(`http://test${p}`, init))),
  };
}

async function tearDown(h: Harness): Promise<void> {
  h.bs.close();
  await fsp.rm(h.root, { recursive: true, force: true });
}

describe('dual-mode: /api/config', () => {
  let selfHost: Harness;
  let hosted: Harness;

  beforeEach(async () => {
    selfHost = await buildHarness('self-host');
    hosted = await buildHarness('hosted');
  });

  afterEach(async () => {
    await tearDown(selfHost);
    await tearDown(hosted);
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
