'use client';

import { useMemo } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { GraphView } from '@/components/graph/graph-view';
import { useSharingEnabled } from '@/lib/use-deployment';
import { trpc } from '@/lib/trpc';

export default function GraphPage() {
  const sharingEnabled = useSharingEnabled();
  // Every vault the viewer can see; which of them are drawn is a layer, not a fetch.
  const { data, isLoading, error } = trpc.notes.graph.useQuery({ scope: sharingEnabled ? 'all' : 'mine' });
  // Which nodes are somebody else's, and so open under the shared route.
  const me = trpc.auth.me.useQuery();
  const affinity = trpc.notes.affinity.useQuery();
  const shared = trpc.sharing.listSharedWithMe.useQuery(undefined, { enabled: sharingEnabled });

  const ownerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const root of shared.data ?? []) {
      names.set(root.ownerId, root.ownerDisplayName ?? root.ownerEmail.split('@')[0] ?? root.ownerEmail);
    }
    return names;
  }, [shared.data]);

  return (
    <AppShell>
      <div className="flex h-full w-full flex-col overflow-hidden">
        {isLoading && (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-fg-muted">loading graph…</div>
        )}
        {error && (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-red-400">{error.message}</div>
        )}
        {/* Wait for the viewer: who owns what decides every vault and colour. */}
        {data && !me.isLoading && (
          <GraphView
            nodes={data.nodes}
            edges={data.edges}
            affinity={affinity.data ?? null}
            viewerId={me.data?.user?.id ?? null}
            ownerNames={ownerNames}
          />
        )}
      </div>
    </AppShell>
  );
}
