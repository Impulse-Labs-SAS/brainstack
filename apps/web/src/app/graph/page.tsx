'use client';

import { AppShell } from '@/components/layout/app-shell';
import { GraphView } from '@/components/graph/graph-view';
import { trpc } from '@/lib/trpc';

export default function GraphPage() {
  const { data, isLoading, error } = trpc.notes.graph.useQuery();

  return (
    <AppShell>
      <div className="flex h-full w-full flex-col overflow-hidden">
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
        {data && <GraphView nodes={data.nodes} edges={data.edges} />}
      </div>
    </AppShell>
  );
}
