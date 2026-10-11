// The whole HTTP app over an in-process Postgres, the way a client meets it:
// every middleware, the route prefix, CORS and the limiters. Route tests that
// build one router alone cannot see what the chain in front of it does.

import pino from 'pino';

import { buildApp, type BuildAppOptions } from './http/app.js';
import { SESSION_COOKIE } from './http/middleware/auth.js';
import { buildMcpServer } from './mcp/server.js';
import { CapturingEmailSender } from './services/EmailSender.js';
import type { TestDatabase } from './services/testDb.js';
import { buildServices, type Services } from './wiring.js';

export interface TestApp {
  services: Services;
  email: CapturingEmailSender;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** A verified account with a session; `cookie` is ready for a header. */
  signIn(id: string): Promise<{ id: string; email: string; token: string; cookie: string }>;
}

export const TEST_BASE_PATH = '/api';

export function buildTestApp(
  database: TestDatabase,
  overrides: Partial<BuildAppOptions> = {},
): TestApp {
  const logger = pino({ level: 'silent' });
  const email = new CapturingEmailSender();
  const services = buildServices({
    db: database.db,
    logger,
    publicOrigin: 'http://test',
    authorizedEmails: new Set(),
    apiBasePath: TEST_BASE_PATH,
    emailSender: email,
  });

  const app = buildApp({
    logger,
    auth: services.auth,
    apiKeys: services.apiKeys,
    notes: services.notes,
    search: services.search,
    sharing: services.sharing,
    invites: services.invites,
    crossOwner: services.crossOwner,
    crawls: services.crawls,
    totp: services.totp,
    resolveUserForApiKey: services.resolveUserForApiKey,
    rateLimitPerMinute: 1000,
    secureCookies: false,
    corsOrigins: [],
    appHome: 'http://test',
    oauth: { service: services.oauthProvider, issuer: 'http://test' },
    basePath: TEST_BASE_PATH,
    buildMcpServer: (principal) =>
      buildMcpServer({
        notes: services.notes,
        search: services.search,
        sharing: services.sharing,
        crossOwner: services.crossOwner,
        auth: services.auth,
        invites: services.invites,
        crawls: services.crawls,
        logger,
        principal,
      }),
    ...overrides,
  });

  return {
    services,
    email,
    request: (path, init) => Promise.resolve(app.fetch(new Request(`http://test${path}`, init))),
    signIn: async (id) => {
      const address = `${id}@brain.test`;
      const user = await services.auth.ensureUser(address);
      const { token } = await services.auth.createSession(user.id);
      return { id: user.id, email: address, token, cookie: `${SESSION_COOKIE}=${token}` };
    },
  };
}
