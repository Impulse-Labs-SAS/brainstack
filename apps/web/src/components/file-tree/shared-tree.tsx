'use client';

// Tree de una carpeta compartida ajena. Toma ownerId + rootPath y llama
// notes.treeForOwner. Cada nota linkea a /notes/shared/<ownerId>/<path>.
//
// Con `droppableIdFor`, cada carpeta pasa a ser destino de drop — así el
// sidebar deja soltar sobre una subcarpeta del share y no solo sobre su raíz.
// Sin ese prop el árbol es el de siempre, que es como lo usa la página de nota.

import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface TreeNode {
  path: string;
  name: string;
  type: 'folder' | 'note' | 'attachment';
  children?: TreeNode[];
}

interface Props {
  ownerId: string;
  rootPath: string;
  activePath?: string;
  /** Droppable id for a folder path, or null where dropping is not offered. */
  droppableIdFor?(folderPath: string): string | null;
  /** Skip the root row when the caller already draws it. */
  hideRoot?: boolean;
}

export function SharedTree({ ownerId, rootPath, activePath, droppableIdFor, hideRoot }: Props) {
  const q = trpc.notes.treeForOwner.useQuery(
    { ownerId, path: rootPath, depth: 8 },
    { enabled: !!ownerId && !!rootPath },
  );

  if (q.isLoading) {
    return <div className="px-3 py-2 font-mono text-[11px] text-fg-muted">cargando…</div>;
  }
  if (q.error) {
    return <div className="px-3 py-2 font-mono text-[11px] text-red-300">{q.error.message}</div>;
  }
  if (!q.data) return null;
  return (
    <div className="py-1">
      <NodeView
        node={q.data}
        ownerId={ownerId}
        activePath={activePath}
        depth={0}
        droppableIdFor={droppableIdFor}
        hideRoot={hideRoot}
      />
    </div>
  );
}

function NodeView({
  node,
  ownerId,
  activePath,
  depth,
  droppableIdFor,
  hideRoot,
}: {
  node: TreeNode;
  ownerId: string;
  activePath?: string;
  depth: number;
  droppableIdFor?(folderPath: string): string | null;
  hideRoot?: boolean;
}) {
  const isRoot = depth === 0;
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 8 + depth * 12 };
  const isActive = activePath === node.path;

  const sortedChildren = useMemo(
    () =>
      (node.children ?? []).slice().sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      }),
    [node.children],
  );

  if (node.type === 'folder') {
    return (
      <>
        {!(isRoot && hideRoot) && (
          <FolderRow
            node={node}
            pad={pad}
            isRoot={isRoot}
            open={open}
            onToggle={() => setOpen((v) => !v)}
            dropId={droppableIdFor?.(node.path) ?? null}
          />
        )}
        {open &&
          sortedChildren.map((c) => (
            <NodeView
              key={c.path}
              node={c}
              ownerId={ownerId}
              activePath={activePath}
              depth={isRoot && hideRoot ? depth : depth + 1}
              droppableIdFor={droppableIdFor}
            />
          ))}
      </>
    );
  }

  if (node.type === 'note') {
    return (
      <Link
        href={`/notes/shared/${encodeURIComponent(ownerId)}/${node.path}`}
        className={cn(
          'flex items-center gap-1.5 py-1 pr-2 font-mono text-[12px]',
          isActive ? 'bg-bg-elevated text-fg-primary' : 'text-fg-secondary',
          'hover:bg-bg-elevated hover:text-fg-primary',
        )}
        style={pad}
      >
        <FileText size={11} className="opacity-60" />
        <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
      </Link>
    );
  }

  return null;
}

/**
 * A folder row, droppable when the caller offered an id for it.
 *
 * `useDroppable` is a hook, so it cannot be called conditionally inside
 * NodeView — a folder that gains or loses a drop id would change the hook
 * order. Registering it here, with a disabled flag, keeps the count fixed.
 */
function FolderRow({
  node,
  pad,
  isRoot,
  open,
  onToggle,
  dropId,
}: {
  node: TreeNode;
  pad: { paddingLeft: number };
  isRoot: boolean;
  open: boolean;
  onToggle(): void;
  dropId: string | null;
}) {
  const droppable = useDroppable({ id: dropId ?? `disabled-${node.path}`, disabled: !dropId });

  return (
    <button
      ref={droppable.setNodeRef}
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-2 font-mono text-[12px]',
        isRoot ? 'text-fg-primary' : 'text-fg-secondary',
        'hover:bg-bg-elevated',
        droppable.isOver && dropId ? 'rounded bg-accent/10 ring-1 ring-accent' : '',
      )}
      style={pad}
    >
      {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      <Folder size={11} />
      <span className="truncate">{node.name || node.path}</span>
    </button>
  );
}
