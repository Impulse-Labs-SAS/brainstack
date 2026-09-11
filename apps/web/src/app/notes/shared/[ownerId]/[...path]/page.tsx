'use client';

// Vista de una nota compartida por otro user. La URL es
// /notes/shared/<ownerId>/<...path>. El path puede apuntar a una nota
// (.md) o a la carpeta raíz del share — en ese caso mostramos solo el
// tree sin nota seleccionada.
//
// Editable o no según el permiso del grant: con 'write' es el mismo editor
// con autosave que la vista propia, escribiendo contra el vault del dueño.

import { keepPreviousData } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { NoteEditor } from '@/components/editor/note-editor';
import { EcosystemSection } from '@/components/ecosystem/ecosystem-section';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';
import { SharedTree } from '@/components/file-tree/shared-tree';
import { trpc } from '@/lib/trpc';

export default function SharedNotePage() {
  const params = useParams<{ ownerId: string; path: string[] }>();
  const ownerId = decodeURIComponent(params.ownerId ?? '');
  const path = decodeURIComponent((params.path ?? []).join('/'));
  const isNote = /\.md$/i.test(path);

  const sharedWithMe = trpc.sharing.listSharedWithMe.useQuery(undefined, {
    enabled: !!ownerId,
  });

  // El share root que cubre este path. Si listSharedWithMe trae múltiples
  // grants del mismo owner, elegimos el más largo que sea prefijo del path.
  const shareRoot = useMemo(() => {
    const grants = (sharedWithMe.data ?? []).filter((g) => g.ownerId === ownerId);
    const matches = grants
      .filter((g) => path === g.folderPath || path.startsWith(g.folderPath + '/'))
      .sort((a, b) => b.folderPath.length - a.folderPath.length);
    return matches[0] ?? null;
  }, [sharedWithMe.data, ownerId, path]);

  const note = trpc.notes.getForOwner.useQuery(
    { ownerId, path },
    { enabled: isNote && !!ownerId, placeholderData: keepPreviousData },
  );
  const linksQ = trpc.notes.linksForOwner.useQuery(
    { ownerId, path },
    { enabled: isNote && !!ownerId },
  );

  const canWrite = shareRoot?.permission === 'write';

  // Autosave, matching the own-note view: the draft is compared against what
  // the server last accepted rather than against the query data, which is not
  // refetched after a write and would otherwise never match again.
  const update = trpc.notes.update.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedContentRef = useRef<string | null>(null);
  const saveRef = useRef(update.mutate);
  saveRef.current = update.mutate;

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
    if (!canWrite || draft === null) return;
    if (draftPath !== path) return;
    if (draft === savedContentRef.current) return;

    const handle = setTimeout(() => {
      const pending = draft;
      saveRef.current(
        { ownerId, path, content: pending },
        {
          onSuccess: () => {
            savedContentRef.current = pending;
            setSavedAt(Date.now());
          },
        },
      );
    }, 600);
    return () => clearTimeout(handle);
  }, [canWrite, draft, draftPath, path, ownerId]);

  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:shared-tree-width', 320);

  // Mismo criterio que la vista propia: en teléfono se ve el árbol o la nota,
  // y con una nota abierta gana la nota.
  const tree = (
    <div className="hidden md:contents">
      <ResizablePanel
        side="left"
        width={treeWidth}
        onWidthChange={setTreeWidth}
        min={200}
        max={560}
        className="border-r border-border-subtle"
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border-subtle px-3 py-2 font-mono text-[11px] text-fg-muted">
            {shareRoot ? (
              <>
                <span className="text-fg-secondary">{shareRoot.folderPath}</span>
                <span className="ml-2 opacity-60">
                  @{shareRoot.ownerDisplayName ?? shareRoot.ownerEmail.split('@')[0]}
                </span>
              </>
            ) : (
              'cargando…'
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {shareRoot && (
              <SharedTree
                ownerId={ownerId}
                rootPath={shareRoot.folderPath}
                activePath={isNote ? path : undefined}
              />
            )}
          </div>
        </div>
      </ResizablePanel>
    </div>
  );

  // Acceso denegado / share no encontrado.
  if (sharedWithMe.data && !shareRoot) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {tree}
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-fg-muted">
            sin acceso a {path}
          </div>
        </div>
      </AppShell>
    );
  }

  if (!isNote) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {tree}
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-fg-muted">
            elegí una nota del árbol
          </div>
        </div>
      </AppShell>
    );
  }

  if (note.error) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {tree}
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-red-300">
            {note.error.message}
          </div>
        </div>
      </AppShell>
    );
  }

  if (!note.data) {
    return (
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {tree}
          <div className="flex flex-1 items-center justify-center text-fg-muted">Loading…</div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full overflow-hidden">
        {tree}
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
            <div className="rounded border border-border-subtle px-2 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
              {!canWrite
                ? 'read-only'
                : update.isPending
                  ? 'saving…'
                  : savedAt
                    ? `saved ${new Date(savedAt).toISOString().slice(11, 19)}`
                    : 'shared · can edit'}
            </div>
          </div>
          <div className="relative flex-1 overflow-hidden">
            {canWrite ? (
              <NoteEditor value={draft ?? ''} onChange={setDraft} />
            ) : (
              <NoteEditor value={reconstructBody(note.data)} readOnly />
            )}
          </div>
          <EcosystemSection outboundLinks={linksQ.data ?? []} />
        </div>
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
