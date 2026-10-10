'use client';

// The Sentinel panel on a phone: a sheet from the bottom with three heights.
// It comes in low — the walk's state and Copy prompt, nothing else — so the
// stage stays free to watch the Sentinel; the person raises it to half or
// full by dragging the handle or tapping it. It never rises on its own, not
// even when the walk ends: that would cover the end of what they watch.
//
// It slides in and out with the panel's level (`--crawl-panel`), as the
// column on a wide screen does. Whatever rides above it (the replay's
// controls) is laid against its top edge, so it moves with it.

import { useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { GLASS } from '../../graph-preview';

export type SheetSize = 'peek' | 'half' | 'full';

/**
 * Low, it shows the handle and the row under it (4.5rem) and a little of the
 * glass below, never the first words of what follows.
 */
const PEEK_REM = 5;
const HEIGHT: Record<SheetSize, string> = {
  peek: `calc(${PEEK_REM}rem + env(safe-area-inset-bottom, 0px))`,
  half: '55%',
  full: 'calc(100% - 4rem)',
};
const NEXT: Record<SheetSize, SheetSize> = { peek: 'half', half: 'full', full: 'peek' };
/** Pixels the handle must travel before a press is a drag: a finger's tap wobbles less than this. */
const DRAG_FROM = 10;
/** A click this soon after a drag ends is the drag's, not a tap. */
const CLICK_AFTER_DRAG_MS = 400;

export function PhoneSheet({
  open,
  size,
  onSize,
  peek,
  above,
  children,
}: {
  /** In the walk: shown and operable. */
  open: boolean;
  size: SheetSize;
  onSize(size: SheetSize): void;
  /** What shows at its lowest. */
  peek: ReactNode;
  /** Laid on its top edge, hidden at full height. */
  above?: ReactNode;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; from: number; moved: boolean } | null>(null);
  /**
   * When the last drag ended: the click a browser may send after it is the
   * drag's, not a tap. A time, not a flag, so a click that never comes cannot
   * swallow the next press of Enter.
   */
  const dragEndedAt = useRef(-Infinity);
  /** The height while dragged, px; null at rest on one of the three. */
  const [dragged, setDragged] = useState<number | null>(null);

  /** The three heights in pixels, as the styles above resolve them now (the safe area aside). */
  const sizes = (): Record<SheetSize, number> => {
    const H = sheet.current?.parentElement?.clientHeight ?? 0;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { peek: PEEK_REM * rem, half: H * 0.55, full: H - 4 * rem };
  };

  return (
    <aside
      ref={sheet}
      aria-label="Sentinel"
      inert={!open}
      aria-hidden={!open}
      className={cn(
        'pointer-events-auto absolute inset-x-0 bottom-0 z-10',
        dragged === null && 'transition-[height] duration-300 ease-default motion-reduce:transition-none',
      )}
      style={{
        height: dragged === null ? HEIGHT[size] : `${dragged}px`,
        transform: 'translateY(calc((1 - var(--crawl-panel, 0)) * 110%))',
      }}
    >
      {above && size !== 'full' && dragged === null && (
        <div className="absolute bottom-full left-1/2 mb-3 -translate-x-1/2">{above}</div>
      )}
      <div className={cn(GLASS, 'flex h-full min-h-0 flex-col overflow-hidden rounded-t-2xl border-b-0 shadow-2xl')}>
        <button
          type="button"
          aria-label={size === 'full' ? 'Lower the panel' : 'Raise the panel'}
          aria-expanded={size !== 'peek'}
          className="flex w-full shrink-0 touch-none justify-center pb-2 pt-2.5 outline-none focus-visible:bg-bg-hover"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, from: sheet.current?.offsetHeight ?? 0, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dy = d.y - e.clientY;
            if (!d.moved && Math.abs(dy) < DRAG_FROM) return;
            d.moved = true;
            const s = sizes();
            setDragged(Math.max(s.peek * 0.8, Math.min(s.full, d.from + dy)));
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            if (!d?.moved) return;
            dragEndedAt.current = performance.now();
            const h = sheet.current?.offsetHeight ?? 0;
            const s = sizes();
            const nearest = (Object.keys(s) as SheetSize[]).sort(
              (a, b) => Math.abs(s[a] - h) - Math.abs(s[b] - h),
            )[0]!;
            setDragged(null);
            onSize(nearest);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragged(null);
          }}
          onClick={() => {
            if (performance.now() - dragEndedAt.current < CLICK_AFTER_DRAG_MS) return;
            onSize(NEXT[size]);
          }}
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-border-strong" />
        </button>
        {peek}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </aside>
  );
}
