'use client';

import { useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { GraphView } from '@/components/graph/graph-view';
import { useSharingEnabled } from '@/lib/use-deployment';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

export default function GraphPage() {
  const sharingEnabled = useSharingEnabled();
  const [includeShared, setIncludeShared] = useState(false);
  const { data, isLoading, error } = trpc.notes.graph.useQuery({
    scope: includeShared && sharingEnabled ? 'all' : 'mine',
  });
  // Which nodes are somebody else's, and so open under the shared route.
  const me = trpc.auth.me.useQuery();

  return (
    <AppShell>
      <div className="flex h-full w-full flex-col overflow-hidden">
        {sharingEnabled && (
          <div className="flex items-center justify-end border-b border-border-subtle bg-bg-surface px-4 py-1.5 font-mono text-[11px] text-fg-muted">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={includeShared}
                onChange={(e) => setIncludeShared(e.target.checked)}
                className="h-3 w-3 accent-accent"
              />
              <span className={cn(includeShared && 'text-fg-primary')}>incluir compartidos</span>
            </label>
          </div>
        )}
        {isLoading && (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-fg-muted">
            loading graph…
          </div>
        )}
        {error && (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-red-400">
            {error.message}
          </div>
        )}
        {data && (
          <GraphView nodes={data.nodes} edges={data.edges} viewerId={me.data?.user?.id ?? null} />
        )}
      </div>
    </AppShell>
  );
}
