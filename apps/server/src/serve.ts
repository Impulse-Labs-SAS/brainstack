// Standalone HTTP server, for local development.
//
// In production the Hono app is served from inside the Next app, because
// Netlify's runtime routes every path there. Locally that indirection is only
// in the way: this listens on its own port, the web app runs on another, and
// CORS lets them talk.
//
// What it boots is `createBrainStack`, shared with the Netlify function; this
// file only adds what a long-lived process needs: a port, an hourly purge and
// a clean shutdown.

import { serve } from '@hono/node-server';

import { createBrainStack } from './boot.js';
import { loadConfig } from './config/env.js';
import { getLogger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();

  const { app, purgeExpired, close: closeDb } = await createBrainStack({ config, logger });

  // Expired sessions, links and OAuth rows: once at boot, then every hour.
  const purge = setInterval(() => void purgeExpired(), 60 * 60 * 1000);
  purge.unref();

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'BrainStack server listening');
  });

  /*
   * `docker stop` sends SIGTERM and waits ten seconds before killing. Node
   * running as a container's first process ignores the signal unless something
   * listens for it, so without this every stop is a kill: requests in flight
   * are cut, and the pool's connections are dropped rather than closed.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    clearInterval(purge);
    server.close(() => {
      closeDb()
        .catch((err: unknown) => logger.error({ err }, 'closing the database failed'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // No logger yet if config failed, so this goes to stderr directly.
  console.error(err);
  process.exit(1);
});
