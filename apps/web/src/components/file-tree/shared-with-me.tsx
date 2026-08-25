'use client';

// Sección "Compartido conmigo" del sidebar. Sólo se renderea cuando el
// deployment está en hosted. Lista las carpetas que otros users me
// compartieron, con badge del dueño, y cada una se expande en su árbol.
//
// Las carpetas con permiso de escritura son destino de drop: arrastrar algo del
// árbol propio hasta acá lo migra a la bóveda del dueño. Vale para la raíz del
// share y para cualquier subcarpeta adentro.

import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { useSharingEnabled } from '@/lib/use-deployment';
import { cn } from '@/lib/utils';

import { sharedDropId } from '@/lib/shared-drop-id';

import { SharedTree } from './shared-tree';

export interface SharedRootItem {
  folderPath: string;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerEmail: string;
  permission: 'read' | 'write';
}

export function SharedWithMeSection({ items }: { items: SharedRootItem[] }) {
  const enabled = useSharingEnabled();
  const [open, setOpen] = useState(true);

  if (!enabled) return null;
  if (items.length === 0) return null;

  return (
    <div className="border-t border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center justify-between px-3 font-mono text-[11px] text-fg-muted hover:bg-bg-elevated"
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Users size={10} />
          shared with me
        </span>
        <span className="text-[10px] opacity-60">{items.length}</span>
      </button>
      {open && (
        <ul className="py-1">
          {items.map((s, i) => (
            <SharedRootRow key={`${s.ownerId}:${s.folderPath}`} item={s} index={i} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SharedRootRow({ item: s, index }: { item: SharedRootItem; index: number }) {
  // Collapsed by default: the tree costs a cross-owner query per share, and the
  // section exists to show *what* is shared before it shows what is inside.
  const [expanded, setExpanded] = useState(false);
  const writable = s.permission === 'write';

  // The root of the share is a drop target in its own right; the tree below
  // adds the folders inside it, and skips drawing this row again.
  const droppable = useDroppable({
    id: sharedDropId(index, s.folderPath),
    disabled: !writable,
  });

  return (
    <li>
      <div
        ref={droppable.setNodeRef}
        className={cn(
          'flex items-center',
          droppable.isOver && writable && 'rounded bg-accent/10 ring-1 ring-accent',
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Colapsar' : 'Ver contenido'}
          className="flex h-6 w-5 shrink-0 items-center justify-center text-fg-muted hover:text-fg-primary"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        <Link
          href={`/notes/shared/${encodeURIComponent(s.ownerId)}/${s.folderPath}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-1 pr-3 font-mono text-[12px]',
            'text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary',
          )}
          title={`${s.folderPath} — ${s.ownerEmail} — ${
            writable ? 'lectura y escritura' : 'sólo lectura'
          }`}
        >
          <span className="truncate">{s.folderPath}</span>
          {writable && (
            <span
              title="Podés crear y editar notas acá"
              className="shrink-0 rounded border border-border-subtle px-1 text-[9px] uppercase text-fg-muted"
            >
              rw
            </span>
          )}
          <span className="ml-auto truncate text-[10px] text-fg-muted">
            @{s.ownerDisplayName ?? s.ownerEmail.split('@')[0]}
          </span>
        </Link>
      </div>
      {expanded && (
        <div className="pl-2">
          <SharedTree
            ownerId={s.ownerId}
            rootPath={s.folderPath}
            hideRoot
            // Dropping into a folder you may only read would fail at the
            // server; not offering the target says the same thing sooner.
            droppableIdFor={writable ? (folderPath) => sharedDropId(index, folderPath) : undefined}
          />
        </div>
      )}
    </li>
  );
}
