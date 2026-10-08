// Structured logger built on pino. The MCP stdio transport must not write to
// stdout, so when MCP_STDIO is on we redirect logs to stderr.

import pino, { type Logger } from 'pino';

import { loadConfig } from '../config/env.js';

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const cfg = loadConfig();
  cached = pino({
    level: cfg.LOG_LEVEL,
    base: { service: 'brainstack' },
    // Send to stderr if stdio MCP is on — stdout is reserved for JSON-RPC.
    ...(cfg.MCP_STDIO ? { transport: undefined } : {}),
  }, pino.destination(cfg.MCP_STDIO ? 2 : 1));
  return cached;
}
