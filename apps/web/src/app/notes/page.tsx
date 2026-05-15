'use client';

import Link from 'next/link';

import { AppShell } from '@/components/layout/app-shell';
import { trpc } from '@/lib/trpc';

export default function NotesPage() {
  const list = trpc.notes.list.useQuery({ limit: 200 });

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Notes
      </div>
      <div className="flex-1 overflow-y-auto">
        <ul className="divide-y divide-border-subtle">
          {(list.data ?? []).map((note) => (
            <li key={note.path}>
              <Link
                href={`/notes/${note.path}`}
                className="block px-4 py-3 transition-colors hover:bg-bg-elevated"
              >
                <div className="text-sm font-medium text-fg-primary">{note.title}</div>
                <div className="font-mono text-xs text-fg-muted">{note.path}</div>
              </Link>
            </li>
          ))}
          {list.data && list.data.length === 0 && (
            <li className="px-4 py-12 text-center text-fg-muted">
              No notes yet. Use the inbox to capture one.
            </li>
          )}
        </ul>
      </div>
    </AppShell>
  );
}
