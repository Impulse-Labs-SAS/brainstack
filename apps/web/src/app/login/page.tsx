'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { trpc } from '@/lib/trpc';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const mutation = trpc.auth.requestMagicLink.useMutation({
    onSuccess: () => setSent(true),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-6 text-xl font-medium text-fg-primary">Sign in to your brain</h1>
        {sent ? (
          <div className="text-sm text-fg-secondary">
            Check your inbox. Click the link to finish signing in. The link expires in 15 minutes.
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (email) mutation.mutate({ email });
            }}
            className="space-y-4"
          >
            <div>
              <label className="mb-1 block font-mono text-[11px] text-fg-muted">EMAIL</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
              />
            </div>
            <Button
              intent="primary"
              isDisabled={!email || mutation.isPending}
              onPress={() => mutation.mutate({ email })}
              className="w-full"
            >
              Send magic link
            </Button>
            <div className="flex items-center justify-between text-[11px] text-fg-muted">
              <span>No passwords. Ever.</span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> to send
              </span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
