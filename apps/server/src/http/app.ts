// Hono application factory. Combines middlewares and routers so that
// `index.ts` only worries about boot order and shutdown.

import { Hono } from 'hono';
import type { Logger } from 'pino';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpRouter } from './routes/mcp.js';
import { healthRouter } from './routes/health.js';

export interface BuildAppOptions {
  buildMcpServer(): McpServer;
  logger: Logger;
}

export function buildApp({ buildMcpServer, logger }: BuildAppOptions): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    logger.debug(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
      'http',
    );
  });

  app.route('/health', healthRouter);
  app.route('/mcp', createMcpHttpRouter({ buildServer: buildMcpServer, logger }));

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}
