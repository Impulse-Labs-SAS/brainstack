// Google OAuth (Authorization Code with PKCE) wrapped in a service so the
// HTTP layer stays thin. State + code_verifier are persisted in sqlite so we
// don't trust cookies alone for the CSRF check — an attacker who can set
// cookies on our domain still can't forge a row in oauth_states.

import type { BrainStackDatabase } from '@brainstack/core';
import { Google, generateState, generateCodeVerifier, decodeIdToken } from 'arctic';

import { AppError } from '../lib/errors.js';
import { generateToken } from '../lib/tokens.js';

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  db: BrainStackDatabase;
  now?: () => number;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class GoogleOAuthService {
  private readonly google: Google;

  constructor(private readonly opts: GoogleOAuthOptions) {
    this.google = new Google(opts.clientId, opts.clientSecret, opts.redirectUri);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Returns the URL to redirect the browser to, plus the opaque state we'll
   * verify in the callback. The caller should set a short-lived cookie with
   * `state` for an extra CSRF check on top of the DB-backed one. */
  startAuthorization(redirectTo?: string): { url: string; state: string } {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const now = this.now();
    this.opts.db.sqlite
      .prepare(
        `INSERT INTO oauth_states (state, code_verifier, redirect_to, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(state, codeVerifier, redirectTo ?? null, now, now + STATE_TTL_MS);

    const url = this.google.createAuthorizationURL(state, codeVerifier, [
      'openid',
      'email',
      'profile',
    ]);
    return { url: url.toString(), state };
  }

  async completeAuthorization(params: {
    state: string;
    code: string;
    stateCookie: string | null;
  }): Promise<{ profile: GoogleProfile; redirectTo: string | null }> {
    if (!params.stateCookie || params.stateCookie !== params.state) {
      throw new AppError('state mismatch', 'UNAUTHORIZED', 401);
    }
    const now = this.now();
    const row = this.opts.db.sqlite
      .prepare<[string], {
        state: string;
        code_verifier: string;
        redirect_to: string | null;
        expires_at: number;
      }>(
        `SELECT state, code_verifier, redirect_to, expires_at FROM oauth_states WHERE state = ?`,
      )
      .get(params.state);
    if (!row) throw new AppError('state not found', 'UNAUTHORIZED', 401);
    if (row.expires_at < now) {
      this.opts.db.sqlite.prepare('DELETE FROM oauth_states WHERE state = ?').run(params.state);
      throw new AppError('state expired', 'UNAUTHORIZED', 401);
    }

    // Single-use: drop the row before exchange so a duplicate callback fails.
    this.opts.db.sqlite.prepare('DELETE FROM oauth_states WHERE state = ?').run(params.state);

    const tokens = await this.google.validateAuthorizationCode(params.code, row.code_verifier);
    const idToken = tokens.idToken();
    const claims = decodeIdToken(idToken) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!claims.sub || !claims.email) {
      throw new AppError('google profile is missing required claims', 'INTERNAL', 500);
    }

    return {
      profile: {
        googleId: claims.sub,
        email: claims.email,
        emailVerified: claims.email_verified === true,
        name: claims.name ?? null,
        picture: claims.picture ?? null,
      },
      redirectTo: row.redirect_to,
    };
  }

  /** Test helper: short-circuit the OAuth dance and just return the profile. */
  static stubCompletion(profile: GoogleProfile, redirectTo: string | null = null) {
    return { profile, redirectTo };
  }

  // Re-export the random helper so tests don't import from arctic directly.
  static newState(): string {
    return generateToken(16);
  }
}
