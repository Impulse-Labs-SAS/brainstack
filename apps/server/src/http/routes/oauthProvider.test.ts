// The OAuth provider, walked the way an MCP host walks it: discovery, dynamic
// registration, authorize + consent, the token exchange, and finally the MCP
// endpoint accepting what came out. The happy path runs the whole distance;
// the rest of the suite is every place the flow must refuse to continue —
// wrong verifier, replayed code, foreign redirect URI — because those refusals
// are the security model.

import { createHash } from 'node:crypto';

import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildMcpServer } from '../../mcp/server.js';
import { ApiKeyService } from '../../services/ApiKeyService.js';
import { AuthService, type User } from '../../services/AuthService.js';
import { CrossOwnerReader } from '../../services/CrossOwnerReader.js';
import { CapturingEmailSender } from '../../services/EmailSender.js';
import { InviteService } from '../../services/InviteService.js';
import { NoteService } from '../../services/NoteService.js';
import { OAuthProviderService } from '../../services/OAuthProviderService.js';
import { SearchService } from '../../services/SearchService.js';
import { SharingService } from '../../services/SharingService.js';
import { createTestDatabase, type TestDatabase } from '../../services/testDb.js';
import { buildApp } from '../app.js';

const { users } = pgSchema;

const logger = pino({ level: 'silent' });
const ISSUER = 'https://brain.test';
const REDIRECT_URI = 'https://client.test/callback';
const VERIFIER = 'a-code-verifier-that-is-long-enough-for-rfc-7636';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');


let database: TestDatabase;
let auth: AuthService;
let oauth: OAuthProviderService;
let app: ReturnType<typeof buildApp>;
let sessionCookie: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  const db = database.db;

  await db.insert(users).values({
    id: 'sam',
    email: 'user@brain.test',
    emailVerified: true,
    createdAt: Date.now(),
    updatedAt: 0,
  });

  auth = new AuthService({
    db,
    email: new CapturingEmailSender(),
    logger,
    publicOrigin: ISSUER,
    authorizedEmails: new Set(['user@brain.test']),
  });
  const apiKeys = new ApiKeyService({ db });
  oauth = new OAuthProviderService({ db });
  const notes = new NoteService({ db });
  const search = new SearchService({ db });
  const sharing = new SharingService({ db });
  const crossOwner = new CrossOwnerReader({ db, sharing });
  const invites = new InviteService({
    db,
    sharing,
    email: new CapturingEmailSender(),
    publicOrigin: ISSUER,
  });

  app = buildApp({
    logger,
    auth,
    apiKeys,
    notes,
    search,
    sharing,
    invites,
    crossOwner,
    resolveUserForApiKey: async (key): Promise<User> => {
      const user = await auth.findUserById(key.userId ?? '');
      if (!user) throw new Error('no user behind key');
      return user;
    },
    rateLimitPerMinute: 1000,
    secureCookies: false,
    corsOrigins: [],
    appHome: ISSUER,
    oauth: { service: oauth, issuer: ISSUER },
    buildMcpServer: (principal) =>
      buildMcpServer({ notes, search, sharing, crossOwner, auth, invites, logger, principal }),
  });

  const session = await auth.createSession('sam');
  sessionCookie = `bs_session=${session.token}`;
});

/** Register a public client and return its id. */
async function registerClient(): Promise<string> {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test MCP host', redirect_uris: [REDIRECT_URI] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st4te',
    ...extra,
  });
  return `/oauth/authorize?${params.toString()}`;
}

/** Run authorize + consent and return the code from the redirect. */
async function obtainCode(clientId: string): Promise<string> {
  const consent = await app.request(authorizeUrl(clientId), {
    headers: { Cookie: sessionCookie },
  });
  expect(consent.status).toBe(200);

  const decided = await app.request('/oauth/authorize/decision', {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      state: 'st4te',
      scope: 'mcp',
      resource: '',
      decision: 'allow',
    }),
  });
  expect(decided.status).toBe(302);
  const location = new URL(decided.headers.get('location') ?? '');
  expect(location.origin).toBe('https://client.test');
  expect(location.searchParams.get('state')).toBe('st4te');
  expect(location.searchParams.get('iss')).toBe(ISSUER);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();
  return code as string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function exchange(
  clientId: string,
  code: string,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      ...overrides,
    }),
  });
}

