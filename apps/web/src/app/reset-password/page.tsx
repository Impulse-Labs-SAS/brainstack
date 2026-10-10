'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { BrandLockup } from '@/components/ui/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';

function ResetInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setPending(true);
    try {
      await authFetch('/auth/reset-password', { method: 'POST', json: { token, password } });
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <BrandLockup className="mb-5 block h-5 text-fg-primary" />
        <h1 className="mb-6 text-xl font-medium text-fg-primary">Set a new password</h1>
        {!token ? (
          <div className="text-sm text-danger">Missing token. Use the link from your email.</div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1 block font-mono text-[11px] text-fg-muted">NEW PASSWORD</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[11px] text-fg-muted">CONFIRM</label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            <Button intent="primary" type="submit" isDisabled={pending || !password} className="w-full">
              {pending ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-fg-muted">…</div>}>
      <ResetInner />
    </Suspense>
  );
}
