'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { keepPreviousData } from '@tanstack/react-query';

const MAX_TREE_DEPTH = 20;
const SPLIT_MIN_WIDTH = 900;

import { ChevronLeft, Columns, Eye, Pencil } from 'lucide-react';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { NoteEditor } from '@/components/editor/note-editor';
import { MarkdownPreview } from '@/components/editor/markdown-preview';
import { EcosystemSection } from '@/components/ecosystem/ecosystem-section';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { usePersistedViewMode, type ViewMode } from '@/lib/use-view-mode';
import {
  attachmentPathToRoute,
  buildIndex,
  collectNoteCandidates,
  resolveAttachmentTarget,
  resolveEmbed as resolveEmbedClient,
  resolveNoteTarget,
  encodePath,
} from '@/lib/wikilinks-client';
import { splitWikilinkTarget } from '@/lib/wikilink-target';

export default function NotePage() {
  const params = useParams<{ path: string[] }>();
  /** What the URL carries: the note path with the `.md` stripped by the tree. */
  const urlPath = decodeURIComponent((params.path ?? []).join('/'));

  /**
   * What the server calls this note. Every path in the database ends in `.md`,
   * and the API rejects one that does not — so the extension the URL dropped
   * has to be put back before anything is asked for.
   */
  const path = useMemo(
    () => (urlPath.toLowerCase().endsWith('.md') ? urlPath : `${urlPath}.md`),
    [urlPath],
  );

  const note = trpc.notes.get.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const backlinks = trpc.notes.backlinks.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const outboundLinks = trpc.notes.outboundLinks.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const related = trpc.notes.related.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const facetsForNote = trpc.notes.facetsForNote.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const update = trpc.notes.update.useMutation();
  const tree = trpc.notes.tree.useQuery({ depth: MAX_TREE_DEPTH });
  const utils = trpc.useUtils();

  const treeIndex = useMemo(() => buildIndex(tree.data ?? null), [tree.data]);
  const wikilinkCandidates = useMemo(() => collectNoteCandidates(tree.data ?? null), [tree.data]);
  const wikilinkCandidatesRef = useRef(wikilinkCandidates);
  wikilinkCandidatesRef.current = wikilinkCandidates;
  const getWikilinkCandidates = useCallback(() => wikilinkCandidatesRef.current, []);

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

  const resolveLink = useCallback(
    (target: string): { href: string; resolved: boolean } => {
      // Extensión no-.md → tratamos el wikilink como referencia a attachment
      // y ruteamos a /files/<path>. Si no se encuentra, devolvemos /files/
      // con el target tal cual como link roto.
      const bare = splitWikilinkTarget(target).target;
      const dot = bare.lastIndexOf('.');
      const ext = dot > 0 ? bare.slice(dot + 1).toLowerCase() : '';
      if (ext && ext !== 'md') {
        const attPath = resolveAttachmentTarget(target, treeIndex);
        if (attPath) return { href: attachmentPathToRoute(attPath), resolved: true };
        return { href: `/files/${encodePath(bare)}`, resolved: false };
      }
      const notePath = resolveNoteTarget(target, path, treeIndex);
      if (notePath) {
        return { href: `/notes/${encodePath(notePath.replace(/\.md$/i, ''))}`, resolved: true };
      }
      return {
        href: `/notes/${encodePath(bare.replace(/\.md$/i, ''))}`,
        resolved: false,
      };
    },
    [path, treeIndex],
  );

  const resolveEmbed = useCallback(
    (target: string) => resolveEmbedClient(target, path, treeIndex),
    [path, treeIndex],
  );

  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 320);

  const meQ = trpc.auth.me.useQuery();
  const mine = meQ.data?.user?.id;

  const [draft, setDraft] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;

  /**
   * The body as the server last accepted it.
   *
   * Autosave used to compare the draft against `note.data`, which is not
   * refetched after a write — so once anything was typed the two never matched
   * again and it saved on a loop, 600ms apart, forever. That is what left the
   * indicator stuck on "saving…": there was always another write in flight.
   */
  const savedContentRef = useRef<string | null>(null);

  /** Stable across renders, unlike the mutation object it comes from. */
  const saveRef = useRef(update.mutate);
  saveRef.current = update.mutate;

  // Init the draft once the query has *fresh* data for the current path.
  // With keepPreviousData, note.data is the previous note while loading, so
  // we gate on (!isPlaceholderData && draftPath !== path) to avoid loading
  // the wrong content into the editor.
  useEffect(() => {
    if (!note.data || note.isPlaceholderData) return;
    if (draftPath === path) return;
    const body = reconstructBody(note.data);
    setDraft(body);
    setDraftPath(path);
    savedContentRef.current = body;
    setSavedAt(null);
  }, [note.data, note.isPlaceholderData, path, draftPath]);

  useEffect(() => {
    if (draft === null) return;
    // Belongs to the note on screen, not to one being navigated away from.
    if (draftPath !== path) return;
    if (draft === savedContentRef.current) return;

    const handle = setTimeout(() => {
      const pending = draft;
      saveRef.current(
        // Named explicitly: this is the note open in your own vault, so a
        // shared folder of the same name must not make it unwritable.
        { path, content: pending, ownerId: mine },
        {
          onSuccess: () => {
            savedContentRef.current = pending;
            setSavedAt(Date.now());
            // Links may have changed (wikilinks added/removed): the full
            // Graph view and this note's own ecosystem panels would
            // otherwise keep serving a stale, pre-edit snapshot.
            void utils.notes.graph.invalidate();
            void utils.notes.backlinks.invalidate();
            void utils.notes.outboundLinks.invalidate();
            void utils.notes.related.invalidate();
            void utils.notes.facetsForNote.invalidate();
          },
        },
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [draft, draftPath, path, mine, utils]);

  /*
   * El árbol y la nota no entran juntos en un teléfono. Cuál se ve lo decide
   * la ruta, que ya lo sabe: en `/notes` no hay nota y se ve el árbol; acá hay
   * una nota abierta y se ve ella, con una vuelta al árbol en la cabecera.
   */
  const treePanel = (
    <div className="hidden md:contents">
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
    </div>
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
          <div className="flex h-12 items-center justify-between gap-2 border-b border-border-subtle px-3 pl-10 md:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href="/notes"
                title="Volver al árbol"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary md:hidden"
              >
                <ChevronLeft size={16} />
              </Link>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg-primary">
                  {note.data.title}
                </div>
                <div className="truncate font-mono text-[11px] text-fg-muted">{path}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ViewModeToggle value={effectiveMode} onChange={setViewMode} splitDisabled={narrow} />
              <div className="font-mono text-[11px] text-fg-muted">
                {update.isPending
                  ? 'saving…'
                  : savedAt
                    ? `saved ${new Date(savedAt).toISOString().slice(11, 19)}`
                    : 'idle'}
              </div>
            </div>
          </div>

          <div className={cn('relative flex-1 overflow-hidden transition-colors', 'min-h-0')}>
            {draft !== null && effectiveMode === 'edit' && (
              <NoteEditor value={draft} onChange={setDraft} wikilinkCandidates={getWikilinkCandidates} />
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
                  <NoteEditor value={draft} onChange={setDraft} wikilinkCandidates={getWikilinkCandidates} />
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
          </div>

          <div className="max-h-[40vh] shrink-0 overflow-y-auto">
            <EcosystemSection
              centerLabel={note.data.title}
              tags={frontmatterTags(note.data.frontmatter)}
              facets={facetsForNote.data ?? []}
              backlinks={backlinks.data ?? []}
              outboundLinks={outboundLinks.data ?? []}
              related={related.data ?? []}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
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
