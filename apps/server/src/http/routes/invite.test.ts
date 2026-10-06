// El link de aceptar invitación, que es lo único que el invitado ve.
//
// Dos bugs vivieron acá, y los dos dejaban la invitación inservible después de
// haber funcionado: el link apuntaba al origin del frontend sin el prefijo de
// la API (404 de Next), y al aceptar redirigía a `/notes/<carpeta>` — la
// bóveda de quien acepta, donde esa carpeta no existe.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../lib/errors.js';
import type { InviteService } from '../../services/InviteService.js';
import type { AuthBindings } from '../middleware/auth.js';

import { createInviteRouter } from './invite.js';

const APP = 'https://app.test';

/** Un router con el principal ya resuelto, como lo deja `optionalAuth`. */
function routerFor(
  principal: { user: { id: string; email: string } } | null,
  accept: InviteService['accept'],
): Hono<AuthBindings> {
  const outer = new Hono<AuthBindings>();
  outer.use('*', async (c, next) => {
    c.set('principal', principal as never);
    await next();
  });
  outer.route(
    '/',
    createInviteRouter({
      invites: { accept } as unknown as InviteService,
      appHome: APP,
      apiBasePath: '/api',
    }),
  );
  return outer;
}

const FRODO = { user: { id: 'u_frodo', email: 'frodo@x.com' } };

describe('GET /invite/accept/:token', () => {
  it('manda a la vista compartida del dueño, no a la bóveda propia', async () => {
    const router = routerFor(FRODO, async () => ({
      shareId: 's1',
      folderPath: '01 Impulse Labs',
      ownerId: 'u_sam',
    }));

    const res = await router.request('/accept/tok');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP}/notes/shared/u_sam/01%20Impulse%20Labs`);
  });

  it('codifica cada segmento, sin convertir las barras en %2F', async () => {
    const router = routerFor(FRODO, async () => ({
      shareId: 's1',
      folderPath: '01 Impulse Labs/Gondor',
      ownerId: 'u_sam',
    }));

    const location = (await router.request('/accept/tok')).headers.get('location');

    // Con el path entero pasado por encodeURIComponent esto era un solo
    // segmento, y la ruta no resolvía.
    expect(location).toBe(`${APP}/notes/shared/u_sam/01%20Impulse%20Labs/Gondor`);
    expect(location).not.toContain('%2F');
  });

  it('sin sesión vuelve al login, y la vuelta conserva el prefijo de la API', async () => {
    const router = routerFor(null, async () => {
      throw new Error('no debería aceptar sin sesión');
    });

    const location = (await router.request('/accept/tok')).headers.get('location');

    expect(location).toBe(
      `${APP}/login?redirect_to=${encodeURIComponent('/api/invite/accept/tok')}`,
    );
  });

  it('un error de aceptación va a la pantalla de error con su motivo', async () => {
    const router = routerFor(FRODO, async () => {
      throw new AppError('this invitation was already accepted', 'FORBIDDEN', 403);
    });

    const location = (await router.request('/accept/tok')).headers.get('location');

    expect(location).toBe(`${APP}/invite/error?reason=forbidden`);
  });
});
