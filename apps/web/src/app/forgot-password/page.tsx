'use client';

import Link from 'next/link';
import { useState } from 'react';

import { BrandLockup } from '@/components/ui/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthApiError, authFetch } from '@/lib/authApi';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<'sent' | 'no-email' | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await authFetch('/auth/forgot-password', {
        method: 'POST',
        json: { email },
      });
      setDone('sent');
    } catch (err) {
      // Anything else still reads as success, so an address reveals nothing.
      setDone(err instanceof AuthApiError && err.code === 'UNAVAILABLE' ? 'no-email' : 'sent');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
          <BrandLockup className="mb-5 block h-5 text-fg-primary" />
          {done === 'sent' ? (
            <>
              <h1 className="mb-3 text-xl font-medium text-fg-primary">Check your email</h1>
              <p className="text-sm text-fg-secondary">
                If <b>{email}</b> has an account, we sent a reset link. The link expires in one hour.
              </p>
            </>
          ) : (
            <>
              <h1 className="mb-3 text-xl font-medium text-fg-primary">This server sends no email</h1>
              <p className="text-sm text-fg-secondary">
                It cannot mail you a reset link. Whoever runs it can give you a new password with its{' '}
                <code className="font-mono text-fg-primary">reset-password</code> command.
              </p>
            </>
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
        <BrandLockup className="mb-5 block h-5 text-fg-primary" />
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
