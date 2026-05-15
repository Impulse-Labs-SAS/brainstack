'use client';

import { useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const search = trpc.search.query.useQuery(
    { query, limit: 25 },
    { enabled: query.trim().length > 0 },
  );

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Search
      </div>
      <div className="border-b border-border-subtle p-4">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Full-text search across the brain…"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {search.data?.map((hit) => (
          <a
            key={hit.path}
            href={`/notes/${hit.path}`}
            className="block border-b border-border-subtle px-4 py-3 transition-colors hover:bg-bg-elevated"
          >
            <div className="text-sm font-medium text-fg-primary">{hit.title}</div>
            <div className="font-mono text-xs text-fg-muted">{hit.path}</div>
            <div
              className="mt-1 text-xs text-fg-secondary [&_mark]:rounded [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-fg-primary"
              dangerouslySetInnerHTML={{ __html: hit.snippet }}
            />
          </a>
        ))}
        {query.trim() && search.data?.length === 0 && (
          <div className="px-4 py-12 text-center text-fg-muted">No results.</div>
        )}
      </div>
    </AppShell>
  );
}
