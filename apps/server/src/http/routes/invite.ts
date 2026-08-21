// Endpoint REST para aceptar invitaciones desde un link plano.
//   GET /invite/accept/:token
// Maneja tres casos:
//   1. No logueado          → redirige a /login?next=...
//   2. Logueado + acepta OK → redirige a /notes/<folderPath>
//   3. Logueado + error     → redirige a /invite/error?reason=...
//
// El frontend también puede aceptar vía tRPC (sharing.acceptInvite) si ya
// pasó por su propio flujo; este endpoint es el "click directo desde mail".

import { Hono } from 'hono';

import { AppError } from '../../lib/errors.js';
import type { InviteService } from '../../services/InviteService.js';
import type { AuthBindings } from '../middleware/auth.js';

export interface InviteRouterOptions {
  invites: InviteService;
  /** Origin del frontend para construir los redirects. */
  appHome: string;
}

export function createInviteRouter(opts: InviteRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();

  router.get('/accept/:token', async (c) => {
    const token = c.req.param('token');
    const principal = c.get('principal');
    const next = `/invite/accept/${encodeURIComponent(token)}`;

    if (!principal) {
      return c.redirect(
        `${opts.appHome}/login?next=${encodeURIComponent(next)}`,
        302,
      );
    }

    try {
      const result = await opts.invites.accept({
        token,
        user: { id: principal.user.id, email: principal.user.email },
      });
      return c.redirect(
        `${opts.appHome}/notes/${encodeURIComponent(result.folderPath)}`,
        302,
      );
    } catch (err) {
      const reason =
        err instanceof AppError
          ? err.code.toLowerCase()
          : 'internal';
      return c.redirect(
        `${opts.appHome}/invite/error?reason=${reason}`,
        302,
      );
    }
  });

  return router;
}
