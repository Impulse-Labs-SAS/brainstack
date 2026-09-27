'use client';

// Minimal browse-by-tag view — where a tag chip in the Ecosystem section
// lands. Not a redesign of /notes, just a filtered list.

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { trpc } from '@/lib/trpc';
import { notePathToRoute } from '@/lib/wikilinks-client';

export default function TagPage() {
  const params = useParams<{ tag: string }>();
  const tag = decodeURIComponent(params.tag ?? '');

  const notes = trpc.notes.list.useQuery({ tag }, { enabled: !!tag });

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto p-6">
        <div className="mb-4">
          <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">tag</div>
          <h1 className="text-lg font-medium text-fg-primary">{tag}</h1>
        </div>
        {notes.data && notes.data.length === 0 && (
          <div className="text-sm text-fg-muted">No notes with this tag.</div>
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
