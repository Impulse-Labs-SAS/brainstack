'use client';

// A note somebody shared with you, at /notes/shared/<ownerId>/<...path>; how
// the URL maps to a note is in `lib/shared-path.ts`. A share's own folder, where
// an accepted invite lands, shows the sidebar with that folder revealed.
//
// The sidebar is the same tree as everywhere else under /notes, so opening a
// shared note never hides your own vault or the other shares, and folders stay
// as open or closed as you left them.
//
// Editable or not according to the grant: with 'write' it is the same
// autosaving editor as your own notes, writing to the owner's vault.

import { keepPreviousData } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useModKey } from '@/components/layout/app-shell';
import { useNoteOpen, useNotesChrome } from '@/components/layout/notes-chrome';
import { NoteEditor } from '@/components/editor/note-editor';
import { ConnectionsPanel } from '@/components/ecosystem/connections-panel';
import { NoteHeader, revealFolder, type NoteMenuItem } from '@/components/note/note-header';
import { readFlag, writeFlag } from '@/lib/local-flag';
import { extractOutline } from '@/lib/outline';
import { groupSharedOwners } from '@/lib/shared-owners';
import { resolveSharedPath } from '@/lib/shared-path';
import { encodePath } from '@/lib/wikilinks-client';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

const CONNECTIONS_KEY = 'brainstack:connections-open';
const WIDE = '(min-width: 1280px)';

