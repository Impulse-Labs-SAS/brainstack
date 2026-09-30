'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // null until submitted; then whether a verification email went out. The first
  // account on an instance is its owner and is verified straight away.
  const [done, setDone] = useState<{ verificationSent: boolean } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authFetch<{ verificationSent: boolean }>('/auth/signup', {
        method: 'POST',
        json: { email, password, displayName: displayName || undefined },
      });
      setDone({ verificationSent: result.verificationSent });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signup failed');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
          <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
          {done.verificationSent ? (
            <>
              <h1 className="mb-3 text-xl font-medium text-fg-primary">Check your email</h1>
              <p className="text-sm text-fg-secondary">
                We sent a verification link to <b>{email}</b>. Click it to finish creating your
                account.
              </p>
              <Link href="/login" className="mt-6 inline-block text-xs text-fg-muted hover:text-fg-primary">
                ← Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="mb-3 text-xl font-medium text-fg-primary">Your account is ready</h1>
              <p className="text-sm text-fg-secondary">
                <b>{email}</b> is the first account on this instance, so it needs no email
                verification. Sign-up is now closed to everyone else.
              </p>
              <Link href="/login" className="mt-6 inline-block text-sm text-accent hover:text-accent-hover">
                Sign in →
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-6 text-xl font-medium text-fg-primary">Create account</h1>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block font-mono text-[11px] text-fg-muted">NAME</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="optional"
              autoComplete="name"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[11px] text-fg-muted">EMAIL</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              autoComplete="new-password"
              required
            />
            <div className="mt-1 text-[11px] text-fg-muted">
              At least 12 chars + 3 of: lower, upper, digit, symbol.
            </div>
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
          <Button
            intent="primary"
            type="submit"
            isDisabled={pending || !email || !password}
            className="w-full"
          >
            {pending ? 'Creating…' : 'Create account'}
          </Button>
        </form>

        <div className="mt-6 text-xs text-fg-muted">
          Already have an account?{' '}
          <Link href="/login" className="hover:text-fg-primary">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
