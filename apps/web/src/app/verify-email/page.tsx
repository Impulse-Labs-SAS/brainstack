'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function VerifyInner() {
  const params = useSearchParams();
  const error = params.get('error');

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-3 text-xl font-medium text-fg-primary">
          {error ? 'Verification failed' : 'Email verified'}
        </h1>
        <p className="text-sm text-fg-secondary">
          {error
            ? `We couldn't verify your email (${error}). The link may have expired — sign in to resend.`
            : 'Your email is verified. You can now sign in.'}
        </p>
        <Link href="/login" className="mt-6 inline-block text-xs text-fg-muted hover:text-fg-primary">
          Go to sign in →
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-fg-muted">…</div>}>
      <VerifyInner />
    </Suspense>
  );
}
