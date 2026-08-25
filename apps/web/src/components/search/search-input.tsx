'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSharingEnabled } from '@/lib/use-deployment';
import { trpc } from '@/lib/trpc';

type SearchScope = 'mine' | 'shared' | 'all';

const SCOPE_KEY = 'brainstack:search-scope';

interface SearchInputProps {
  autoFocus?: boolean;
  placeholder?: string;
  onPick?(): void;
  onActiveChange?(active: boolean): void;
  className?: string;
}

function notePathToRoute(
  path: string,
  ownerId: string | null | undefined,
  mineId: string | null,
): string {
  // An unknown viewer is treated as the owner: sending them to the shared view
  // of their own note is the worse of the two guesses.
  if (mineId !== null && ownerId && ownerId !== mineId) {
    return `/notes/shared/${encodeURIComponent(ownerId)}/${path.replace(/\.md$/i, '')}`;
  }
  return `/notes/${path.replace(/\.md$/i, '')}`;
}

export function SearchInput({
  autoFocus,
  placeholder = 'Search…',
  onPick,
  onActiveChange,
  className,
}: SearchInputProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const sharingEnabled = useSharingEnabled();
  const [scope, setScope] = useState<SearchScope>(() => {
    if (typeof window === 'undefined') return 'mine';
    const s = window.localStorage.getItem(SCOPE_KEY);
    return s === 'shared' || s === 'all' ? s : 'mine';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SCOPE_KEY, scope);
  }, [scope]);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(h);
  }, [query]);

  useEffect(() => {
    onActiveChange?.(query.trim().length > 0);
  }, [query, onActiveChange]);

  const me = trpc.auth.me.useQuery();
  // Null, not '', while the query is in flight. An empty string compares
  // unequal to every owner id, which marked every hit — including your own
  // notes — as shared, and routed clicks into the read-only shared view.
  const myId = me.data?.user?.id ?? null;

  const search = trpc.search.query.useQuery(
    { query: debounced, limit: 25, scope: sharingEnabled ? scope : 'mine' },
    { enabled: debounced.trim().length > 0 },
  );

  const onPickHit = (path: string, ownerId: string | null | undefined) => {
    router.push(notePathToRoute(path, ownerId, myId));
    setQuery('');
    onPick?.();
  };

  const hits = search.data ?? [];
  const active = debounced.trim().length > 0;
  // The scope selector filters results and nothing else. Parked above the tree
  // with an empty box it read as a filter on the tree, which it never was:
  // all three tabs showed the same vault. It belongs to the results, so it
  // appears with them — on the raw query, matching when the tree steps aside.
  const searching = query.trim().length > 0;

  return (
    <div className={cn('flex flex-col', active && 'h-full min-h-0', className)}>
      {/* pl-10 en teléfono: ahí el botón de menú flota sobre esta fila. */}
      <div className="flex items-center gap-2 p-2 pl-10 md:pl-2">
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) onPickHit(hits[0].path, hits[0].ownerId);
          }}
          placeholder={placeholder}
        />
        {sharingEnabled && searching && (
          <div className="flex shrink-0 rounded border border-border bg-bg-elevated p-0.5 font-mono text-[10px]">
            {(['mine', 'shared', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn(
                  'rounded px-2 py-0.5',
                  scope === s
                    ? 'bg-accent/20 text-fg-primary'
                    : 'text-fg-muted hover:text-fg-secondary',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {active && (
        <div className="flex-1 overflow-y-auto">
          {hits.map((hit) => {
            const isShared = myId !== null && Boolean(hit.ownerId) && hit.ownerId !== myId;
            return (
              <button
                key={`${hit.ownerId ?? ''}:${hit.path}`}
                type="button"
                onClick={() => onPickHit(hit.path, hit.ownerId)}
                className="block w-full border-b border-border-subtle px-3 py-2 text-left transition-colors hover:bg-bg-elevated"
              >
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium text-fg-primary">{hit.title}</div>
                  {isShared && (
                    <span className="rounded border border-border-subtle px-1 py-0 font-mono text-[9px] uppercase text-fg-muted">
                      shared
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-fg-muted">{hit.path}</div>
                <div
                  className="mt-1 text-xs text-fg-secondary [&_mark]:rounded [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-fg-primary"
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
              </button>
            );
          })}
          {hits.length === 0 && !search.isFetching && (
            <div className="px-4 py-8 text-center font-mono text-[11px] text-fg-muted">
              no results
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function useSearchActive(query: string): boolean {
  return query.trim().length > 0;
}
