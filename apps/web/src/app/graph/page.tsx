'use client';

import { keepPreviousData } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { GraphView } from '@/components/graph/graph-view';
import { useSharingEnabled } from '@/lib/use-deployment';
import { trpc } from '@/lib/trpc';

const INCLUDE_SHARED_KEY = 'brainstack.graph.includeShared';

// A per-browser preference; a blocked or private store falls back to the default.
function readIncludeShared(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(INCLUDE_SHARED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export default function GraphPage() {
  const sharingEnabled = useSharingEnabled();
  const [includeShared, setIncludeShared] = useState(readIncludeShared);
  const onIncludeSharedChange = useCallback((include: boolean) => {
    setIncludeShared(include);
    try {
      localStorage.setItem(INCLUDE_SHARED_KEY, String(include));
    } catch {
      // storage full or blocked; the choice lasts until the page closes
    }
  }, []);

  // Shared vaults are only fetched when included. Keeping the previous data
  // while the other scope loads keeps the graph, its camera and layout, on screen.
  const { data, isLoading, error } = trpc.notes.graph.useQuery(
    { scope: includeShared && sharingEnabled ? 'all' : 'mine' },
    { placeholderData: keepPreviousData },
  );
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
            includeShared={sharingEnabled ? includeShared : null}
            onIncludeSharedChange={onIncludeSharedChange}
          />
        )}
      </div>
    </AppShell>
  );
}
