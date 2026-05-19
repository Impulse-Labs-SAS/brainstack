'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

interface SearchInputProps {
  autoFocus?: boolean;
  placeholder?: string;
  onPick?(): void;
  onActiveChange?(active: boolean): void;
  className?: string;
}

function notePathToRoute(path: string): string {
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

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(h);
  }, [query]);

  useEffect(() => {
    onActiveChange?.(query.trim().length > 0);
  }, [query, onActiveChange]);

  const search = trpc.search.query.useQuery(
    { query: debounced, limit: 25 },
    { enabled: debounced.trim().length > 0 },
  );

  const onPickHit = (path: string) => {
    router.push(notePathToRoute(path));
    setQuery('');
    onPick?.();
  };

  const hits = search.data ?? [];
  const active = debounced.trim().length > 0;

  return (
    <div className={cn('flex flex-col', active && 'h-full min-h-0', className)}>
      <div className="p-2">
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) onPickHit(hits[0].path);
          }}
          placeholder={placeholder}
        />
      </div>
      {active && (
        <div className="flex-1 overflow-y-auto">
          {hits.map((hit) => (
            <button
              key={hit.path}
              type="button"
              onClick={() => onPickHit(hit.path)}
              className="block w-full border-b border-border-subtle px-3 py-2 text-left transition-colors hover:bg-bg-elevated"
            >
              <div className="text-sm font-medium text-fg-primary">{hit.title}</div>
              <div className="font-mono text-[11px] text-fg-muted">{hit.path}</div>
              <div
                className="mt-1 text-xs text-fg-secondary [&_mark]:rounded [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-fg-primary"
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
            </button>
          ))}
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
