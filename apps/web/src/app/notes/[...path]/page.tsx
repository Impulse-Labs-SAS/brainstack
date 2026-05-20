'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { useParams } from 'next/navigation';
import { keepPreviousData } from '@tanstack/react-query';

const MAX_TREE_DEPTH = 20;
const SPLIT_MIN_WIDTH = 900;

import { Columns, Eye, Pencil } from 'lucide-react';

import { BLOCKED_UPLOAD_MESSAGE, isBlockedUpload } from '@/lib/uploads';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { NoteEditor } from '@/components/editor/note-editor';
import { MarkdownPreview } from '@/components/editor/markdown-preview';
import { Kbd } from '@/components/ui/kbd';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { usePersistedViewMode, type ViewMode } from '@/lib/use-view-mode';
import {
  buildIndex,
  resolveEmbed as resolveEmbedClient,
  resolveNoteTarget,
  encodePath,
} from '@/lib/wikilinks-client';

export default function NotePage() {
  const params = useParams<{ path: string[] }>();
  const path = decodeURIComponent((params.path ?? []).join('/'));

  const note = trpc.notes.get.useQuery(
    { path },
    { enabled: !!path, placeholderData: keepPreviousData },
  );
  const backlinks = trpc.notes.backlinks.useQuery(
    { path },
    { enabled: !!path, placeholderData: keepPreviousData },
  );
  const update = trpc.notes.update.useMutation();
  const upload = trpc.notes.uploadAttachment.useMutation();
  const tree = trpc.notes.tree.useQuery({ depth: MAX_TREE_DEPTH });

  const treeIndex = useMemo(() => buildIndex(tree.data ?? null), [tree.data]);

  const [viewMode, setViewMode] = usePersistedViewMode('edit');
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(`(max-width: ${SPLIT_MIN_WIDTH - 1}px)`);
    const apply = (): void => setNarrow(mql.matches);
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, []);
  const effectiveMode: ViewMode = narrow && viewMode === 'split' ? 'edit' : viewMode;

  // Note path WITH .md extension for the resolver — the URL strips it.
  const sourcePath = useMemo(() => (path.toLowerCase().endsWith('.md') ? path : `${path}.md`), [path]);

  const resolveLink = useCallback(
    (target: string): { href: string; resolved: boolean } => {
      const notePath = resolveNoteTarget(target, sourcePath, treeIndex);
      if (notePath) {
        return { href: `/notes/${encodePath(notePath.replace(/\.md$/i, ''))}`, resolved: true };
      }
      return {
        href: `/notes/${encodePath(target.replace(/\.md$/i, ''))}`,
        resolved: false,
      };
    },
    [sourcePath, treeIndex],
  );

  const resolveEmbed = useCallback(
    (target: string) => resolveEmbedClient(target, sourcePath, treeIndex),
    [sourcePath, treeIndex],
  );

  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 320);
  const [backlinksWidth, setBacklinksWidth] = usePersistedWidth(
    'brainstack:notes-backlinks-width',
    280,
  );

  const [draft, setDraft] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;

  // Init the draft once the query has *fresh* data for the current path.
  // With keepPreviousData, note.data is the previous note while loading, so
  // we gate on (!isPlaceholderData && draftPath !== path) to avoid loading
  // the wrong content into the editor.
  useEffect(() => {
    if (!note.data || note.isPlaceholderData) return;
    if (draftPath === path) return;
    setDraft(reconstructBody(note.data));
    setDraftPath(path);
    setSavedAt(null);
  }, [note.data, note.isPlaceholderData, path, draftPath]);

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

      const inserted: string[] = [];
      for (const file of files) {
        if (isBlockedUpload({ mime: file.type, filename: file.name })) {
          setUploadError(`${file.name}: ${BLOCKED_UPLOAD_MESSAGE}`);
          continue;
        }
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

  const treePanel = (
    <ResizablePanel
      side="left"
      width={treeWidth}
      onWidthChange={setTreeWidth}
      min={200}
      max={560}
      className="border-r border-border-subtle"
    >
      <FileTree />
    </ResizablePanel>
  );

  if (!note.data && note.isLoading) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {treePanel}
          <div className="flex flex-1 items-center justify-center text-fg-muted">Loading…</div>
        </div>
      </AppShell>
    );
  }

  if (!note.data) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {treePanel}
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-fg-muted">
            note not found: {path}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full overflow-hidden">
        {treePanel}

        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
            <div>
              <div className="text-sm font-medium text-fg-primary">{note.data.title}</div>
              <div className="font-mono text-[11px] text-fg-muted">{path}</div>
            </div>
            <div className="flex items-center gap-3">
              <ViewModeToggle
                value={effectiveMode}
                onChange={setViewMode}
                splitDisabled={narrow}
              />
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
            {draft !== null && effectiveMode === 'edit' && (
              <NoteEditor value={draft} onChange={setDraft} />
            )}
            {draft !== null && effectiveMode === 'preview' && (
              <MarkdownPreview
                body={stripFrontmatter(draft)}
                frontmatter={note.data.frontmatter}
                resolveLink={resolveLink}
                resolveEmbed={resolveEmbed}
              />
            )}
            {draft !== null && effectiveMode === 'split' && (
              <div className="grid h-full grid-cols-2 divide-x divide-border-subtle">
                <div className="h-full overflow-hidden">
                  <NoteEditor value={draft} onChange={setDraft} />
                </div>
                <div className="h-full overflow-hidden">
                  <MarkdownPreview
                    body={stripFrontmatter(draft)}
                    frontmatter={note.data.frontmatter}
                    resolveLink={resolveLink}
                    resolveEmbed={resolveEmbed}
                  />
                </div>
              </div>
            )}
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

        <ResizablePanel
          side="right"
          width={backlinksWidth}
          onWidthChange={setBacklinksWidth}
          min={200}
          max={480}
          className="border-l border-border-subtle"
        >
          <aside className="h-full overflow-y-auto p-4">
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
        </ResizablePanel>
      </div>
    </AppShell>
  );
}

function ViewModeToggle({
  value,
  onChange,
  splitDisabled,
}: {
  value: ViewMode;
  onChange(m: ViewMode): void;
  splitDisabled: boolean;
}) {
  const btn = (m: ViewMode, label: string, icon: React.ReactNode, disabled = false) => (
    <button
      key={m}
      type="button"
      disabled={disabled}
      onClick={() => onChange(m)}
      title={label}
      className={cn(
        'flex h-7 w-7 items-center justify-center transition-colors',
        value === m
          ? 'bg-bg-elevated text-fg-primary'
          : 'text-fg-muted hover:bg-bg-elevated hover:text-fg-secondary',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-fg-muted',
      )}
      aria-pressed={value === m}
      aria-label={label}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex items-center divide-x divide-border-subtle overflow-hidden rounded border border-border-subtle">
      {btn('edit', 'Edit', <Pencil size={12} strokeWidth={1.75} />)}
      {btn('preview', 'Preview', <Eye size={12} strokeWidth={1.75} />)}
      {btn('split', 'Split', <Columns size={12} strokeWidth={1.75} />, splitDisabled)}
    </div>
  );
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const after = content.slice(end + 4);
  return after.startsWith('\n') ? after.slice(1) : after;
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
