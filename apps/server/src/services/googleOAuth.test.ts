import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';

import { GoogleOAuthService } from './GoogleOAuthService.js';

let bs: BrainStackDatabase;
let now = 1_700_000_000_000;
let svc: GoogleOAuthService;

beforeEach(() => {
  bs = openDatabase(':memory:');
  now = 1_700_000_000_000;
  svc = new GoogleOAuthService({
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://brain.test/auth/google/callback',
    db: bs,
    now: () => now,
  });
});

afterEach(() => {
  bs.close();
});

describe('GoogleOAuthService state lifecycle', () => {
  it('stores state + code_verifier and builds an authorization URL', () => {
    const { url, state } = svc.startAuthorization('/dashboard');
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(url).toContain('code_challenge=');
    expect(url).toContain(`state=${state}`);

    const row = bs.sqlite
      .prepare<[string], { state: string; redirect_to: string | null }>(
        'SELECT state, redirect_to FROM oauth_states WHERE state = ?',
      )
      .get(state);
    expect(row?.redirect_to).toBe('/dashboard');
  });

  it('rejects a callback whose state cookie does not match the query', async () => {
    const { state } = svc.startAuthorization();
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
    const { state } = svc.startAuthorization();
    now += 11 * 60 * 1000;
    await expect(
      svc.completeAuthorization({ state, code: 'x', stateCookie: state }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // The expired row should be gone.
    const row = bs.sqlite
      .prepare('SELECT state FROM oauth_states WHERE state = ?')
      .get(state);
    expect(row).toBeUndefined();
  });
});
