// Google sign-in through the whole app, under the /api prefix every
// deployment uses. The service is a stand-in: what is under test is the
// route — which cookie it sets, where, and what the callback does with it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GoogleOAuthService } from '../services/GoogleOAuthService.js';
import { createTestDatabase, type TestDatabase } from '../services/testDb.js';
import { buildTestApp } from '../testApp.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.reset();
});

/** Answers like Google would, and checks the state cookie like the real service. */
function fakeGoogle(): GoogleOAuthService {
  return {
    startAuthorization: async () => ({ url: 'https://accounts.google.test/auth', state: 'st4te' }),
    completeAuthorization: async ({ state, stateCookie }: { state: string; stateCookie: string | null }) => {
      if (stateCookie !== state) throw new Error('state mismatch');
      return {
        profile: {
          googleId: 'g-1',
          email: 'first@brain.test',
          emailVerified: true,
          name: 'First',
          picture: null,
        },
        redirectTo: null,
      };
    },
  } as unknown as GoogleOAuthService;
}

describe('Google sign-in under /api', () => {
  it('scopes the state cookie to the path its callback is on', async () => {
    const app = buildTestApp(database, { google: fakeGoogle() });
    const res = await app.request('/api/auth/google');
    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('bs_oauth_state=st4te');
    expect(cookie).toContain('Path=/api/auth');
  });

  it('signs in on the callback when the cookie comes back', async () => {
    const app = buildTestApp(database, { google: fakeGoogle() });
    const res = await app.request('/api/auth/google/callback?code=c&state=st4te', {
      headers: { cookie: 'bs_oauth_state=st4te' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain('error=');
    expect(res.headers.get('set-cookie')).toContain('bs_session=');
  });

  it('is announced in /config only when it is configured', async () => {
    const withGoogle = buildTestApp(database, { google: fakeGoogle() });
    const without = buildTestApp(database);
    const on = (await (await withGoogle.request('/api/config')).json()) as {
      features: { google: boolean };
    };
    const off = (await (await without.request('/api/config')).json()) as {
      features: { google: boolean };
    };
    expect(on.features.google).toBe(true);
    expect(off.features.google).toBe(false);
  });
});
