// BrainStack server entry point.
// Boots: config → sqlite → indexer bootstrap → watcher → optional stdio MCP →
// HTTP server (tRPC will mount in Fase 3, MCP HTTP/SSE is already wired here).

import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from '@brainstack/core';

import { loadConfig } from './config/env.js';
import { buildApp } from './http/app.js';
import { getLogger } from './lib/logger.js';
import { buildMcpServer } from './mcp/server.js';
import { IndexService } from './services/IndexService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = getLogger();

  logger.info(
    {
      env: cfg.NODE_ENV,
      port: cfg.PORT,
      notesDir: cfg.notesDirAbs,
      stdio: cfg.MCP_STDIO,
    },
    'brainstack starting',
  );

  const bs = openDatabase(cfg.databasePathAbs);
  const index = new IndexService({ root: cfg.notesDirAbs, db: bs, logger });
  const notes = new NoteService({ root: cfg.notesDirAbs, db: bs, index });
  const search = new SearchService(bs);

  await index.bootstrap();
  index.startWatching();

  const factory = () => buildMcpServer({ notes, search, logger });

  let stdioConnected = false;
  if (cfg.MCP_STDIO) {
    const transport = new StdioServerTransport();
    const server = factory();
    await server.connect(transport);
    stdioConnected = true;
    logger.info('MCP stdio transport connected');
  }

  const app = buildApp({ buildMcpServer: factory, logger });
  const httpServer = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    logger.info({ port: info.port }, 'HTTP listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    httpServer.close?.();
    await index.stopWatching();
    bs.close();
    if (stdioConnected) process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err) => {
  // Use console here because the logger may have not been built yet.

  console.error('fatal boot error', err);
  process.exit(1);
});
