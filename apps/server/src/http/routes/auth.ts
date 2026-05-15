// /auth/* endpoints. Implements the magic-link flow plus session/api-key
// management for the web app. MCP clients only need /auth/api-keys to obtain
// a token they then send via the Authorization header.

import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import type { ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService } from '../../services/AuthService.js';

import {
  SESSION_COOKIE,
  buildAuthMiddleware,
  type AuthBindings,
  type AuthMiddlewareOptions,
} from '../middleware/auth.js';

export interface AuthRouterOptions extends AuthMiddlewareOptions {
  auth: AuthService;
  apiKeys: ApiKeyService;
  logger: Logger;
  /** True in production: sets Secure on cookies. */
  secureCookies: boolean;
}

export function createAuthRouter(options: AuthRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();
  const requireAuth = buildAuthMiddleware(options);
  const sessionMaxAge = 30 * 24 * 60 * 60; // 30 days

  router.post('/magic-link', async (c) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid email' }, 400);
    try {
      await options.auth.requestMagicLink(parsed.data.email);
    } catch (err) {
      // Don't leak which emails are authorized.
      if (err instanceof AppError && err.code !== 'FORBIDDEN' && err.code !== 'INVALID_INPUT') {
        options.logger.error({ err }, 'magic-link request failed');
      }
    }
    return c.json({ ok: true });
  });

  router.get('/magic-link/callback', async (c) => {
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'missing token' }, 400);

    let result;
    try {
      result = await options.auth.consumeMagicLink(token, {
        userAgent: c.req.header('user-agent') ?? undefined,
        ipAddress: c.req.header('x-forwarded-for') ?? undefined,
      });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'failed';
      return c.json({ error: message }, status as 401 | 403 | 500);
    }

    setCookie(c, SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      secure: options.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: sessionMaxAge,
    });
    return c.json({ user: result.user });
  });

  router.post('/logout', async (c) => {
    const token = c.req.header('x-session-token') ?? c.req.query('token');
    if (token) options.auth.revokeSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  router.get('/me', requireAuth, (c) => {
    const principal = c.var.principal;
    return c.json({ kind: principal.kind, user: principal.user });
  });

  router.get('/api-keys', requireAuth, (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    return c.json({ keys: options.apiKeys.list(principal.user.id) });
  });

  router.post('/api-keys', requireAuth, async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    const parsed = z
      .object({ name: z.string().min(1).max(80), scopes: z.array(z.string()).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    const created = options.apiKeys.create(
      principal.user.id,
      parsed.data.name,
      parsed.data.scopes ?? [],
    );
    return c.json({ key: created });
  });

  router.delete('/api-keys/:id', requireAuth, (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    try {
      options.apiKeys.revoke(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      return c.json({ error: 'revoke failed' }, status as 404 | 500);
    }
  });

  return router;
}
