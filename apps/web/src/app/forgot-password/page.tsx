'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await authFetch('/auth/forgot-password', {
        method: 'POST',
        json: { email },
      });
    } catch {
      // Always pretend success to avoid email enumeration.
    } finally {
      setPending(false);
      setDone(true);
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
