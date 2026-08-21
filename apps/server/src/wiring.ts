// Builds the service graph from a Postgres connection.
//
// One place where the wiring lives, shared by every entrypoint: the Next route
// handlers, the stdio MCP process, and the tests. Nothing here touches the
// filesystem or holds a connection open, so it is safe to call per request.

import { openPgDatabase, PgNoteStore, PgSearchService, type PgDb } from '@brainstack/core/pg';
import type { Logger } from 'pino';

import type { VaultConfig } from './lib/vault.js';

import { ApiKeyService, type ApiKey } from './services/ApiKeyService.js';
import { AuthService, type User } from './services/AuthService.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { ConsoleEmailSender, ResendEmailSender } from './services/EmailSender.js';
import { GoogleOAuthService } from './services/GoogleOAuthService.js';
import { InviteService } from './services/InviteService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';

export interface Services {
  db: PgDb;
  cfg: VaultConfig;
  notes: NoteService;
  search: SearchService;
  auth: AuthService;
  apiKeys: ApiKeyService;
  sharing: SharingService;
  invites: InviteService;
  totp: TotpService;
  crossOwner: CrossOwnerReader;
  /** Present only when Google credentials are configured. */
  google?: GoogleOAuthService;
  resolveUserForApiKey(apiKey: ApiKey): Promise<User>;
}

export interface BuildServicesOptions {
  db: PgDb;
  logger: Logger;
  publicOrigin: string;
  authorizedEmails: Set<string>;
  /** Must match the `basePath` given to `buildApp`. */
  apiBasePath?: string;
  /** Defaults to self-host, where there is one user and no sharing. */
  deployment?: 'self-host' | 'hosted';
  resendApiKey?: string | undefined;
  emailFrom?: string | undefined;
  googleClientId?: string | undefined;
  googleClientSecret?: string | undefined;
  googleRedirectUri?: string | undefined;
}

export function buildServices(opts: BuildServicesOptions): Services {
  const cfg: VaultConfig = { deployment: opts.deployment ?? 'self-host' };

  const emailSender =
    opts.resendApiKey && opts.emailFrom
      ? new ResendEmailSender(opts.resendApiKey, opts.emailFrom)
      : new ConsoleEmailSender(opts.logger);

  const notes = new NoteService({ db: opts.db, cfg, store: new PgNoteStore(opts.db) });
  const search = new SearchService({ db: opts.db, cfg, search: new PgSearchService(opts.db) });

  const sharing = new SharingService({ db: opts.db, deployment: cfg.deployment });
  const totp = new TotpService({ db: opts.db, issuer: 'BrainStack' });

  const auth = new AuthService({
    db: opts.db,
    email: emailSender,
    logger: opts.logger,
    publicOrigin: opts.publicOrigin,
    authorizedEmails: opts.authorizedEmails,
    ...(opts.apiBasePath ? { apiBasePath: opts.apiBasePath } : {}),
    totp,
  });

  const invites = new InviteService({
    db: opts.db,
    email: emailSender,
    sharing,
    publicOrigin: opts.publicOrigin,
  });

  const crossOwner = new CrossOwnerReader({ db: opts.db, sharing, vaultCfg: cfg });

  // Optional: without credentials the Google routes simply are not mounted.
  const google =
    opts.googleClientId && opts.googleClientSecret && opts.googleRedirectUri
      ? new GoogleOAuthService({
          clientId: opts.googleClientId,
          clientSecret: opts.googleClientSecret,
          redirectUri: opts.googleRedirectUri,
          db: opts.db,
        })
      : undefined;

  return {
    db: opts.db,
    cfg,
    notes,
    search,
    auth,
    apiKeys: new ApiKeyService({ db: opts.db }),
    sharing,
    invites,
    totp,
    crossOwner,
    ...(google ? { google } : {}),
    resolveUserForApiKey: async (apiKey: ApiKey): Promise<User> => {
      const user = await auth.findUserById(apiKey.userId ?? '');
      if (!user) {
        // The FK cascades on delete, so this means the row was tampered with.
        throw new Error(`user not found for api key ${apiKey.id}`);
      }
      return user;
    },
  };
}

/** Connect to Postgres and build the services in one step. */
export function connectAndBuild(
  databaseUrl: string,
  opts: Omit<BuildServicesOptions, 'db'>,
): Services {
  return buildServices({ ...opts, db: openPgDatabase(databaseUrl).db });
}