export default function SharedNotePage() {
  const router = useRouter();
  const mod = useModKey();
  const params = useParams<{ ownerId: string; path: string[] }>();
  const ownerId = decodeURIComponent(params.ownerId ?? '');
  const urlPath = decodeURIComponent((params.path ?? []).join('/'));

  const sharedWithMe = trpc.sharing.listSharedWithMe.useQuery(undefined, {
    enabled: !!ownerId,
  });
  const owners = useMemo(() => groupSharedOwners(sharedWithMe.data ?? []), [sharedWithMe.data]);
  const owner = owners.find((o) => o.ownerId === ownerId) ?? null;

  const { isFolder, path, shareRoot, crumbs } = useMemo(
    () => resolveSharedPath(urlPath, owner?.roots ?? []),
    [urlPath, owner],
  );

  const isNote = !!sharedWithMe.data && !isFolder;
  const note = trpc.notes.getForOwner.useQuery(
    { ownerId, path },
    // Refetched on focus: on a shared note, someone else's edit is the
    // expected case, and a clean draft picks it up.
    { enabled: isNote && !!ownerId, placeholderData: keepPreviousData, refetchOnWindowFocus: true },
  );
  const linksQ = trpc.notes.linksForOwner.useQuery(
    { ownerId, path },
    { enabled: isNote && !!ownerId },
  );

  const canWrite = shareRoot?.permission === 'write';

  // Landing on the share's folder opens it in the sidebar.
  useEffect(() => {
    if (isFolder) revealFolder({ ownerId, path });
  }, [isFolder, ownerId, path]);

  // Autosave, matching the own-note view: the draft is compared against what
  // the server last accepted rather than against the query data, which is not
  // refetched after a write and would otherwise never match again.
  const update = trpc.notes.update.useMutation();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedContentRef = useRef<string | null>(null);
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;
  // Every save names the version it builds on, one save at a time; see the
  // own-note view for why. Here it matters most: the owner and everyone else
  // with write access edit the same note.
  const checksumRef = useRef<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const [saveTick, setSaveTick] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const saveRef = useRef(update.mutate);
  saveRef.current = update.mutate;

  useEffect(() => {
    if (!note.data || note.isPlaceholderData) return;
    if (draftPath === path) return;
    const body = reconstructBody(note.data);
    setDraft(body);
    setDraftPath(path);
    savedContentRef.current = body;
    checksumRef.current = note.data.checksum;
    setConflict(false);
    setSaveError(null);
    setSavedAt(null);
  }, [note.data, note.isPlaceholderData, path, draftPath]);

  // A newer version with nothing unsaved here replaces the draft.
  useEffect(() => {
    if (!note.data || note.isPlaceholderData || draftPath !== path) return;
    if (note.data.checksum === checksumRef.current || savingRef.current) return;
    if (draftRef.current !== savedContentRef.current) return;
    const body = reconstructBody(note.data);
    checksumRef.current = note.data.checksum;
    savedContentRef.current = body;
    setDraft(body);
  }, [note.data, note.isPlaceholderData, path, draftPath]);

  useEffect(() => {
    if (!canWrite || draft === null) return;
    if (draftPath !== path) return;
    if (conflict || savingRef.current) return;
    if (draft === savedContentRef.current) return;

    const handle = setTimeout(() => {
      const pending = draft;
      const savingPath = path;
      savingRef.current = true;
      saveRef.current(
        {
          ownerId,
          path,
          content: pending,
          ...(checksumRef.current ? { expectedChecksum: checksumRef.current } : {}),
        },
        {
          onSuccess: (saved) => {
            if (pathRef.current !== savingPath) return;
            savedContentRef.current = pending;
            checksumRef.current = saved.checksum;
            setSaveError(null);
            setSaveTick((t) => t + 1);
            setSavedAt(Date.now());
            // Same reasoning as the own-note view: links may have changed.
            void utils.notes.graph.invalidate();
            void utils.notes.linksForOwner.invalidate();
          },
          onError: (err) => {
            if (pathRef.current !== savingPath) return;
            if (err.data?.code === 'CONFLICT') setConflict(true);
            else setSaveError(`Not saved: ${err.message}. It is retried on the next edit.`);
          },
          onSettled: () => {
            savingRef.current = false;
          },
        },
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [canWrite, draft, draftPath, path, ownerId, utils, conflict, saveTick]);

  const resolveConflict = useCallback(
    async (keep: 'theirs' | 'mine') => {
      try {
        await utils.notes.getForOwner.invalidate({ ownerId, path });
        const fresh = await utils.notes.getForOwner.fetch({ ownerId, path });
        checksumRef.current = fresh.checksum;
        if (keep === 'theirs') {
          const body = reconstructBody(fresh);
          savedContentRef.current = body;
          setDraft(body);
        }
        setConflict(false);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Could not load the note');
      }
    },
    [ownerId, path, utils],
  );

  // -- Layout: the tree on the left (the layout's), connections on the right -

  const { treeHidden, toggleTree } = useNotesChrome();
  // The share's own folder has no note: a phone shows the tree there.
  useNoteOpen(!isFolder);
  const [connOpen, setConnOpen] = useState(false);
  useEffect(() => {
    setConnOpen(window.matchMedia(WIDE).matches ? (readFlag(CONNECTIONS_KEY) ?? true) : false);
  }, []);
  const toggleConnections = useCallback(() => {
    setConnOpen((open) => {
      if (window.matchMedia(WIDE).matches) writeFlag(CONNECTIONS_KEY, !open);
      return !open;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '.') {
        e.preventDefault();
        toggleConnections();
      } else if (e.key === '\\') {
        e.preventDefault();
        toggleTree();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleConnections, toggleTree]);

  const outline = useMemo(() => extractOutline(note.data?.body ?? ''), [note.data?.body]);

  const message = (text: string, tone = 'text-fg-muted') => (
    <div
      className={cn(
        'flex-1 items-center justify-center px-6 text-center text-sm',
        tone,
        isFolder ? 'hidden md:flex' : 'flex',
      )}
    >
      {text}
    </div>
  );

  if (sharedWithMe.error) return message(sharedWithMe.error.message, 'text-red-300');
  if (sharedWithMe.data && !shareRoot) return message(`No access to ${urlPath}`);
  if (isFolder) return message('Pick a note on the left');
  if (note.error) return message(note.error.message, 'text-red-300');
  if (!note.data) return message('Loading…');

  const status = !canWrite
    ? ({ kind: 'readonly', text: 'Read only' } as const)
    : conflict
      ? ({ kind: 'idle', text: 'Not saved' } as const)
      : update.isPending
        ? ({ kind: 'saving', text: 'Saving…' } as const)
        : savedAt
          ? ({ kind: 'saved', text: `Saved ${new Date(savedAt).toLocaleTimeString()}` } as const)
          : ({ kind: 'idle', text: 'Shared · can edit' } as const);
  const outgoing = new Set((linksQ.data ?? []).map((l) => l.targetPath)).size;
  const menu: NoteMenuItem[] = [
    {
      label: 'Copy link',
      icon: Link2,
      run: () => void navigator.clipboard?.writeText(window.location.href).catch(() => {}),
    },
  ];

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <NoteHeader
        title={note.data.title}
        crumbs={crumbs}
        owner={owner && { id: owner.ownerId, name: owner.name, color: owner.color }}
        status={status}
        readOnly={!canWrite}
        connections={{
          open: connOpen,
          count: outgoing,
          summary: `${outgoing} outgoing`,
          onToggle: toggleConnections,
        }}
        treeHidden={treeHidden}
        onToggleTree={toggleTree}
        menu={menu}
        mod={mod}
      />
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-700/40 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-200"
        >
          <span>
            Someone else saved this note after you opened it. Your edits are still here, but not
            saved.
          </span>
          <span className="flex gap-3">
            <button
              type="button"
              onClick={() => void resolveConflict('theirs')}
              className="underline"
            >
              Load their version
            </button>
            <button
              type="button"
              onClick={() => void resolveConflict('mine')}
              className="underline"
            >
              Overwrite with mine
            </button>
          </span>
        </div>
      )}
      {saveError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-700/40 bg-red-950/40 px-4 py-1.5 text-xs text-red-200"
        >
          {saveError}
          <button type="button" onClick={() => setSaveError(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <NoteEditor
            key={`${path}:${canWrite}`}
            value={canWrite ? (draft ?? '') : reconstructBody(note.data)}
            onChange={canWrite ? setDraft : undefined}
            readOnly={!canWrite}
            frontmatter={note.data.frontmatter}
            onNavigate={(href) => router.push(href)}
          />
        </div>
        {connOpen && (
          <ConnectionsPanel
            currentPath={path}
            outboundLinks={linksQ.data ?? []}
            outline={outline}
            onJump={() => {}}
            onClose={toggleConnections}
            routeFor={(p) =>
              `/notes/shared/${encodeURIComponent(ownerId)}/${encodePath(p.replace(/\.md$/i, ''))}`
            }
            className="w-[min(336px,90%)] shrink-0 border-l border-border-subtle"
          />
        )}
      </div>
    </div>
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
