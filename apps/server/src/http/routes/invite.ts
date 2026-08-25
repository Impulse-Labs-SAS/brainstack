// Endpoint REST para aceptar invitaciones desde un link plano.
//   GET /invite/accept/:token
// Maneja tres casos:
//   1. No logueado          → redirige a /login?redirect_to=...
//   2. Logueado + acepta OK → redirige a /notes/shared/<ownerId>/<folderPath>
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
  /**
   * Prefijo bajo el que vive este router, ej. `/api`. El login vuelve acá
   * después de autenticar: sin el prefijo la vuelta cae en el 404 del front.
   */
  apiBasePath?: string;
}

export function createInviteRouter(opts: InviteRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();

  router.get('/accept/:token', async (c) => {
    const token = c.req.param('token');
    const principal = c.get('principal');
    const next = `${opts.apiBasePath ?? ''}/invite/accept/${encodeURIComponent(token)}`;

    if (!principal) {
      return c.redirect(`${opts.appHome}/login?redirect_to=${encodeURIComponent(next)}`, 302);
    }

    try {
      const result = await opts.invites.accept({
        token,
        user: { id: principal.user.id, email: principal.user.email },
      });
      // A la vista compartida, no a la propia. Lo que acabás de recibir vive en
      // la bóveda del dueño: mandarte a `/notes/<carpeta>` te dejaba en tu
      // propio vault, donde ese path no existe — la invitación terminaba en
      // "note not found" justo después de haber funcionado.
      //
      // Y segmento por segmento: `encodeURIComponent` sobre el path entero
      // convierte las barras en %2F y lo vuelve un solo segmento.
      const segments = result.folderPath
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
      return c.redirect(
        `${opts.appHome}/notes/shared/${encodeURIComponent(result.ownerId)}/${segments}`,
        302,
      );
    } catch (err) {
      const reason = err instanceof AppError ? err.code.toLowerCase() : 'internal';
      return c.redirect(`${opts.appHome}/invite/error?reason=${reason}`, 302);
    }
  });

  return router;
}
