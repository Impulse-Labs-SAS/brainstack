// MCP HTTP transport mounted under /mcp. Uses StreamableHTTPServerTransport
// in stateless mode (one transport per request) — fine for V1, switch to
// session-aware transports when we add auth in Fase 3.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';

export interface McpHttpRouterOptions {
  buildServer(): McpServer;
  logger: Logger;
}

export function createMcpHttpRouter({ buildServer, logger }: McpHttpRouterOptions): Hono {
  const router = new Hono();

  router.all('/', async (c) => {
    // @hono/node-server exposes the raw Node objects on `c.env`.
    const { incoming, outgoing } = c.env as {
      incoming: IncomingMessage;
      outgoing: ServerResponse;
    };
    if (!incoming || !outgoing) {
      return c.json({ error: 'MCP HTTP transport requires the Node adapter' }, 500);
    }

    let body: unknown;
    if (incoming.method === 'POST') {
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    try {
      await server.connect(transport);
      await transport.handleRequest(incoming, outgoing, body);
    } catch (err) {
      logger.error({ err }, 'MCP HTTP request failed');
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.end(JSON.stringify({ error: 'mcp internal error' }));
      }
    }

    // Hono needs *something* returned; the transport already wrote to outgoing.
    return new Response(null, { status: outgoing.statusCode || 200 });
  });

  return router;
}
