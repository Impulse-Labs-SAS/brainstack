// Mounts the tRPC router under /trpc using the fetch adapter. The fetch
// adapter is the right fit for Hono since `c.req.raw` is already a Fetch
// Request — no need to drop down to Node's req/res like we do for MCP.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { ApiKey, ApiKeyService } from '../../services/ApiKeyService.js';
import type { AuthService, User } from '../../services/AuthService.js';
import type { NoteService } from '../../services/NoteService.js';
import type { SearchService } from '../../services/SearchService.js';
import { SESSION_COOKIE, type AuthBindings, type Principal } from '../middleware/auth.js';
import { buildContext } from '../../trpc/context.js';
import { appRouter } from '../../trpc/router.js';

export interface TrpcRouterOptions {
  notes: NoteService;
  search: SearchService;
  auth: AuthService;
  apiKeys: ApiKeyService;
  resolveUserForApiKey(apiKey: ApiKey): User;
}

export function createTrpcRouter(options: TrpcRouterOptions): Hono<AuthBindings> {
  const router = new Hono<AuthBindings>();

  router.all('*', async (c) => {
    const principal = resolvePrincipal(c, options);

    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: c.req.raw,
      router: appRouter,
      createContext: () =>
        buildContext(
          {
            auth: options.auth,
            apiKeys: options.apiKeys,
            notes: options.notes,
            search: options.search,
          },
          principal,
        ),
    });
    return response;
  });

  return router;
}

function resolvePrincipal(
  c: { req: { header(name: string): string | undefined } },
  options: TrpcRouterOptions,
): Principal | null {
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const apiKey = options.apiKeys.validate(authHeader.slice(7).trim());
    if (apiKey) {
      const user = options.resolveUserForApiKey(apiKey);
      return { kind: 'apiKey', apiKey, user };
    }
  }
  const sessionToken = getCookie(c as unknown as Parameters<typeof getCookie>[0], SESSION_COOKIE);
  if (sessionToken) {
    const user = options.auth.validateSession(sessionToken);
    if (user) return { kind: 'user', user };
  }
  return null;
}
