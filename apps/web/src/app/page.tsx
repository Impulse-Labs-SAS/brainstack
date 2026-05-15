'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { trpc } from '@/lib/trpc';

export default function HomePage() {
  const router = useRouter();
  const me = trpc.auth.me.useQuery();
  const notes = trpc.notes.list.useQuery(
    { folder: 'Inbox', limit: 100 },
    { enabled: !!me.data?.user },
  );

  // Quick capture state.
  const [draft, setDraft] = useState('');
  const addToInbox = trpc.notes.addToInbox.useMutation({
    onSuccess: () => {
      setDraft('');
      void notes.refetch();
    },
  });

  useEffect(() => {
    if (me.data && me.data.user == null) {
      router.replace('/login');
    }
  }, [me.data, router]);

  if (!me.data) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center text-fg-muted">Loading…</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
        <div className="font-mono text-xs text-fg-muted">Inbox</div>
        <div className="flex items-center gap-2 text-fg-muted">
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>N</Kbd>
          <span className="text-xs">quick capture</span>
        </div>
      </div>

      <div className="border-b border-border-subtle p-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-bg-surface p-3 font-mono text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
          placeholder="Quick capture — drop a thought into the Inbox…"
        />
        <div className="mt-2 flex justify-end">
          <Button
            intent="primary"
            isDisabled={!draft.trim() || addToInbox.isPending}
            onPress={() => addToInbox.mutate({ content: draft.trim() })}
          >
            Add to Inbox
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ul className="divide-y divide-border-subtle">
          {(notes.data ?? []).map((note) => (
            <li
              key={note.path}
              className="cursor-pointer px-4 py-3 transition-colors hover:bg-bg-elevated"
              onClick={() => router.push(`/notes/${note.path}`)}
            >
              <div className="text-sm font-medium text-fg-primary">{note.title}</div>
              <div className="font-mono text-xs text-fg-muted">{note.path}</div>
            </li>
          ))}
          {notes.data && notes.data.length === 0 && (
            <li className="px-4 py-12 text-center text-fg-muted">
              Inbox is empty — capture a thought above.
            </li>
          )}
        </ul>
      </div>
    </AppShell>
  );
}
