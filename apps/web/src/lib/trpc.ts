// tRPC client bound to the apps/server runtime. Cookies are forwarded so the
// session middleware on the server picks the user up automatically.

import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

import type { AppRouter } from '@brainstack/server/src/trpc/router.js';

import { apiBase } from './server-url';

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function trpcClientConfig() {
  const url = `${apiBase()}/trpc`;
  return {
    links: [
      httpBatchLink({
        url,
        transformer: superjson,
        fetch(input, init) {
          return fetch(input, { ...init, credentials: 'include' });
        },
      }),
    ],
  };
}
