'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthApiError, authFetch } from '@/lib/authApi';

interface LoginResult {
  user: { id: string };
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialError = params.get('error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await authFetch<LoginResult>('/auth/login', {
        method: 'POST',
        json: { email, password, totpCode: totpCode || undefined },
      });
      // The middleware (and the OAuth authorize endpoint) preserve where the
      // user was headed in ?redirect_to. Relative paths only — anything with a
      // host in it is someone else's destination, not ours. API paths (the
      // OAuth consent screen) are not client routes, so those take a full
      // navigation instead of the router.
      const redirectTo = params.get('redirect_to');
      if (
        redirectTo?.startsWith('/') &&
        !redirectTo.startsWith('//') &&
        !redirectTo.startsWith('/\\')
      ) {
        if (redirectTo.startsWith('/api/')) {
          window.location.replace(redirectTo);
          return;
        }
        router.replace(redirectTo);
        return;
      }
      router.replace('/');
    } catch (err) {
      if (err instanceof AuthApiError && err.message.toLowerCase().includes('totp code required')) {
        setNeedsTotp(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'sign-in failed');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-6 text-xl font-medium text-fg-primary">Sign in</h1>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block font-mono text-[11px] text-fg-muted">EMAIL</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[11px] text-fg-muted">PASSWORD</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {needsTotp && (
            <div>
              <label className="mb-1 block font-mono text-[11px] text-fg-muted">2FA CODE</label>
              <Input
                inputMode="numeric"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123 456 or backup code"
                autoComplete="one-time-code"
                required
              />
            </div>
          )}
          {error && <div className="text-xs text-danger">{error}</div>}
          <Button
            intent="primary"
            type="submit"
            isDisabled={pending || !email || !password}
            className="w-full"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="mt-6 flex items-center justify-between text-xs text-fg-muted">
          <Link href="/signup" className="hover:text-fg-primary">
            Create account
          </Link>
          <Link href="/forgot-password" className="hover:text-fg-primary">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-fg-muted">…</div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
