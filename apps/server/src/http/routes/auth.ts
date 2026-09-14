// /auth/* endpoints. Signup, login, password reset, email verification,
// logout and /me. Google OAuth lives in a sibling router (./oauthGoogle.ts).
// API keys are managed over tRPC (`apiKeys.*`) only: the REST copies that
// lived here stopped awaiting the store when it went async, answered `{}`,
// and deleted keys without checking whose they were. Nothing called them.
//
// Discipline: user-facing routes that finish auth (login, reset/confirm,
// verify) DO NOT return JSON — they set the session cookie and redirect.
// REST-ish routes that the frontend fetches (signup, forgot-password, etc.)
// return JSON; when they create a session, they ALSO set the cookie.

import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import type { LoginRateLimiter } from '../../lib/rateLimitLogin.js';
import type { AuthService } from '../../services/AuthService.js';

import {
  SESSION_COOKIE,
  buildAuthMiddleware,
  type AuthBindings,
  type AuthMiddlewareOptions,
} from '../middleware/auth.js';

export interface AuthRouterOptions extends AuthMiddlewareOptions {
  auth: AuthService;
  logger: Logger;
  loginLimiter: LoginRateLimiter;
  /** True in production: sets Secure on cookies. */
  secureCookies: boolean;
  /** Where to redirect after a successful verification / reset. */
  appHome: string;
  /** When true (dev), responses include verification/reset URLs so testing
   * without SMTP works. Always false in production. */
  exposeDevTokens: boolean;
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

type AuthCtx = Context<AuthBindings>;

function clientIp(c: AuthCtx): string {
  // tsx/node behind a reverse proxy will fill x-forwarded-for.
  return (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local').slice(0, 64);
}

function setSessionCookie(c: AuthCtx, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export function createAuthRouter(options: AuthRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();
  const requireAuth = buildAuthMiddleware(options);

  // -- Signup -------------------------------------------------------------

  router.post('/signup', async (c) => {
    const parsed = z
      .object({
        email: z.string().email().max(320),
        password: z.string().min(1).max(256),
        displayName: z.string().max(120).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);

    try {
      const result = await options.auth.signup(
        parsed.data.email,
        parsed.data.password,
        parsed.data.displayName ?? null,
      );
      options.logger.info({ url: result.verification.url }, 'email verification link');
      const body: Record<string, unknown> = { user: result.user };
      if (options.exposeDevTokens) body.verificationUrl = result.verification.url;
      return c.json(body, 201);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // -- Login --------------------------------------------------------------

  router.post('/login', async (c) => {
    const parsed = z
      .object({
        email: z.string().email().max(320),
        password: z.string().min(1).max(256),
        totpCode: z.string().min(1).max(20).optional(),
        redirectTo: z.string().max(512).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);

    const ip = clientIp(c);
    const limiterKey = { ip, email: parsed.data.email };

    try {
      options.loginLimiter.check(limiterKey);
    } catch (err) {
      if ((err as { code?: string }).code === 'RATE_LIMITED') {
        return c.json(
          { error: 'too many attempts, try again later' },
          429,
        );
      }
      throw err;
    }

    try {
      const result = await options.auth.login(parsed.data.email, parsed.data.password, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: ip,
        totpCode: parsed.data.totpCode,
      });
      options.loginLimiter.reset(limiterKey);
      setSessionCookie(c, result.session.token, options.secureCookies);
      return c.json({ user: result.user });
    } catch (err) {
      options.loginLimiter.recordFailure(limiterKey);
      return jsonError(c, err);
    }
  });

  // -- Logout -------------------------------------------------------------

  router.post('/logout', async (c) => {
    const token = c.req.header('x-session-token') ?? c.req.query('token');
    // Awaited: on a serverless runtime nothing is guaranteed to run once the
    // response is sent, and a logout that leaves the session valid is not one.
    if (token) await options.auth.revokeSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // -- Forgot / reset password -------------------------------------------

  router.post('/forgot-password', async (c) => {
    const parsed = z
      .object({ email: z.string().email().max(320) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: true }); // don't leak validation

    try {
      const result = await options.auth.requestPasswordReset(parsed.data.email);
      if (result.url) {
        options.logger.info({ url: result.url }, 'password reset link');
      }
      const body: Record<string, unknown> = { ok: true };
      if (options.exposeDevTokens && result.url) body.resetUrl = result.url;
      return c.json(body);
    } catch (err) {
      options.logger.error({ err }, 'forgot-password failed');
      // Still return ok to avoid enumeration.
      return c.json({ ok: true });
    }
  });

  router.post('/reset-password', async (c) => {
    const parsed = z
      .object({ token: z.string().min(1), password: z.string().min(1).max(256) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      const user = await options.auth.consumePasswordReset(parsed.data.token, parsed.data.password);
      // Create a fresh session so the user lands logged in.
      const session = await options.auth.createSession(user.id, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: clientIp(c),
      });
      setSessionCookie(c, session.token, options.secureCookies);
      return c.json({ user });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  // -- Email verification ------------------------------------------------

  router.get('/verify-email', async (c) => {
    const token = c.req.query('token');
    if (!token) return c.redirect(`${options.appHome}/verify-email?error=missing_token`);
    try {
      const user = await options.auth.consumeEmailVerification(token);
      const session = await options.auth.createSession(user.id, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: clientIp(c),
      });
      setSessionCookie(c, session.token, options.secureCookies);
      return c.redirect(`${options.appHome}/?verified=1`);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      return c.redirect(`${options.appHome}/verify-email?error=${encodeURIComponent(code)}`);
    }
  });

  router.post('/resend-verification', async (c) => {
    const parsed = z
      .object({ email: z.string().email().max(320) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: true });
    try {
      const result = await options.auth.resendVerification(parsed.data.email);
      if (result.url) options.logger.info({ url: result.url }, 'email verification link');
      const body: Record<string, unknown> = { ok: true };
      if (options.exposeDevTokens && result.url) body.verificationUrl = result.url;
      return c.json(body);
    } catch (err) {
      options.logger.error({ err }, 'resend verification failed');
      return c.json({ ok: true });
    }
  });

  // -- Session info ------------------------------------------------------

  router.get('/me', requireAuth, (c) => {
    const principal = c.var.principal;
    return c.json({ kind: principal.kind, user: principal.user });
  });

  // -- Password change ---------------------------------------------------

  router.post('/change-password', requireAuth, async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z.string().min(1).max(256),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      await options.auth.changePassword(
        principal.user.id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      return c.json({ ok: true });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  router.post('/google/unlink', requireAuth, async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    try {
      // Awaited, or the refusal to unlink an account's only way in never
      // reaches the catch: the client hears "ok", and the rejection is left
      // unhandled — which takes the Node process down with it.
      await options.auth.unlinkGoogle(principal.user.id);
      return c.json({ ok: true });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return router;
}

function jsonError(c: AuthCtx, err: unknown) {
  if (err instanceof AppError) {
    return c.json(
      { error: err.message, code: err.code },
      err.status as 400 | 401 | 403 | 404 | 409 | 500,
    );
  }
  const message = err instanceof Error ? err.message : 'failed';
  return c.json({ error: message }, 500);
}
