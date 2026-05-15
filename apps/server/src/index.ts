// BrainStack server entry point.
// Boots HTTP (Hono: tRPC + MCP HTTP/SSE), optional MCP stdio, filesystem watcher,
// and background cron jobs. Implementation lands in Fases 2–3.

import { CORE_PACKAGE_VERSION } from '@brainstack/core';

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[brainstack] server stub — core=${CORE_PACKAGE_VERSION}`);
}

void main();
