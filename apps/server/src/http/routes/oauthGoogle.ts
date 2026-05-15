// /auth/google + /auth/google/callback. Drives the OAuth dance and finalises
// the login by setting the session cookie and redirecting to the app.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Logger } from 'pino';

import { AppError } from '../../lib/errors.js';
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
}

const STATE_COOKIE = 'bs_oauth_state';
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

  router.get('/google', (c) => {
    const redirectTo = c.req.query('redirect_to') ?? undefined;
    const { url, state } = opts.google.startAuthorization(redirectTo);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: 'Lax',
      path: '/auth',
      maxAge: STATE_MAX_AGE,
    });
    return c.redirect(url);
  });

  router.get('/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const stateCookie = getCookie(c, STATE_COOKIE) ?? null;
    deleteCookie(c, STATE_COOKIE, { path: '/auth' });

    if (!code || !state) {
      return c.redirect(`${opts.appHome}/login?error=missing_oauth_params`);
    }

    try {
      const { profile, redirectTo } = await opts.google.completeAuthorization({
        state,
        code,
        stateCookie,
      });
      const user = opts.auth.upsertGoogleUser({
        googleId: profile.googleId,
        email: profile.email,
        googleEmailVerified: profile.emailVerified,
        displayName: profile.name,
      });
      const session = opts.auth.createSession(user.id, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: c.req.header('x-forwarded-for') ?? undefined,
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

  return router;
}

/** Only allow relative paths or paths within `appHome` to prevent open-redirect. */
function sanitizeRedirect(redirectTo: string | null, appHome: string): string {
  if (!redirectTo) return `${appHome}/`;
  if (redirectTo.startsWith('/') && !redirectTo.startsWith('//')) {
    return `${appHome}${redirectTo}`;
  }
  if (redirectTo.startsWith(appHome)) return redirectTo;
  return `${appHome}/`;
}
