// Public configuration endpoint. No auth: it describes the instance, not the
// user.
//
// Every instance is the same now, so what it reports is fixed. It stays for two
// readers: the deploy check, which asks it for a 200 to prove the API function
// answers, and a web bundle cached from before, which reads `features.sharing`
// to decide whether to show the share actions.

import { Hono } from 'hono';

export const PUBLIC_CONFIG = {
  features: {
    sharing: true,
  },
} as const;

export function createConfigRouter(): Hono {
  return new Hono().get('/', (c) => c.json(PUBLIC_CONFIG));
}
