// Simple liveness endpoint. Useful for Docker healthchecks.

import { Hono } from 'hono';

export const healthRouter = new Hono().get('/', (c) =>
  c.json({ status: 'ok', service: 'brainstack', time: new Date().toISOString() }),
);
