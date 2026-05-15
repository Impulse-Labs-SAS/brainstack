'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setErrorMsg('Missing token.');
      return;
    }
    const url = `${process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000'}/auth/magic-link/callback?token=${encodeURIComponent(token)}`;
    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setStatus('error');
          setErrorMsg(body.error ?? 'Sign-in failed');
          return;
        }
        router.replace('/');
      })
      .catch(() => {
        setStatus('error');
        setErrorMsg('Network error');
      });
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base text-fg-secondary">
      {status === 'loading' ? 'Signing you in…' : `Error: ${errorMsg}`}
    </div>
  );
}

export default function MagicLinkCallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-fg-muted">…</div>}>
      <CallbackInner />
    </Suspense>
  );
}
