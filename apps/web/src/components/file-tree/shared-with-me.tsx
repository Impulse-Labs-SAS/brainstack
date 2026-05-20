'use client';

// Sección "Compartido conmigo" del sidebar. Sólo se renderea cuando el
// deployment está en hosted. Lista las carpetas que otros users me
// compartieron, con badge del dueño. El árbol detallado dentro de cada
// carpeta requiere procedures cross-owner (notes.treeForOwner) que
// se agregarán en un paso futuro; por ahora cada nodo es navegable
// como un link a /notes/<ownerId>/<folderPath>.

import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { useSharingEnabled } from '@/lib/use-deployment';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

export function SharedWithMeSection() {
  const enabled = useSharingEnabled();
  const [open, setOpen] = useState(true);
  const q = trpc.sharing.listSharedWithMe.useQuery(undefined, { enabled });

  if (!enabled) return null;
  const items = q.data ?? [];
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
          {items.map((s) => (
            <li key={`${s.ownerId}:${s.folderPath}`}>
              <Link
                href={`/notes/${encodeURIComponent(s.ownerId)}/${s.folderPath}`}
                className={cn(
                  'flex items-center gap-2 px-3 py-1 font-mono text-[12px]',
                  'text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary',
                )}
                title={`${s.folderPath} — ${s.ownerEmail}`}
              >
                <span className="truncate">{s.folderPath}</span>
                <span className="ml-auto truncate text-[10px] text-fg-muted">
                  @{s.ownerDisplayName ?? s.ownerEmail.split('@')[0]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
