// MCP HTTP transport mounted under /mcp. Uses StreamableHTTPServerTransport
// in stateless mode (one transport per request) — fine for V1, switch to
// session-aware transports when we add auth in Fase 3.
//
// Two transports for two runtimes. In development @hono/node-server hands us
// Node's IncomingMessage/ServerResponse and the SDK's Node transport writes
// into them. On Netlify the request is a Fetch Request and there is no Node
// pair — the SDK's web-standard transport takes the Request and returns a
// Response, which is the whole adaptation.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
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
    const nodeEnv = c.env as
      | { incoming?: IncomingMessage; outgoing?: ServerResponse }
      | undefined;

    const principal = c.get('principal');
    const mcpPrincipal: McpPrincipal | null = principal
      ? { userId: principal.user.id }
      : null;
    const server = buildServer(mcpPrincipal);

    if (!nodeEnv?.incoming || !nodeEnv.outgoing) {
      // Fetch runtime (Netlify): Request in, Response out, nothing to bridge.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(c.req.raw);
      } catch (err) {
        logger.error({ err }, 'MCP HTTP request failed');
        return c.json({ error: 'mcp internal error' }, 500);
      }
    }

    const { incoming, outgoing } = nodeEnv as {
      incoming: IncomingMessage;
      outgoing: ServerResponse;
    };

    let body: unknown;
    if (c.req.method === 'POST') {
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
