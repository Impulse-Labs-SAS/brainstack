'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useParams } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { NoteEditor } from '@/components/editor/note-editor';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

export default function NotePage() {
  const params = useParams<{ path: string[] }>();
  const path = decodeURIComponent((params.path ?? []).join('/'));

  const note = trpc.notes.get.useQuery({ path }, { enabled: !!path });
  const backlinks = trpc.notes.backlinks.useQuery({ path }, { enabled: !!path });
  const update = trpc.notes.update.useMutation();
  const upload = trpc.notes.uploadAttachment.useMutation();

  const [draft, setDraft] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Most recent draft kept in a ref so the file-drop callback always sees the
  // current text without having to be re-created on every keystroke.
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;

  useEffect(() => {
    if (note.data && draft === null) {
      setDraft(reconstructBody(note.data));
    }
  }, [note.data, draft]);

  // Reset the draft when the user switches notes via a path change.
  useEffect(() => {
    setDraft(null);
    setSavedAt(null);
  }, [path]);

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

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setDropActive(false);
  };

  const onDrop = useCallback(
    async (e: ReactDragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDropActive(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // Upload one by one so a single failure doesn't take down the rest.
      const inserted: string[] = [];
      for (const file of files) {
        try {
          const dataBase64 = await readAsBase64(file);
          const dest = attachmentDestForFile(file);
          const finalPath = await upload.mutateAsync({
            path: dest,
            dataBase64,
            mime: file.type || undefined,
          });
          inserted.push(finalPath);
        } catch (err) {
          setUploadError(`${file.name}: ${(err as Error).message}`);
        }
      }
      if (inserted.length > 0) {
        const current = draftRef.current ?? '';
        const trail = current.endsWith('\n') ? '' : '\n';
        const next = current + trail + '\n' + inserted.map((p) => `![[${p}]]`).join('\n') + '\n';
        setDraft(next);
      }
    },
    [upload],
  );

  if (!note.data && note.isLoading) {
    return (
      <AppShell>
        <div className="grid h-full grid-cols-[320px_1fr]">
          <div className="border-r border-border-subtle">
            <FileTree />
          </div>
          <div className="flex h-full items-center justify-center text-fg-muted">Loading…</div>
        </div>
      </AppShell>
    );
  }

  if (!note.data) {
    return (
      <AppShell>
        <div className="grid h-full grid-cols-[320px_1fr]">
          <div className="border-r border-border-subtle">
            <FileTree />
          </div>
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-fg-muted">
            note not found: {path}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="grid h-full grid-cols-[320px_1fr_280px] overflow-hidden">
        <div className="border-r border-border-subtle">
          <FileTree />
        </div>

        <div className="flex flex-col overflow-hidden">
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
            <div>
              <div className="text-sm font-medium text-fg-primary">{note.data.title}</div>
              <div className="font-mono text-[11px] text-fg-muted">{path}</div>
            </div>
            <div className="font-mono text-[11px] text-fg-muted">
              {upload.isPending
                ? 'uploading…'
                : update.isPending
                  ? 'saving…'
                  : savedAt
                    ? `saved ${new Date(savedAt).toISOString().slice(11, 19)}`
                    : 'idle'}
            </div>
          </div>

          <div
            className={cn(
              'relative flex-1 overflow-hidden transition-colors',
              dropActive && 'bg-accent/5 ring-2 ring-inset ring-accent/60',
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {draft !== null && <NoteEditor value={draft} onChange={setDraft} />}
            {dropActive && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[12px] text-accent">
                drop to upload as attachment
              </div>
            )}
          </div>

          {uploadError && (
            <div className="border-t border-red-900/40 bg-red-950/40 px-4 py-1.5 font-mono text-[11px] text-red-300">
              {uploadError}{' '}
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="ml-2 underline"
              >
                dismiss
              </button>
            </div>
          )}
        </div>

        <aside className="overflow-y-auto border-l border-border-subtle p-4">
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] text-fg-muted">
            <Kbd>backlinks</Kbd>
          </div>
          <ul className="space-y-1">
            {(backlinks.data ?? []).map((link) => (
              <li key={`${link.sourcePath}-${link.linkKind}`}>
                <a
                  href={`/notes/${link.sourcePath.replace(/\.md$/i, '')}`}
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

function attachmentDestForFile(file: File): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const safeName = file.name.replace(/[/\\]+/g, '_');
  return `Attachments/${yyyy}/${mm}/${safeName}`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('unexpected reader result type'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
