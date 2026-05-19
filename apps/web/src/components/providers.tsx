'use client';

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { type ReactNode, useState } from 'react';

import { trpc, trpcClientConfig } from '@/lib/trpc';

// When the server reports the session is gone (stale or rotated cookie),
// clear it server-side and bounce to /login. The cookie is HttpOnly so JS
// can't delete it — without the logout call the Next middleware would still
// see the cookie, redirect /login back to /notes, and we'd loop forever.
let authRedirectInFlight = false;
function handleAuthError(err: unknown) {
  if (!(err instanceof TRPCClientError)) return;
  if (err.data?.code !== 'UNAUTHORIZED') return;
  if (typeof window === 'undefined') return;
  if (authRedirectInFlight) return;
  if (window.location.pathname === '/login') return;
  authRedirectInFlight = true;
  const here = window.location.pathname + window.location.search;
  const serverUrl =
    process.env.NEXT_PUBLIC_SERVER_URL ?? window.location.origin.replace(':3001', ':3000');
  const target = new URL('/login', window.location.origin);
  if (here && here !== '/') target.searchParams.set('redirect_to', here);
  fetch(`${serverUrl}/auth/logout`, { method: 'POST', credentials: 'include' })
    .catch(() => {})
    .finally(() => {
      window.location.replace(target.toString());
    });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
        },
        queryCache: new QueryCache({ onError: handleAuthError }),
        mutationCache: new MutationCache({ onError: handleAuthError }),
      }),
  );
  const [client] = useState(() => trpc.createClient(trpcClientConfig()));

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
