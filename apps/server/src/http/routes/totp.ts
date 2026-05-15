// /auth/totp/* — enroll, confirm, disable, status. All routes require an
// active session; the actual TOTP gate on login lives in AuthService.login.

import { Hono } from 'hono';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import type { AuthService } from '../../services/AuthService.js';
import type { TotpService } from '../../services/TotpService.js';

import {
  buildAuthMiddleware,
  type AuthBindings,
  type AuthMiddlewareOptions,
} from '../middleware/auth.js';

export interface TotpRouterOptions extends AuthMiddlewareOptions {
  auth: AuthService;
  totp: TotpService;
}

export function createTotpRouter(options: TotpRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();
  const requireAuth = buildAuthMiddleware(options);

  router.post('/enroll', requireAuth, (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    if (principal.user.hasTotp) return c.json({ error: 'totp already enabled' }, 409);
    const enrollment = options.totp.beginEnrollment(principal.user.email);
    return c.json(enrollment);
  });

  router.post('/confirm', requireAuth, async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    if (principal.user.hasTotp) return c.json({ error: 'totp already enabled' }, 409);
    const parsed = z
      .object({ secret: z.string().min(16), code: z.string().min(6).max(10) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      const result = options.totp.confirmEnrollment(
        principal.user.id,
        parsed.data.secret,
        parsed.data.code,
      );
      return c.json({ backupCodes: result.backupCodes });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'failed';
      return c.json({ error: message }, status as 401 | 500);
    }
  });

  router.post('/disable', requireAuth, async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    if (!principal.user.hasTotp) return c.json({ ok: true });
    const parsed = z
      .object({ code: z.string().min(6).max(20) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      options.totp.disable(principal.user.id, parsed.data.code);
      return c.json({ ok: true });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'failed';
      return c.json({ error: message }, status as 401 | 500);
    }
  });

  router.get('/status', requireAuth, (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'user') return c.json({ error: 'session required' }, 403);
    return c.json({
      enabled: principal.user.hasTotp,
      remainingBackupCodes: principal.user.hasTotp
        ? options.totp.remainingBackupCodes(principal.user.id)
        : 0,
    });
  });

  return router;
}
