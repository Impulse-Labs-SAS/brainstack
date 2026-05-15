// tRPC client bound to the apps/server runtime. Cookies are forwarded so the
// session middleware on the server picks the user up automatically.

import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

import type { AppRouter } from '@brainstack/server/src/trpc/router.js';

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function trpcClientConfig() {
  const url = `${
    typeof window === 'undefined'
      ? (process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000')
      : (process.env.NEXT_PUBLIC_SERVER_URL ?? window.location.origin.replace(':3001', ':3000'))
  }/trpc`;
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
