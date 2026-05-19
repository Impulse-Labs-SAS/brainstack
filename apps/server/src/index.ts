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
import { ApiKeyService } from './services/ApiKeyService.js';
import { AuthService } from './services/AuthService.js';
import { BackupService } from './services/BackupService.js';
import { ConsoleEmailSender, ResendEmailSender } from './services/EmailSender.js';
import { GoogleOAuthService } from './services/GoogleOAuthService.js';
import { IndexService } from './services/IndexService.js';
import { NoteService } from './services/NoteService.js';
import { backfillOwnerId } from './services/OwnerBackfill.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';

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

  const emailSender =
    cfg.RESEND_API_KEY && cfg.AUTH_EMAIL_FROM
      ? new ResendEmailSender(cfg.RESEND_API_KEY, cfg.AUTH_EMAIL_FROM)
      : new ConsoleEmailSender(logger);
  const totp = new TotpService({ db: bs, issuer: 'BrainStack' });
  const auth = new AuthService({
    db: bs,
    email: emailSender,
    logger,
    publicOrigin: cfg.PUBLIC_ORIGIN,
    authorizedEmails: cfg.authorizedEmails,
    totp,
  });
  const apiKeys = new ApiKeyService({ db: bs });
  const sharing = new SharingService({ db: bs, deployment: cfg.BRAINSTACK_DEPLOYMENT });

  const google =
    cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET && cfg.GOOGLE_OAUTH_REDIRECT_URI
      ? new GoogleOAuthService({
          clientId: cfg.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: cfg.GOOGLE_OAUTH_REDIRECT_URI,
          db: bs,
        })
      : undefined;
  if (!google) {
    logger.info('Google OAuth disabled (set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI to enable)');
  }

  const backup = new BackupService({
    notesDir: cfg.notesDirAbs,
    databasePath: cfg.databasePathAbs,
    backupDir: cfg.BACKUP_DIR,
    remote: cfg.BACKUP_REPO,
    cronExpression: cfg.BACKUP_CRON,
    logger,
  });

  await index.bootstrap();
  backfillOwnerId(bs, { deployment: cfg.BRAINSTACK_DEPLOYMENT, logger });
  index.startWatching();
  backup.start();

  const factory = (principal: { userId: string } | null = null) =>
    buildMcpServer({ notes, search, sharing, logger, principal });

  let stdioConnected = false;
  if (cfg.MCP_STDIO) {
    const transport = new StdioServerTransport();
    const server = factory();
    await server.connect(transport);
    stdioConnected = true;
    logger.info('MCP stdio transport connected');
  }

  const app = buildApp({
    buildMcpServer: factory,
    logger,
    auth,
    apiKeys,
    notes,
    search,
    sharing,
    resolveUserForApiKey: (apiKey) => {
      const user = auth.getUser(apiKey.userId);
      if (!user) {
        // Shouldn't happen because FK cascades on delete, but stay defensive.
        throw new Error(`user not found for api key ${apiKey.id}`);
      }
      return user;
    },
    rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
    secureCookies: cfg.NODE_ENV === 'production',
    corsOrigins: cfg.corsOrigins,
    appHome: cfg.corsOrigins[0] ?? cfg.PUBLIC_ORIGIN,
    exposeDevTokens: cfg.NODE_ENV === 'development',
    google,
    totp,
    publicConfig: {
      deployment: cfg.BRAINSTACK_DEPLOYMENT,
      features: { sharing: cfg.BRAINSTACK_DEPLOYMENT === 'hosted' },
    },
  });
  const httpServer = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    logger.info({ port: info.port }, 'HTTP listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    httpServer.close?.();
    backup.stop();
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
