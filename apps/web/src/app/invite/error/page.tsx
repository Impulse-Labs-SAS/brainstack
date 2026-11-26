'use client';

// Error page for accepting an invitation. The REST endpoint
// /invite/accept/:token redirects here with ?reason=<AppError.code> when
// accepting fails (bad token, expired, revoked, and so on).

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const REASON_COPY: Record<string, { title: string; body: string }> = {
  not_found: {
    title: 'Invitation not found',
    body: 'The link may have been revoked, or it was copied incompletely.',
  },
  forbidden: {
    title: 'This invitation cannot be used',
    body: 'It was revoked, it has expired, or it was sent to another email address. If you have more than one account, sign in with the address it was sent to; otherwise ask the owner for a new one.',
  },
  invalid_input: {
    title: 'Invalid invitation',
    body: 'This invitation cannot be accepted from this account. An invitation you created is for someone else to open.',
  },
  already_exists: {
    title: 'You already accepted this invitation',
    body: 'Look for the folder under "Shared with me" in the sidebar.',
  },
  internal: {
    title: 'Something went wrong',
    body: 'The server could not accept the invitation. Try again in a while, or ask the owner for a new one.',
  },
};

function InviteErrorView() {
  const params = useSearchParams();
  const reason = (params.get('reason') ?? 'internal').toLowerCase();
  const copy = REASON_COPY[reason] ?? REASON_COPY.internal!;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-6 py-16">
      <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
        invitation · error
      </div>
      <h1 className="text-lg font-medium text-fg-primary">{copy.title}</h1>
      <p className="text-sm text-fg-secondary">{copy.body}</p>
      <div className="mt-2 font-mono text-[11px] text-fg-muted">reason: {reason}</div>
      <div className="mt-6 flex gap-3">
        <Link
          href="/notes"
          className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
        >
          Go to my notes
        </Link>
      </div>
    </div>
  );
}

export default function InviteErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-6 py-16 font-mono text-[11px] text-fg-muted">
          cargando…
        </div>
      }
    >
      <InviteErrorView />
    </Suspense>
  );
}
