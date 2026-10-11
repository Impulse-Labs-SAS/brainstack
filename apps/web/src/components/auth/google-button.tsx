'use client';

// "Continue with Google", where the instance has it. The server mounts the
// Google routes only when a client id and secret are configured, and says so
// in /config; a button that led to a 404 elsewhere is worse than none.

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/server-url';
import { googleSignInHref } from '@/lib/authApi';

export function GoogleButton({ redirectTo }: { redirectTo?: string | null }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${apiBase()}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((config: { features?: { google?: boolean } } | null) => {
        if (live) setEnabled(config?.features?.google === true);
      })
      .catch(() => {
        // No config, no button: password sign-in still works.
      });
    return () => {
      live = false;
    };
  }, []);

  if (!enabled) return null;

  // Only a path on this site travels along; the server checks it again.
  const target =
    redirectTo?.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : undefined;

  return (
    <>
      <div className="my-4 flex items-center gap-3 font-mono text-[11px] text-fg-muted">
        <span className="h-px flex-1 bg-border-subtle" />
        or
        <span className="h-px flex-1 bg-border-subtle" />
      </div>
      <a
        href={googleSignInHref(target)}
        className="flex h-8 w-full items-center justify-center rounded-md border border-border bg-bg-elevated text-sm font-medium text-fg-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Continue with Google
      </a>
    </>
  );
}
