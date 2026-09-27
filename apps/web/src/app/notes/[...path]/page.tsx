'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { keepPreviousData } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';
import { FolderInput, Link2, Pencil, Trash2, UserPlus } from 'lucide-react';

import { useModKey } from '@/components/layout/app-shell';
import { useNoteOpen, useNotesChrome } from '@/components/layout/notes-chrome';
import { DeleteDialog, type DeleteTarget } from '@/components/file-tree/delete-dialog';
import { NoteEditor } from '@/components/editor/note-editor';
import { MarkdownPreview } from '@/components/editor/markdown-preview';
import { ConnectionsPanel, type MentionDirection } from '@/components/ecosystem/connections-panel';
import { NoteHeader, type NoteMenuItem } from '@/components/note/note-header';
import { ShareFolderModal } from '@/components/sharing/share-folder-modal';
import { PromptModal } from '@/components/ui/prompt-modal';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { extractOutline, type OutlineHeading } from '@/lib/outline';
import { readFlag, writeFlag } from '@/lib/local-flag';
import { forgetRecent, pushRecent } from '@/lib/recent-notes';
import { useSharingEnabled } from '@/lib/use-deployment';
import { usePersistedViewMode } from '@/lib/use-view-mode';
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

const MAX_TREE_DEPTH = 20;
const CONNECTIONS_KEY = 'brainstack:connections-open';
/** From here up the connections panel sits beside the note; below, over it. */
const WIDE = '(min-width: 1280px)';

const noteRoute = (path: string) => `/notes/${encodePath(path.replace(/\.md$/i, ''))}`;

/** "2 days ago", in the reader's language. */
function relativeTime(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Infinity],
  ];
  let value = (ms - Date.now()) / 1000;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return unit === 'second' ? 'just now' : rtf.format(Math.round(value), unit);
    }
    value /= size;
  }
  return '';
}

