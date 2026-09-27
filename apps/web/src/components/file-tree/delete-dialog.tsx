'use client';

// What deleting a note or a folder does, said before it happens: how many
// notes go with it, who loses access to a shared folder, and how many links
// from other notes will be left pointing nowhere. Deleting rewrites no link,
// so those links stay in their text and show as not created yet. There is no
// trash, and the dialog says that too.

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { trpc } from '@/lib/trpc';

export interface DeleteTarget {
  ownerId: string;
  path: string;
  isFolder: boolean;
  /** Notes that go with it: the note itself, or every note under the folder. */
  notePaths: readonly string[];
  /** People who lose access because the folder, or one inside it, is shared. */
  people: number;
  /** Your own vault: only then can links from your other notes be counted. */
  own: boolean;
}

interface Props {
  target: DeleteTarget | null;
  onCancel(): void;
  onConfirm(): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DeleteDialog({ target, onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const open = target !== null;
  const graph = trpc.notes.graph.useQuery({ scope: 'mine' }, { enabled: open && !!target?.own });

  const links = useMemo(() => {
    if (!target || !graph.data) return null;
    const idOf = new Map(graph.data.nodes.map((n) => [n.id, n.path]));
    const gone = new Set(target.notePaths);
    let count = 0;
    const sources = new Set<string>();
    for (const e of graph.data.edges) {
      const from = idOf.get(e.source);
      const to = idOf.get(e.target);
      if (!from || !to || gone.has(from) || !gone.has(to)) continue;
      count += Math.max(1, e.weight);
      sources.add(from);
    }
    return { count, sources: sources.size };
  }, [target, graph.data]);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!target) return null;

  const name = (target.path.split('/').pop() ?? target.path).replace(/\.md$/i, '');
  const n = target.notePaths.length;
  const consequences: React.ReactNode[] = [];
  if (target.isFolder) {
    consequences.push(
      n > 0 ? (
        <>
          The <b>{plural(n, 'note', 'notes')}</b> inside it {n === 1 ? 'is' : 'are'} deleted too.
        </>
      ) : (
        'The folder is empty.'
      ),
    );
  }
  if (target.people > 0) {
    consequences.push(
      <>
        <b>{plural(target.people, 'person loses', 'people lose')} access.</b> The folder is shared
        with them.
      </>,
    );
  }
  if (target.own) {
    if (!links) {
      consequences.push(
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <Loader2 size={12} className="animate-spin" /> Counting links from other notes…
        </span>,
      );
    } else if (links.count > 0) {
      consequences.push(
        <>
          <b>{plural(links.count, 'link', 'links')}</b> from{' '}
          {plural(links.sources, 'other note', 'other notes')} will point nowhere. The text stays and
          shows as not created yet.
        </>,
      );
    }
  }
  consequences.push('There is no trash, so this can’t be undone.');

  const okLabel = target.isFolder
    ? n > 0
      ? `Delete folder and ${plural(n, 'note', 'notes')}`
      : 'Delete folder'
    : 'Delete note';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[14vh]"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        className="grid w-[min(460px,100%)] gap-4 rounded-xl border border-border bg-bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-500/15 text-red-400">
            <AlertTriangle size={15} />
          </span>
          <div className="min-w-0">
            <h2 id="delete-dialog-title" className="text-base font-semibold text-fg-primary">
              Delete {target.isFolder ? 'folder ' : ''}“{name}”?
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-fg-muted">
              {target.path}
              {target.isFolder ? '/' : ''}
            </p>
          </div>
        </div>
        <ul className="grid list-disc gap-1.5 pl-5 text-sm text-fg-secondary marker:text-fg-muted [&_b]:font-semibold [&_b]:text-fg-primary">
          {consequences.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 rounded-md border border-border bg-bg-elevated px-3 text-sm text-fg-primary hover:border-border-strong"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 rounded-md bg-danger px-3 text-sm font-medium text-white hover:brightness-110"
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
