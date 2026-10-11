// Mounts the tRPC router under /trpc using the fetch adapter. The fetch
// adapter is the right fit for Hono since `c.req.raw` is already a Fetch
// Request — no need to drop down to Node's req/res like we do for MCP.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { getCookie } from 'hono/cookie';

import type { ApiKey, ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService, User } from '../../services/AuthService.js';
import type { CrawlHistoryService } from '../../services/CrawlHistoryService.js';
import type { CrossOwnerReader } from '../../services/CrossOwnerReader.js';
import type { NoteService } from '../../services/NoteService.js';
import type { OAuthProviderService } from '../../services/OAuthProviderService.js';
import type { InviteService } from '../../services/InviteService.js';
import type { SearchService } from '../../services/SearchService.js';
import type { SharingService } from '../../services/SharingService.js';
import { MAX_TRPC_BATCH } from '../../config/limits.js';
import { toAppError } from '../../lib/errors.js';
import { SESSION_COOKIE, type AuthBindings, type Principal } from '../middleware/auth.js';
import { buildContext } from '../../trpc/context.js';
import { appRouter } from '../../trpc/router.js';

export interface TrpcRouterOptions {
  notes: NoteService;
  search: SearchService;
  auth: AuthService;
  apiKeys: ApiKeyService;
  sharing: SharingService;
  invites: InviteService;
  crossOwner: CrossOwnerReader;
  crawls: CrawlHistoryService;
  oauth?: OAuthProviderService;
  resolveUserForApiKey(apiKey: ApiKey): Promise<User>;
  /** Where failures the client is not told about are written. */
  logger?: Logger;
  /**
   * The URL this router answers on, prefix included.
   *
   * tRPC strips this from the path to find the procedure name, so a router
   * mounted under `/api` has to be told — otherwise every call 404s, and only
   * once deployed, because development had no prefix.
   */
  endpoint?: string;
}

export function createTrpcRouter(options: TrpcRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();

  router.all('*', async (c) => {
    const principal = await resolvePrincipal(c, options);

    const response = await fetchRequestHandler({
      endpoint: options.endpoint ?? '/trpc',
      req: c.req.raw,
      router: appRouter,
      // Batched calls run concurrently; without a cap one request could carry
      // hundreds of them past any per-request limit.
      maxBatchSize: MAX_TRPC_BATCH,
      onError: ({ error, path }) => {
        // The client gets "internal error"; the self-hoster gets the cause.
        if (error.code === 'INTERNAL_SERVER_ERROR' && !toAppError(error.cause)) {
          options.logger?.error({ err: error.cause ?? error, procedure: path }, 'tRPC failed');
        }
      },
      createContext: () =>
        buildContext(
          {
            auth: options.auth,
            apiKeys: options.apiKeys,
            notes: options.notes,
            search: options.search,
            sharing: options.sharing,
            invites: options.invites,
            crossOwner: options.crossOwner,
            crawls: options.crawls,
            ...(options.oauth ? { oauth: options.oauth } : {}),
          },
          principal,
        ),
    });
    return response;
  });

  return router;
}

async function resolvePrincipal(
  c: { req: { header(name: string): string | undefined } },
  options: TrpcRouterOptions,
): Promise<Principal | null> {
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const apiKey = await options.apiKeys.validate(authHeader.slice(7).trim());
    if (apiKey) {
      const user = await options.resolveUserForApiKey(apiKey);
      return { kind: 'apiKey', apiKey, user };
    }
  }
  const sessionToken = getCookie(c as unknown as Parameters<typeof getCookie>[0], SESSION_COOKIE);
  if (sessionToken) {
    const user = await options.auth.validateSession(sessionToken);
    if (user) return { kind: 'user', user };
  }
  return null;
}
