import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';

import { pgSchema } from '@brainstack/core/pg';
import { eq } from 'drizzle-orm';

import { GoogleOAuthService } from './GoogleOAuthService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

let database: TestDatabase;
let now = 1_700_000_000_000;
let svc: GoogleOAuthService;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  now = 1_700_000_000_000;
  svc = new GoogleOAuthService({
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://brain.test/auth/google/callback',
    db: database.db,
    now: () => now,
  });
});

describe('GoogleOAuthService state lifecycle', () => {
  it('stores state + code_verifier and builds an authorization URL', async () => {
    const { url, state } = await svc.startAuthorization('/dashboard');
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(url).toContain('code_challenge=');
    expect(url).toContain(`state=${state}`);

    const [row] = await database.db
      .select()
      .from(pgSchema.oauthStates)
      .where(eq(pgSchema.oauthStates.state, state));
    expect(row?.redirectTo).toBe('/dashboard');
  });

  it('rejects a callback whose state cookie does not match the query', async () => {
    const { state } = await svc.startAuthorization();
    await expect(
      svc.completeAuthorization({ state, code: 'x', stateCookie: 'mismatch' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an unknown state', async () => {
    await expect(
      svc.completeAuthorization({ state: 'unknown', code: 'x', stateCookie: 'unknown' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects expired state', async () => {
    const { state } = await svc.startAuthorization();
    now += 11 * 60 * 1000;
    await expect(
      svc.completeAuthorization({ state, code: 'x', stateCookie: state }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // The expired row should be gone.
    const [row] = await database.db
      .select()
      .from(pgSchema.oauthStates)
      .where(eq(pgSchema.oauthStates.state, state));
    expect(row).toBeUndefined();
  });
});
