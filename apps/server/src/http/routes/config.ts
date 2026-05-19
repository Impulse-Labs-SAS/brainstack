// Endpoint público de configuración. El frontend lo consulta al boot para
// saber en qué deployment corre y qué features están activas. No requiere
// auth — el contenido es información del entorno, no del usuario.

import { Hono } from 'hono';

export interface PublicConfig {
  deployment: 'self-host' | 'hosted';
  features: {
    sharing: boolean;
  };
}

export function createConfigRouter(cfg: PublicConfig): Hono {
  return new Hono().get('/', (c) => c.json(cfg));
}
