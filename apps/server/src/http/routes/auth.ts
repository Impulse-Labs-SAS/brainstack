// /auth/* endpoints. The magic-link flow has been removed; the new
// password + Google OAuth flows are coming in the next commits. This file
// keeps the minimum that the rest of the app already relies on: /auth/me,
// /auth/logout and the API key management endpoints.

import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
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