export default function NotePage() {
  const router = useRouter();
  const mod = useModKey();
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
  const mentions = trpc.notes.unlinkedMentions.useQuery(
    { path },
    { enabled: !!urlPath, placeholderData: keepPreviousData },
  );
  const sharingEnabled = useSharingEnabled();
  const myShares = trpc.sharing.listMyShares.useQuery(undefined, { enabled: sharingEnabled });
  const update = trpc.notes.update.useMutation();
  const linkMentions = trpc.notes.linkMentions.useMutation();
  const createM = trpc.notes.create.useMutation();
  const moveM = trpc.notes.move.useMutation();
  const removeM = trpc.notes.remove.useMutation();
  const [linkingMention, setLinkingMention] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const tree = trpc.notes.tree.useQuery({ depth: MAX_TREE_DEPTH });
  const utils = trpc.useUtils();

  const treeIndex = useMemo(() => buildIndex(tree.data ?? null), [tree.data]);
  const wikilinkCandidates = useMemo(() => collectNoteCandidates(tree.data ?? null), [tree.data]);
  const wikilinkCandidatesRef = useRef(wikilinkCandidates);
  wikilinkCandidatesRef.current = wikilinkCandidates;
  const getWikilinkCandidates = useCallback(() => wikilinkCandidatesRef.current, []);

  const [viewMode, setViewMode] = usePersistedViewMode('edit');

  // -- Layout: the tree on the left (the layout's), connections on the right -

  const { treeHidden, toggleTree } = useNotesChrome();
  useNoteOpen(true);
  const [connOpen, setConnOpen] = useState(false);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(WIDE);
    const apply = () => setWide(mql.matches);
    apply();
    // Open by default where it fits beside the note; over it, only when asked.
    setConnOpen(mql.matches ? (readFlag(CONNECTIONS_KEY) ?? true) : false);
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, []);
  const toggleConnections = useCallback(() => {
    setConnOpen((open) => {
      if (window.matchMedia(WIDE).matches) writeFlag(CONNECTIONS_KEY, !open);
      return !open;
    });
  }, []);
  // Over the note, the panel closes on the way to another note.
  useEffect(() => {
    if (!window.matchMedia(WIDE).matches) setConnOpen(false);
  }, [path]);

  const resolveLink = useCallback(
    (target: string): { href: string; resolved: boolean; path?: string } => {
      // A non-.md extension is an attachment reference, routed to /files/<path>;
      // when it resolves to nothing it keeps the target as a broken link.
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
        return { href: noteRoute(notePath), resolved: true, path: notePath };
      }
      return { href: noteRoute(bare), resolved: false };
    },
    [path, treeIndex],
  );

  const resolveEmbed = useCallback(
    (target: string) => resolveEmbedClient(target, path, treeIndex),
    [path, treeIndex],
  );

  const meQ = trpc.auth.me.useQuery();
  const mine = meQ.data?.user?.id;

  const [draft, setDraft] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [justSaved, setJustSaved] = useState(false);
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
    setJustSaved(false);
  }, [note.data, note.isPlaceholderData, path, draftPath]);

  // Recent notes, for the sidebar and the quick switcher.
  useEffect(() => {
    if (!note.data || note.isPlaceholderData) return;
    pushRecent({ href: noteRoute(path), title: note.data.title, path: path.replace(/\.md$/i, '') });
  }, [note.data, note.isPlaceholderData, path]);

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
            setJustSaved(true);
            // Links may have changed (wikilinks added/removed): the full
            // Graph view and this note's own connections would otherwise keep
            // serving a stale, pre-edit snapshot.
            void utils.notes.graph.invalidate();
            // Properties come from `notes.get`, so it is refetched too; the
            // draft is not reset by it, since the draft already belongs to
            // this path.
            void utils.notes.get.invalidate({ path });
            void utils.notes.backlinks.invalidate();
            void utils.notes.outboundLinks.invalidate();
            void utils.notes.related.invalidate();
            void utils.notes.unlinkedMentions.invalidate();
          },
        },
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [draft, draftPath, path, mine, utils]);

  useEffect(() => {
    if (!justSaved) return;
    const h = setTimeout(() => setJustSaved(false), 4000);
    return () => clearTimeout(h);
  }, [justSaved, savedAt]);

  /*
   * Linking a mention rewrites a note on the server. When that note is the one
   * open here, the editor's draft is now stale: left alone, the next autosave
   * would write the old text back over the links. So the rewrite waits for
   * unsaved edits to land, and afterwards the draft is reloaded from the
   * server — but only if nothing was typed while the request was out. Typing
   * wins: the draft is kept, its autosave drops the links, and the mentions
   * list offers them again. Losing a keystroke silently would be worse.
   */
  const dirty = draft !== null && draft !== savedContentRef.current;
  const onLinkMention = useCallback(
    (direction: MentionDirection, other: string) => {
      const sourcePath = direction === 'incoming' ? other : path;
      const targetPath = direction === 'incoming' ? path : other;
      setLinkingMention(`${direction}:${other}`);
      const draftAtDispatch = draftRef.current;
      linkMentions.mutate(
        { sourcePath, targetPath },
        {
          onSuccess: async () => {
            if (direction === 'outgoing' && draftRef.current === draftAtDispatch) {
              await utils.notes.get.invalidate({ path });
              const fresh = await utils.notes.get.fetch({ path });
              const body = reconstructBody(fresh);
              // Checked again: the fetch is a second round trip to type during.
              if (draftRef.current === draftAtDispatch) {
                savedContentRef.current = body;
                setDraft(body);
              }
            }
            void utils.notes.unlinkedMentions.invalidate();
            void utils.notes.graph.invalidate();
            void utils.notes.backlinks.invalidate();
            void utils.notes.outboundLinks.invalidate();
          },
          onSettled: () => setLinkingMention(null),
        },
      );
    },
    [linkMentions, path, utils],
  );

  /** Creates the note an unresolved link points at, without leaving this one. */
  const onCreateTarget = useCallback(
    async (target: string) => {
      const clean = target.replace(/\.md$/i, '');
      const name = clean.split('/').pop() ?? clean;
      try {
        await createM.mutateAsync({ path: `${clean}.md`, content: `# ${name}\n` });
      } catch {
        // Created meanwhile: the refresh below shows it either way.
      }
      await Promise.all([
        utils.notes.tree.invalidate(),
        utils.notes.outboundLinks.invalidate(),
        utils.notes.graph.invalidate(),
      ]);
    },
    [createM, utils],
  );

  const onOpenLink = useCallback(
    (target: string) => {
      const { href, resolved } = resolveLink(target);
      if (resolved) router.push(href);
      else void onCreateTarget(splitWikilinkTarget(target).target).then(() => router.push(href));
    },
    [resolveLink, router, onCreateTarget],
  );

  // -- Outline ---------------------------------------------------------------

  const editorViewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const outline = useMemo(() => {
    if (draft === null) return [];
    // Blank the frontmatter rather than cut it, so line numbers still match
    // the editor; a YAML comment is not a heading.
    const fmLines = frontmatterLineCount(draft);
    const lines = draft.split('\n').map((l, i) => (i < fmLines ? '' : l));
    return extractOutline(lines.join('\n'));
  }, [draft]);

  const jumpTo = useCallback(
    (h: OutlineHeading) => {
      if (!wide) setConnOpen(false);
      const view = editorViewRef.current;
      if (viewMode === 'edit' && view) {
        const line = view.state.doc.line(Math.min(h.line, view.state.doc.lines));
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
        });
        view.focus();
        return;
      }
      const headings = previewRef.current?.querySelectorAll(
        '[data-preview-body] h1, [data-preview-body] h2, [data-preview-body] h3',
      );
      headings?.[outline.indexOf(h)]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [viewMode, outline, wide],
  );

  // -- Keyboard --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '.') {
        e.preventDefault();
        toggleConnections();
      } else if (e.key === '\\') {
        e.preventDefault();
        toggleTree();
      } else if (e.key.toLowerCase() === 'e' && !e.shiftKey) {
        e.preventDefault();
        setViewMode(viewMode === 'edit' ? 'preview' : 'edit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleConnections, toggleTree, viewMode, setViewMode]);

  // -- Actions on this note --------------------------------------------------

  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const shared = useMemo(() => {
    const rows = myShares.data ?? [];
    const parts = folder.split('/').filter(Boolean);
    for (let i = parts.length; i > 0; i--) {
      const f = parts.slice(0, i).join('/');
      const count = rows.filter((r) => r.folderPath === f).length;
      if (count > 0) return { folder: f, count };
    }
    return null;
  }, [myShares.data, folder]);

  const [shareFolder, setShareFolder] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<'rename' | 'move' | null>(null);
  const [toDelete, setToDelete] = useState<DeleteTarget | null>(null);

  const relocate = useCallback(
    async (to: string) => {
      if (to === path) return;
      setActionError(null);
      try {
        const result = await moveM.mutateAsync({ from: path, to, ownerId: mine });
        await Promise.all([utils.notes.tree.invalidate(), utils.notes.graph.invalidate()]);
        forgetRecent(noteRoute(path));
        router.replace(noteRoute(result.path));
      } catch (err) {
        setActionError((err as Error).message);
      }
    },
    [moveM, path, mine, utils, router],
  );

  const menu: NoteMenuItem[] = [
    {
      label: 'Copy link',
      icon: Link2,
      run: () => void navigator.clipboard?.writeText(window.location.href).catch(() => {}),
    },
    { label: 'Rename', icon: Pencil, run: () => setPrompt('rename') },
    { label: 'Move to…', icon: FolderInput, run: () => setPrompt('move') },
    ...(sharingEnabled && folder
      ? [
          {
            label: `Share folder “${folder.split('/').pop()}”…`,
            icon: UserPlus,
            run: () => setShareFolder(folder),
          },
        ]
      : []),
    {
      label: 'Delete note',
      icon: Trash2,
      danger: true,
      run: () =>
        setToDelete({
          ownerId: mine ?? '',
          path,
          isFolder: false,
          notePaths: [path],
          people: 0,
          own: true,
        }),
    },
  ];

  if (!note.data && note.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading…</div>
    );
  }

  if (!note.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        No note at <span className="ml-1 font-mono text-xs">{path}</span>
      </div>
    );
  }

  const crumbs = folder
    ? folder.split('/').map((label, i, all) => ({ label, path: all.slice(0, i + 1).join('/') }))
    : [];
  const status: { kind: 'saving' | 'saved' | 'idle'; text: string } = update.isPending
    ? { kind: 'saving', text: 'Saving…' }
    : justSaved
      ? { kind: 'saved', text: 'Saved' }
      : { kind: 'idle', text: `Edited ${relativeTime(savedAt ?? note.data.mtime)}` };
  const mentionCount =
    (mentions.data?.incoming.length ?? 0) + (mentions.data?.outgoing.length ?? 0);
  const backlinkSources = new Set((backlinks.data ?? []).map((b) => b.sourcePath)).size;
  const outgoingTargets = new Set((outboundLinks.data ?? []).map((l) => l.targetPath)).size;

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <NoteHeader
          title={note.data.title}
          crumbs={crumbs}
          status={status}
          mode={viewMode}
          onMode={setViewMode}
          share={shared ? { ...shared, onOpen: () => setShareFolder(shared.folder) } : null}
          connections={{
            open: connOpen,
            count: backlinkSources + outgoingTargets + mentionCount,
            summary: `${backlinkSources} backlinks · ${outgoingTargets} outgoing · ${related.data?.length ?? 0} related · ${mentionCount} unlinked mentions`,
            onToggle: toggleConnections,
          }}
          treeHidden={treeHidden}
          onToggleTree={toggleTree}
          menu={menu}
          mod={mod}
        />
        {actionError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-red-700/40 bg-red-950/40 px-4 py-1.5 text-xs text-red-200"
          >
            {actionError}
            <button type="button" onClick={() => setActionError(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1">
          <div ref={previewRef} className="min-w-0 flex-1 overflow-hidden">
            {draft !== null && viewMode === 'edit' && (
              <NoteEditor
                key={path}
                value={draft}
                onChange={setDraft}
                wikilinkCandidates={getWikilinkCandidates}
                frontmatter={note.data.frontmatter}
                onNavigate={(href) => router.push(href)}
                onOpenLink={onOpenLink}
                onReady={(view) => {
                  editorViewRef.current = view;
                }}
              />
            )}
            {draft !== null && viewMode === 'preview' && (
              <MarkdownPreview
                body={stripFrontmatter(draft)}
                frontmatter={note.data.frontmatter}
                resolveLink={resolveLink}
                resolveEmbed={resolveEmbed}
              />
            )}
          </div>

          {connOpen && (
            <>
              {!wide && (
                <div
                  aria-hidden
                  onClick={() => setConnOpen(false)}
                  className="absolute inset-0 z-20 bg-black/45"
                />
              )}
              <ConnectionsPanel
                currentPath={path}
                backlinks={backlinks.data ?? []}
                outboundLinks={outboundLinks.data ?? []}
                related={related.data ?? []}
                mentions={mentions.data}
                outline={outline}
                onLinkMention={onLinkMention}
                linkingMention={linkingMention}
                outgoingBlockedReason={dirty ? 'Waiting for your changes to save' : null}
                onCreate={(t) => void onCreateTarget(t)}
                onJump={jumpTo}
                onClose={toggleConnections}
                className={cn(
                  'border-l border-border-subtle',
                  wide
                    ? 'w-[336px] shrink-0'
                    : 'absolute inset-y-0 right-0 z-30 w-[min(340px,90%)] shadow-2xl',
                )}
              />
            </>
          )}
        </div>
      </div>

      <PromptModal
        open={prompt !== null}
        title={prompt === 'move' ? `Move ${note.data.title}` : `Rename ${note.data.title}`}
        label={
          prompt === 'move'
            ? 'Destination folder, or / for the vault root. Links to it are updated.'
            : 'New name. Links to it are updated.'
        }
        defaultValue={
          prompt === 'move' ? folder || '/' : (path.split('/').pop() ?? path).replace(/\.md$/i, '')
        }
        okLabel={prompt === 'move' ? 'Move' : 'Rename'}
        onCancel={() => setPrompt(null)}
        onConfirm={(value) => {
          const kind = prompt;
          setPrompt(null);
          const base = path.split('/').pop() ?? path;
          if (kind === 'rename') {
            const name = /\.md$/i.test(value) ? value : `${value}.md`;
            void relocate(folder ? `${folder}/${name}` : name);
          } else {
            const dest = value.trim().replace(/^\/+|\/+$/g, '');
            void relocate(dest ? `${dest}/${base}` : base);
          }
        }}
      />

      <ShareFolderModal
        folderPath={shareFolder ?? ''}
        open={shareFolder !== null}
        onClose={() => setShareFolder(null)}
      />

      <DeleteDialog
        target={toDelete}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          setToDelete(null);
          setActionError(null);
          void removeM
            .mutateAsync({ path, recursive: true, ownerId: mine })
            .then(async () => {
              forgetRecent(noteRoute(path));
              await Promise.all([utils.notes.tree.invalidate(), utils.notes.graph.invalidate()]);
              router.push('/notes');
            })
            .catch((err: Error) => setActionError(err.message));
        }}
      />
    </>
  );
}

/** How many lines the frontmatter block takes, closing `---` included. */
function frontmatterLineCount(content: string): number {
  if (!content.startsWith('---\n')) return 0;
  const close = content.split('\n').indexOf('---', 1);
  return close === -1 ? 0 : close + 1;
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
