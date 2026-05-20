'use client';

// Vista read-only de una nota compartida por otro user. La URL es
// /notes/shared/<ownerId>/<...path>. El path puede apuntar a una nota
// (.md) o a la carpeta raíz del share — en ese caso mostramos solo el
// tree sin nota seleccionada.

import { keepPreviousData } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { NoteEditor } from '@/components/editor/note-editor';
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

  const [treeWidth, setTreeWidth] = usePersistedWidth(
    'brainstack:shared-tree-width',
    320,
  );

  const tree = (
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
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
            <div>
              <div className="text-sm font-medium text-fg-primary">{note.data.title}</div>
              <div className="font-mono text-[11px] text-fg-muted">{path}</div>
            </div>
            <div className="rounded border border-border-subtle px-2 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
              read-only
            </div>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <NoteEditor value={reconstructBody(note.data)} readOnly />
          </div>
          <OutgoingLinks links={linksQ.data ?? []} />
        </div>
      </div>
    </AppShell>
  );
}

function OutgoingLinks({
  links,
}: {
  links: Array<{
    targetPath: string;
    targetType: 'note' | 'attachment' | 'unresolved';
    alias: string | null;
  }>;
}) {
  if (links.length === 0) return null;
  const resolved = links.filter((l) => l.targetType !== 'unresolved');
  const broken = links.filter((l) => l.targetType === 'unresolved');
  return (
    <div className="border-t border-border-subtle px-4 py-2 font-mono text-[11px]">
      <div className="mb-1 text-fg-muted">outgoing links · {links.length}</div>
      <ul className="space-y-0.5">
        {resolved.map((l, i) => (
          <li key={`r-${i}`} className="text-fg-secondary">
            <span className="mr-1.5 text-green-400/80">✓</span>
            <span className="truncate">{l.alias ?? l.targetPath}</span>
          </li>
        ))}
        {broken.map((l, i) => (
          <li key={`b-${i}`} className="text-fg-muted line-through">
            <span className="mr-1.5 text-red-400/60 no-underline">✕</span>
            <span title="enmascarado: sin acceso al target">
              {l.alias ?? l.targetPath}
            </span>
          </li>
        ))}
      </ul>
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
