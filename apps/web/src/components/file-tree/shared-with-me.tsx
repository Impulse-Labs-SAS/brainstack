'use client';

// Sección "Compartido conmigo" del sidebar. Sólo se renderea cuando el
// deployment está en hosted. Lista las carpetas que otros users me
// compartieron, con badge del dueño.
//
// Las carpetas con permiso de escritura son destino de drop: arrastrar algo
// del árbol propio hasta acá lo migra a la bóveda del dueño. El id del
// droppable es el índice dentro de `items`, que el padre resuelve — armar un
// id compuesto con el ownerId y el path se rompería con cualquier separador
// que un nombre de carpeta pueda contener.

import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { useSharingEnabled } from '@/lib/use-deployment';
import { cn } from '@/lib/utils';

export interface SharedRootItem {
  folderPath: string;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerEmail: string;
  permission: 'read' | 'write';
}

/** Droppable id for the nth shared root. Resolved by the tree that owns the list. */
export const sharedDropId = (index: number): string => `shared-root-${index}`;

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
  const droppable = useDroppable({
    id: sharedDropId(index),
    // Dropping into a folder you may only read would fail at the server; not
    // offering the target is the kinder way to say the same thing.
    disabled: s.permission !== 'write',
  });

  return (
    <li ref={droppable.setNodeRef}>
      <div className={cn(droppable.isOver && 'rounded bg-accent/10 ring-1 ring-accent')}>
        <Link
          href={`/notes/shared/${encodeURIComponent(s.ownerId)}/${s.folderPath}`}
          className={cn(
            'flex items-center gap-2 px-3 py-1 font-mono text-[12px]',
            'text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary',
          )}
          title={`${s.folderPath} — ${s.ownerEmail} — ${
            s.permission === 'write' ? 'lectura y escritura' : 'sólo lectura'
          }`}
        >
          <span className="truncate">{s.folderPath}</span>
          {s.permission === 'write' && (
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
    </li>
  );
}
