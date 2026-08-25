'use client';

import Link from 'next/link';

import { AppShell } from '@/components/layout/app-shell';
import { trpc } from '@/lib/trpc';

export default function SettingsPage() {
  const me = trpc.auth.me.useQuery();
  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Settings
      </div>
      <div className="flex-1 overflow-y-auto p-6 text-sm">
        <div className="mb-6 max-w-xl">
          <h2 className="mb-1 text-base font-medium text-fg-primary">Account</h2>
          <div className="font-mono text-xs text-fg-muted">{me.data?.user?.email ?? 'Not signed in'}</div>
        </div>
        <div className="max-w-xl space-y-3">
          <Link href="/settings/account" className="block rounded border border-border bg-bg-surface p-3 hover:bg-bg-elevated">
            <div className="text-fg-primary">Account</div>
            <div className="text-xs text-fg-muted">Password, Google sign-in, 2FA, sessions.</div>
          </Link>
          <Link href="/settings/api-keys" className="block rounded border border-border bg-bg-surface p-3 hover:bg-bg-elevated">
            <div className="text-fg-primary">API keys</div>
            <div className="text-xs text-fg-muted">Manage tokens for MCP clients (Claude, Cursor, …).</div>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
