'use client';

// A look at a linked note without leaving this one: hovering a wikilink for a
// moment shows its folder, title and first lines. A link to a note that does
// not exist yet says so, and that clicking it creates it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { trpc } from '@/lib/trpc';

export interface PeekTarget {
  /** The link as written, for a note that does not exist yet. */
  label: string;
  /** Vault path of the note (with `.md`), or null when unresolved. */
  path: string | null;
  rect: DOMRect;
}

function excerpt(body: string): string {
  return body
    .split('\n')
    .filter((l, i) => !(i === 0 && /^#\s/.test(l)))
    .join(' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#>*_`]|^\s*[-+]\s/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export function LinkPeek({ target, onEnter, onLeave }: {
  target: PeekTarget | null;
  onEnter(): void;
  onLeave(): void;
}) {
  const note = trpc.notes.get.useQuery(
    { path: target?.path ?? '' },
    { enabled: !!target?.path, staleTime: 30_000 },
  );
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!target || !boxRef.current) return;
    const { rect } = target;
    const w = boxRef.current.offsetWidth;
    const h = boxRef.current.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    const below = rect.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 8) : below;
    setPos({ left, top });
  }, [target, note.data]);

  useEffect(() => {
    if (!target) setPos(null);
  }, [target]);

  if (!target) return null;
  const folder = target.path?.includes('/') ? target.path.slice(0, target.path.lastIndexOf('/')) : 'Vault';

  return (
    <div
      ref={boxRef}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 w-[330px] rounded-xl border border-border bg-bg-elevated px-3.5 py-3 shadow-2xl"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {target.path ? (
        <>
          <div className="font-mono text-[10.5px] text-fg-muted">{folder}</div>
          <div className="mt-0.5 text-sm font-semibold text-fg-primary">
            {note.data?.title ?? target.label}
          </div>
          <div className="mt-1.5 line-clamp-4 text-[12.5px] leading-[19px] text-fg-secondary">
            {note.isLoading ? 'Loading…' : note.data ? excerpt(note.data.body) || 'Empty note.' : ''}
          </div>
          <div className="mt-2.5 border-t border-border pt-2 font-mono text-[10.5px] text-fg-muted">
            Click to open
          </div>
        </>
      ) : (
        <>
          <div className="font-mono text-[10.5px] text-fg-muted">Not created yet</div>
          <div className="mt-0.5 text-sm font-semibold text-fg-primary">{target.label}</div>
          <div className="mt-1.5 text-[12.5px] leading-[19px] text-fg-secondary">
            No note has this name yet. Clicking the link creates it.
          </div>
        </>
      )}
    </div>
  );
}

/** Hover timing shared by every link that can peek: show after a pause, hide after a grace. */
export function usePeek() {
  const [target, setTarget] = useState<PeekTarget | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };
  useEffect(() => clear, []);

  return {
    target,
    show(next: Omit<PeekTarget, 'rect'>, el: HTMLElement) {
      clear();
      showTimer.current = setTimeout(
        () => setTarget({ ...next, rect: el.getBoundingClientRect() }),
        320,
      );
    },
    hide() {
      clear();
      hideTimer.current = setTimeout(() => setTarget(null), 160);
    },
    keep() {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    close() {
      clear();
      setTarget(null);
    },
  };
}
