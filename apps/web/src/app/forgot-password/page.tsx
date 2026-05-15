'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';

interface ForgotResult {
  ok: boolean;
  resetUrl?: string;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ devUrl?: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const result = await authFetch<ForgotResult>('/auth/forgot-password', {
        method: 'POST',
        json: { email },
      });
      setDone({ devUrl: result.resetUrl });
    } catch {
      // Always pretend success to avoid email enumeration.
      setDone({});
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
          <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
          <h1 className="mb-3 text-xl font-medium text-fg-primary">Check your email</h1>
          <p className="text-sm text-fg-secondary">
            If <b>{email}</b> has an account, we sent a reset link. The link expires in one hour.
          </p>
          {done.devUrl && (
            <div className="mt-4 rounded-md border border-warning bg-bg-elevated p-3 text-xs">
              <div className="mb-1 font-mono text-warning">DEV MODE — use this link</div>
              <a
                href={done.devUrl}
                className="block break-all rounded bg-bg-base p-2 font-mono text-fg-primary"
              >
                {done.devUrl}
              </a>
            </div>
          )}
          <Link href="/login" className="mt-6 inline-block text-xs text-fg-muted hover:text-fg-primary">
            ← Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-6 text-xl font-medium text-fg-primary">Reset your password</h1>
        <form onSubmit={submit} className="space-y-4">
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
          <Button intent="primary" type="submit" isDisabled={pending || !email} className="w-full">
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
        <Link href="/login" className="mt-6 inline-block text-xs text-fg-muted hover:text-fg-primary">
          ← Back to sign in
        </Link>
      </div>
    </div>
  );
}
