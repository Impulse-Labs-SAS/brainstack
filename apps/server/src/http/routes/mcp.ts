// MCP HTTP transport mounted under /mcp. Uses StreamableHTTPServerTransport
// in stateless mode (one transport per request) — fine for V1, switch to
// session-aware transports when we add auth in Fase 3.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';

import type { McpPrincipal } from '../../mcp/server.js';
import type { AuthBindings } from '../middleware/auth.js';

export interface McpHttpRouterOptions {
  buildServer(principal: McpPrincipal | null): McpServer;
  logger: Logger;
}

export function createMcpHttpRouter({ buildServer, logger }: McpHttpRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();

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

    const principal = c.get('principal');
    const mcpPrincipal: McpPrincipal | null = principal
      ? { userId: principal.user.id }
      : null;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(mcpPrincipal);
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

    /*
     * The transport already wrote the whole response to `outgoing`, headers
     * included. Returning a normal Response makes the Node adapter write
     * headers onto a response that has gone out, which throws
     * ERR_HTTP_HEADERS_SENT after every successful MCP call — the request
     * succeeds and the server logs a crash right behind it.
     *
     * This header is how @hono/node-server is told a handler answered by hand.
     * It is not in the package's public exports, so it is spelled out here;
     * the adapter looks for it by this name (dist/constants, X_ALREADY_SENT).
     */
    return new Response(null, { headers: { 'x-hono-already-sent': 'true' } });
  });

  return router;
}