describe('discovery', () => {
  it('serves protected resource metadata, suffixed variant included', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.authorization_servers).toEqual([ISSUER]);
      expect(body.resource).toBe(`${ISSUER}/mcp`);
    }
  });

  it('serves authorization server metadata with PKCE and registration', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('keeps metadata at the root when the app mounts under /api', async () => {
    const prefixed = buildApp({
      logger,
      auth,
      apiKeys: new ApiKeyService({ db: database.db }),
      notes: new NoteService({ db: database.db }),
      search: new SearchService({ db: database.db }),
      sharing: new SharingService({ db: database.db }),
      invites: new InviteService({
        db: database.db,
        sharing: new SharingService({ db: database.db }),
        email: new CapturingEmailSender(),
        publicOrigin: ISSUER,
      }),
      crossOwner: new CrossOwnerReader({
        db: database.db,
        sharing: new SharingService({ db: database.db }),
      }),
      resolveUserForApiKey: async (): Promise<User> => {
        throw new Error('unused');
      },
      rateLimitPerMinute: 1000,
      secureCookies: false,
      corsOrigins: [],
      appHome: ISSUER,
      oauth: { service: oauth, issuer: ISSUER },
      basePath: '/api',
      buildMcpServer: () => {
        throw new Error('unused');
      },
    });

    const meta = await prefixed.request('/.well-known/oauth-authorization-server');
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as Record<string, unknown>;
    expect(body.authorization_endpoint).toBe(`${ISSUER}/api/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/api/oauth/token`);

    const resource = await prefixed.request('/.well-known/oauth-protected-resource');
    expect(((await resource.json()) as Record<string, unknown>).resource).toBe(
      `${ISSUER}/api/mcp`,
    );
  });

  it('answers 401 on /mcp with the discovery challenge', async () => {
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(`${ISSUER}/.well-known/oauth-protected-resource`);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'claude.ai', redirect_uris: [REDIRECT_URI] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('accepts loopback redirect URIs and refuses plain http elsewhere', async () => {
    const ok = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/callback'] }),
    });
    expect(ok.status).toBe(201);

    const bad = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.test/callback'] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Record<string, unknown>).error).toBe('invalid_redirect_uri');
  });

  it('accepts a custom-scheme redirect URI (Cursor deep link)', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Cursor',
        redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'],
      }),
    });
    expect(res.status).toBe(201);
  });

  it('refuses a dangerous scheme as redirect URI', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('authorize', () => {
  it('redirects to login when there is no session, carrying the way back', async () => {
    const clientId = await registerClient();
    const res = await app.request(authorizeUrl(clientId));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    const back = location.searchParams.get('redirect_to') ?? '';
    expect(back.startsWith('/oauth/authorize?')).toBe(true);
    expect(back).toContain('code_challenge');
  });

  it('refuses an unregistered redirect_uri with a page, never a redirect', async () => {
    const clientId = await registerClient();
    const res = await app.request(
      authorizeUrl(clientId, { redirect_uri: 'https://evil.test/steal' }),
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('narrows an unknown scope instead of rejecting it', async () => {
    const clientId = await registerClient();
    // A client that asks for scopes we do not grant should still reach consent,
    // downscoped — not hit a dead end.
    const res = await app.request(authorizeUrl(clientId, { scope: 'mcp openid profile' }), {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The consent form carries the narrowed scope, only 'mcp'.
    expect(html).toContain('value="mcp"');
    expect(html).not.toContain('openid');
  });

  it('requires PKCE S256', async () => {
    const clientId = await registerClient();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'st4te',
    });
    const res = await app.request(`/oauth/authorize?${params.toString()}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('st4te');
  });

  it('a denied consent reports access_denied to the client', async () => {
    const clientId = await registerClient();
    const res = await app.request('/oauth/authorize/decision', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: CHALLENGE,
        state: 'st4te',
        scope: 'mcp',
        resource: '',
        decision: 'deny',
      }),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('the consent decision requires a session', async () => {
    const clientId = await registerClient();
    const res = await app.request('/oauth/authorize/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: CHALLENGE,
        decision: 'allow',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('token exchange', () => {
  it('runs the whole flow: code → tokens → authenticated MCP call', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);

    const res = await exchange(clientId, code);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token.startsWith('bsoa_')).toBe(true);
    expect(tokens.refresh_token.startsWith('bsor_')).toBe(true);
    expect(tokens.scope).toBe('mcp');

    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    expect(mcp.status).toBe(200);
  });

  it('refuses the wrong PKCE verifier', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    const res = await exchange(clientId, code, { code_verifier: 'not-the-one-that-started-this' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('invalid_grant');
  });

  it('a code is single-use — and the failed retry burns it for good', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    expect((await exchange(clientId, code)).status).toBe(200);
    expect((await exchange(clientId, code)).status).toBe(400);
  });

  it('refuses a redirect_uri that differs from the one authorized', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    const res = await exchange(clientId, code, { redirect_uri: 'https://client.test/other' });
    expect(res.status).toBe(400);
  });

  it('refuses a code issued to another client', async () => {
    const clientId = await registerClient();
    const otherId = await registerClient();
    const code = await obtainCode(clientId);
    const res = await exchange(otherId, code);
    expect(res.status).toBe(400);
  });

  it('rotates on refresh and kills the replayed pair', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    const first = (await (await exchange(clientId, code)).json()) as TokenResponse;

    const refresh = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: first.refresh_token,
      }),
    });
    expect(refresh.status).toBe(200);
    const second = (await refresh.json()) as TokenResponse;
    expect(second.access_token).not.toBe(first.access_token);

    // The rotated-out pair is dead: the old access token no longer opens /mcp…
    const stale = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(stale.status).toBe(401);

    // …while the new pair works. (Replaying the old refresh token now poisons
    // the whole family — that stronger behavior has its own test above.)
    const fresh = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${second.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    expect(fresh.status).toBe(200);
  });

  it('replaying a rotated refresh token burns the whole family', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    const first = (await (await exchange(clientId, code)).json()) as TokenResponse;

    // Legit rotation.
    const rot = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: first.refresh_token,
      }),
    });
    const second = (await rot.json()) as TokenResponse;

    // A thief replays the now-rotated first refresh token. It must fail…
    const replay = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: first.refresh_token,
      }),
    });
    expect(replay.status).toBe(400);

    // …and the replay must poison the family: the legit second pair is dead too.
    const afterPoison = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: second.refresh_token,
      }),
    });
    expect(afterPoison.status).toBe(400);
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${second.access_token}` },
    });
    expect(mcp.status).toBe(401);
  });

  it('revokes a grant via the token, killing access and refresh (RFC 7009)', async () => {
    const clientId = await registerClient();
    const code = await obtainCode(clientId);
    const tokens = (await (await exchange(clientId, code)).json()) as TokenResponse;

    const revoke = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.access_token }),
    });
    expect(revoke.status).toBe(200);

    // Access token no longer opens /mcp…
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(mcp.status).toBe(401);

    // …and its refresh sibling is dead too (revoke kills the family).
    const refresh = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(refresh.status).toBe(400);
  });

  it('revoke is silent on an unknown token', async () => {
    const res = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'bsoa_nope' }),
    });
    expect(res.status).toBe(200);
  });

  it('advertises the revocation endpoint', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
  });

  it('refuses unknown grant types', async () => {
    const clientId = await registerClient();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: clientId }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('unsupported_grant_type');
  });
});
