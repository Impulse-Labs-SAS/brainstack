'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { NoteEditor } from '@/components/editor/note-editor';
import { Kbd } from '@/components/ui/kbd';
import { trpc } from '@/lib/trpc';

export default function NotePage() {
  const params = useParams<{ path: string[] }>();
  const path = decodeURIComponent((params.path ?? []).join('/'));

  const note = trpc.notes.get.useQuery({ path }, { enabled: !!path });
  const backlinks = trpc.notes.backlinks.useQuery({ path }, { enabled: !!path });
  const update = trpc.notes.update.useMutation();

  const [draft, setDraft] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (note.data && draft === null) {
      setDraft(reconstructBody(note.data));
    }
  }, [note.data, draft]);

  useEffect(() => {
    if (draft === null) return;
    const original = note.data ? reconstructBody(note.data) : null;
    if (original == null || original === draft) return;
    const handle = setTimeout(() => {
      update.mutate(
        { path, content: draft },
        { onSuccess: () => setSavedAt(Date.now()) },
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [draft, path, note.data, update]);

  if (!note.data) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center text-fg-muted">Loading…</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
        <div>
          <div className="text-sm font-medium text-fg-primary">{note.data.title}</div>
          <div className="font-mono text-[11px] text-fg-muted">{path}</div>
        </div>
        <div className="font-mono text-[11px] text-fg-muted">
          {update.isPending
            ? 'saving…'
            : savedAt
              ? `saved ${new Date(savedAt).toISOString().slice(11, 19)}`
              : 'idle'}
        </div>
      </div>
      <div className="grid flex-1 grid-cols-[1fr_280px] overflow-hidden">
        <div className="border-r border-border-subtle">
          {draft !== null && <NoteEditor value={draft} onChange={setDraft} />}
        </div>
        <aside className="overflow-y-auto p-4">
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] text-fg-muted">
            <Kbd>backlinks</Kbd>
          </div>
          <ul className="space-y-1">
            {(backlinks.data ?? []).map((link) => (
              <li key={`${link.sourcePath}-${link.linkKind}`}>
                <a
                  href={`/notes/${link.sourcePath}`}
                  className="block rounded px-2 py-1 text-xs text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary"
                >
                  <span className="font-mono">{link.sourcePath}</span>
                  <span className="ml-2 text-fg-muted">{link.linkKind}</span>
                </a>
              </li>
            ))}
            {backlinks.data && backlinks.data.length === 0 && (
              <li className="text-xs text-fg-muted">No backlinks yet.</li>
            )}
          </ul>
        </aside>
      </div>
    </AppShell>
  );
}

interface NoteData {
  frontmatter: Record<string, unknown>;
  body: string;
}

function reconstructBody(note: NoteData): string {
  if (Object.keys(note.frontmatter).length === 0) return note.body;
  const fmYaml = Object.entries(note.frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${fmYaml}\n---\n${note.body}`;
}
