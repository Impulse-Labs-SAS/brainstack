// Google OAuth (Authorization Code with PKCE) wrapped in a service so the
// HTTP layer stays thin. State + code_verifier are persisted in sqlite so we
// don't trust cookies alone for the CSRF check — an attacker who can set
// cookies on our domain still can't forge a row in oauth_states.

import { Google, generateState, generateCodeVerifier, decodeIdToken } from 'arctic';
import { eq } from 'drizzle-orm';

import { pgSchema, type PgDb } from '@brainstack/core/pg';

import { AppError } from '../lib/errors.js';
import { generateToken } from '../lib/tokens.js';

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  db: PgDb;
  now?: () => number;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const { oauthStates } = pgSchema;

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
  async startAuthorization(redirectTo?: string): Promise<{ url: string; state: string }> {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const now = this.now();

    await this.opts.db.insert(oauthStates).values({
      state,
      codeVerifier,
      redirectTo: redirectTo ?? null,
      createdAt: now,
      expiresAt: now + STATE_TTL_MS,
    });

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

    // Deleted and read in one statement: the row is single-use, so claiming it
    // this way makes a duplicate callback lose outright instead of racing the
    // read-then-delete the sqlite version did.
    const [row] = await this.opts.db
      .delete(oauthStates)
      .where(eq(oauthStates.state, params.state))
      .returning();

    if (!row) throw new AppError('state not found', 'UNAUTHORIZED', 401);
    if (row.expiresAt < now) throw new AppError('state expired', 'UNAUTHORIZED', 401);

    const tokens = await this.google.validateAuthorizationCode(params.code, row.codeVerifier);
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
      redirectTo: row.redirectTo,
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
