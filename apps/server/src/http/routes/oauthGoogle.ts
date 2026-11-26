// /auth/google + /auth/google/callback. Drives the OAuth dance and finalises
// the login by setting the session cookie and redirecting to the app — or, for
// an account with a second factor, by holding the sign-in until the code is
// sent to /auth/google/second-factor.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Logger } from 'pino';
import { z } from 'zod';

import { clientIp, type TrustedProxy } from '../../lib/clientIp.js';
import { AppError, toAppError } from '../../lib/errors.js';
import type { AuthService } from '../../services/AuthService.js';
import type { GoogleOAuthService } from '../../services/GoogleOAuthService.js';

import { SESSION_COOKIE, type AuthBindings } from '../middleware/auth.js';

export interface OAuthGoogleRouterOptions {
  google: GoogleOAuthService;
  auth: AuthService;
  logger: Logger;
  secureCookies: boolean;
  /** Where to redirect after a successful sign-in / on error. */
  appHome: string;
  /** The prefix the API is mounted under, e.g. `/api`. */
  basePath?: string;
  /** Which header names the client, if any. See lib/clientIp.ts. */
  trustedProxy?: TrustedProxy;
}

const STATE_COOKIE = 'bs_oauth_state';
/** Holds a Google sign-in that still owes the second factor. */
export const SECOND_FACTOR_COOKIE = 'bs_second_factor';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const STATE_MAX_AGE = 10 * 60;

function setSessionCookie(c: Context<AuthBindings>, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export function createOAuthGoogleRouter(opts: OAuthGoogleRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();
  // The state cookie has to reach the callback, which lives under the API's
  // prefix. Scoped to a bare `/auth`, the browser never sent it to
  // `/api/auth/google/callback`, and every sign-in failed on "state mismatch".
  const statePath = `${opts.basePath ?? ''}/auth`;

  router.get('/google', async (c) => {
    const redirectTo = c.req.query('redirect_to') ?? undefined;
    const { url, state } = await opts.google.startAuthorization(redirectTo);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: 'Lax',
      path: statePath,
      maxAge: STATE_MAX_AGE,
    });
    return c.redirect(url);
  });

  router.get('/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const stateCookie = getCookie(c, STATE_COOKIE) ?? null;
    deleteCookie(c, STATE_COOKIE, { path: statePath });

    if (!code || !state) {
      return c.redirect(`${opts.appHome}/login?error=missing_oauth_params`);
    }

    try {
      const { profile, redirectTo } = await opts.google.completeAuthorization({
        state,
        code,
        stateCookie,
      });
      const user = await opts.auth.upsertGoogleUser({
        googleId: profile.googleId,
        email: profile.email,
        googleEmailVerified: profile.emailVerified,
        displayName: profile.name,
      });
      // Google proves the address, which is all a reset link proves too. An
      // account with a second factor still owes its code: hold the sign-in
      // and send the person to type it.
      if (opts.auth.needsSecondFactor(user)) {
        const challenge = await opts.auth.issueSecondFactorChallenge(user.id);
        setCookie(c, SECOND_FACTOR_COOKIE, challenge.token, {
          httpOnly: true,
          secure: opts.secureCookies,
          sameSite: 'Lax',
          path: statePath,
          // The server refuses it once its own expiry passes; this only tidies up.
          maxAge: STATE_MAX_AGE,
        });
        const next = new URLSearchParams({ second_factor: 'google' });
        const back = relativeRedirect(redirectTo, opts.appHome);
        if (back) next.set('redirect_to', back);
        return c.redirect(`${opts.appHome}/login?${next.toString()}`);
      }
      const session = await opts.auth.createSession(user.id, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: clientIp(c, opts.trustedProxy ?? 'proxy'),
      });
      setSessionCookie(c, session.token, opts.secureCookies);
      const dest = sanitizeRedirect(redirectTo, opts.appHome);
      return c.redirect(dest);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      opts.logger.warn({ err }, 'google oauth failed');
      return c.redirect(`${opts.appHome}/login?error=${encodeURIComponent(code)}`);
    }
  });

  router.post('/google/second-factor', async (c) => {
    const parsed = z
      .object({ code: z.string().min(1).max(20) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    const challenge = getCookie(c, SECOND_FACTOR_COOKIE);
    if (!challenge) {
      return c.json({ error: 'sign-in expired; start again', code: 'UNAUTHORIZED' }, 401);
    }
    try {
      const result = await opts.auth.completeSecondFactor(challenge, parsed.data.code, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: clientIp(c, opts.trustedProxy ?? 'proxy'),
      });
      deleteCookie(c, SECOND_FACTOR_COOKIE, { path: statePath });
      setSessionCookie(c, result.session.token, opts.secureCookies);
      return c.json({ user: result.user });
    } catch (err) {
      const known = toAppError(err);
      if (!known) throw err;
      return c.json({ error: known.message, code: known.code }, known.status as 400 | 401 | 429);
    }
  });

  return router;
}

/**
 * Where to go after the code, as a path on this site, or null. The login page
 * carries it in `?redirect_to=` and only follows a relative path.
 */
function relativeRedirect(redirectTo: string | null, appHome: string): string | null {
  if (!redirectTo) return null;
  const absolute = sanitizeRedirect(redirectTo, appHome);
  try {
    const url = new URL(absolute);
    const home = new URL(appHome);
    if (url.origin !== home.origin) return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path === '/' ? null : path;
  } catch {
    return null;
  }
}

/**
 * Only allow relative paths, or absolute URLs whose origin is exactly appHome.
 *
 * The origin has to be compared as an origin, not as a string prefix: with a
 * prefix check `https://brainstack.app.evil.com` starts with
 * `https://brainstack.app` and sails through, which is the open redirect. A
 * protocol-relative `//evil.com` is a URL to another host too, so it is
 * refused alongside.
 */
function sanitizeRedirect(redirectTo: string | null, appHome: string): string {
  if (!redirectTo) return `${appHome}/`;
  if (redirectTo.startsWith('/') && !redirectTo.startsWith('//') && !redirectTo.startsWith('/\\')) {
    return `${appHome}${redirectTo}`;
  }
  try {
    if (new URL(redirectTo).origin === new URL(appHome).origin) return redirectTo;
  } catch {
    // Not a parseable absolute URL; fall through to the safe default.
  }
  return `${appHome}/`;
}
