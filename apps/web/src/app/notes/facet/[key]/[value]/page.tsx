'use client';

// Minimal browse-by-facet view — where a facet chip in the Ecosystem section
// lands. Not a redesign of /notes, just a filtered list.

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { trpc } from '@/lib/trpc';
import { notePathToRoute } from '@/lib/wikilinks-client';

export default function FacetPage() {
  const params = useParams<{ key: string; value: string }>();
  const key = decodeURIComponent(params.key ?? '');
  const value = decodeURIComponent(params.value ?? '');

  const notes = trpc.notes.list.useQuery(
    { facetKey: key, facetValue: value },
    { enabled: !!key && !!value },
  );

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto p-6">
        <div className="mb-4">
          <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">{key}</div>
          <h1 className="text-lg font-medium text-fg-primary">{value}</h1>
        </div>
        {notes.data && notes.data.length === 0 && (
          <div className="text-sm text-fg-muted">Ninguna nota con esta faceta.</div>
        )}
        <ul className="max-w-xl space-y-1">
          {(notes.data ?? []).map((n) => (
            <li key={n.path}>
              <Link
                href={notePathToRoute(n.path)}
                className="block truncate rounded px-2 py-1 text-sm text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary"
              >
                {n.title}
                <span className="ml-2 font-mono text-[11px] text-fg-muted">{n.path}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
