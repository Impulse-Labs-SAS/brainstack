// Health endpoints. `/health` says the process answers; `/health/ready` also
// asks the database, which is what a container healthcheck wants to know — a
// server up in front of a database that is not is not serving anyone.

import { Hono } from 'hono';
import type { Logger } from 'pino';

export function createHealthRouter(ping?: () => Promise<void>, logger?: Logger): Hono {
  return new Hono()
    .get('/', (c) =>
      c.json({ status: 'ok', service: 'brainstack', time: new Date().toISOString() }),
    )
    .get('/ready', async (c) => {
      if (!ping) return c.json({ status: 'ok', database: 'unchecked' });
      try {
        await ping();
        return c.json({ status: 'ok', database: 'ok' });
      } catch (err) {
        // The reason goes to the log; a probe only needs the answer.
        logger?.warn({ err }, 'readiness check: database unreachable');
        return c.json({ status: 'unavailable', database: 'unreachable' }, 503);
      }
    });
}
