// Builds the service graph from a Postgres connection.
//
// One place where the wiring lives, shared by every entrypoint: the Next route
// handlers, the stdio MCP process, and the tests. Nothing here touches the
// filesystem or holds a connection open, so it is safe to call per request.

import { openPgDatabase, PgNoteStore, PgSearchService, type PgDb } from '@brainstack/core/pg';
import type { Logger } from 'pino';

import { ApiKeyService, type ApiKey } from './services/ApiKeyService.js';
import { AuthService, type User } from './services/AuthService.js';
import { CrawlHistoryService } from './services/CrawlHistoryService.js';
import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { createEmailSender, type EmailConfig } from './services/EmailSender.js';
import { GoogleOAuthService } from './services/GoogleOAuthService.js';
import { InviteService } from './services/InviteService.js';
import { NoteService } from './services/NoteService.js';
import { OAuthProviderService } from './services/OAuthProviderService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';
import { TotpService } from './services/TotpService.js';

export interface Services {
  db: PgDb;
  notes: NoteService;
  search: SearchService;
  auth: AuthService;
  apiKeys: ApiKeyService;
  sharing: SharingService;
  invites: InviteService;
  totp: TotpService;
  oauthProvider: OAuthProviderService;
  crossOwner: CrossOwnerReader;
  /** What `gather_context` gave each user, for the Crawl view. */
  crawls: CrawlHistoryService;
  /** Present only when Google credentials are configured. */
  google?: GoogleOAuthService;
  resolveUserForApiKey(apiKey: ApiKey): Promise<User>;
}

export interface BuildServicesOptions {
  db: PgDb;
  logger: Logger;
  publicOrigin: string;
  /** Origin of the web app, when it differs from this server's. */
  appOrigin?: string;
  authorizedEmails: Set<string>;
  /** Must match the `basePath` given to `buildApp`. */
  apiBasePath?: string;
  /** Resend or SMTP. Leave it out and the instance sends no email at all. */
  email?: EmailConfig;
  /** Let anyone create an account. See AuthService's sign-up policy. */
  openSignup?: boolean;
  googleClientId?: string | undefined;
  googleClientSecret?: string | undefined;
  googleRedirectUri?: string | undefined;
  /** Days crawls are kept for the Crawl view; 0 turns the history off. Default 30. */
  crawlHistoryDays?: number;
}

export function buildServices(opts: BuildServicesOptions): Services {
  const emailSender = createEmailSender(opts.email ?? {});

  // Before NoteService, which needs it to clean up after a folder it removes.
  const sharing = new SharingService({ db: opts.db });

  const notes = new NoteService({
    db: opts.db,
    store: new PgNoteStore(opts.db),
    onFolderGone: async (ownerId, folderPath) => {
      await sharing.revokeUnder({ ownerId, folderPath });
    },
    onFolderMoved: async (ownerId, from, to) => {
      await sharing.reparentUnder({ ownerId, from, to });
    },
  });
  const search = new SearchService({ db: opts.db, search: new PgSearchService(opts.db) });

  const totp = new TotpService({ db: opts.db, issuer: 'BrainStack' });
  const oauthProvider = new OAuthProviderService({ db: opts.db });

  const auth = new AuthService({
    db: opts.db,
    email: emailSender,
    logger: opts.logger,
    publicOrigin: opts.publicOrigin,
    ...(opts.appOrigin ? { appOrigin: opts.appOrigin } : {}),
    authorizedEmails: opts.authorizedEmails,
    openSignup: opts.openSignup ?? false,
    ...(opts.apiBasePath ? { apiBasePath: opts.apiBasePath } : {}),
    totp,
  });

  const invites = new InviteService({
    db: opts.db,
    email: emailSender,
    sharing,
    // The accept link is an endpoint on this server, not a page on the web
    // app: same origin and same prefix as the verification and reset links.
    // Handing out the app's origin instead is what made every invite 404.
    publicOrigin: opts.publicOrigin,
    ...(opts.apiBasePath ? { apiBasePath: opts.apiBasePath } : {}),
  });

  const crossOwner = new CrossOwnerReader({ db: opts.db, sharing });

  const crawls = new CrawlHistoryService({
    db: opts.db,
    retentionDays: opts.crawlHistoryDays ?? 30,
    logger: opts.logger,
  });

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
    notes,
    search,
    auth,
    apiKeys: new ApiKeyService({ db: opts.db }),
    sharing,
    invites,
    totp,
    oauthProvider,
    crossOwner,
    crawls,
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
