// Public configuration endpoint. No auth: it describes the instance, not the
// user.
//
// Readers: the deploy check, which asks it for a 200 to prove the API function
// answers; a web bundle cached from before, which reads `features.sharing`;
// and the login page, which offers Google only where it is configured.

import { Hono } from 'hono';

export function publicConfig(opts: { google: boolean }) {
  return {
    features: {
      sharing: true,
      google: opts.google,
    },
  } as const;
}

export function createConfigRouter(opts: { google: boolean } = { google: false }): Hono {
  const config = publicConfig(opts);
  return new Hono().get('/', (c) => c.json(config));
}
