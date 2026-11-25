'use client';

// Where the link in the verification email lands. Opening it verifies
// nothing: the address is confirmed with the password the account was created
// with, so that whoever picked that password is the one who ends up signed in.
// Somebody who did not create the account can use "forgot password" instead.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { BrandLockup } from '@/components/ui/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <BrandLockup className="mb-5 block h-5 text-fg-primary" />
        {children}
      </div>
    </div>
  );
}

function ConfirmForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await authFetch('/auth/verify-email', { method: 'POST', json: { token, password } });
      router.replace('/?verified=1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <h1 className="mb-2 text-xl font-medium text-fg-primary">Confirm your email</h1>
      <p className="mb-6 text-sm text-fg-secondary">
        Enter the password you chose when you signed up to finish.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="verify-password" className="mb-1 block font-mono text-[11px] text-fg-muted">
            PASSWORD
          </label>
          <Input
            id="verify-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </div>
        {error && <div className="text-xs text-danger">{error}</div>}
        <Button intent="primary" type="submit" isDisabled={pending || !password} className="w-full">
          {pending ? 'Confirming…' : 'Confirm email'}
        </Button>
      </form>
      <p className="mt-6 text-xs text-fg-muted">
        Didn&apos;t sign up, or don&apos;t know this password?{' '}
        <Link href="/forgot-password" className="text-fg-secondary hover:text-fg-primary">
          Set a new one
        </Link>
        .
      </p>
    </Card>
  );
}

function VerifyInner() {
  const params = useSearchParams();
  const token = params.get('token');
  const error = params.get('error');

  if (token && !error) return <ConfirmForm token={token} />;

  return (
    <Card>
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
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-fg-muted">…</div>}>
      <VerifyInner />
    </Suspense>
  );
}
