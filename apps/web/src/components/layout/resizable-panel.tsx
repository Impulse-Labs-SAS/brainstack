'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

interface ResizablePanelProps {
  side?: 'left' | 'right';
  width: number;
  onWidthChange(next: number): void;
  min?: number;
  max?: number;
  className?: string;
  children: ReactNode;
}

export function ResizablePanel({
  side = 'left',
  width,
  onWidthChange,
  min = 180,
  max = 640,
  className,
  children,
}: ResizablePanelProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(width);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX.current;
      const signed = side === 'left' ? delta : -delta;
      const next = Math.min(max, Math.max(min, startW.current + signed));
      onWidthChange(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, min, max, side, onWidthChange]);

  return (
    /*
     * The dragged width is handed over as a custom property rather than as an
     * inline `width`, because an inline style wins against every class and
     * there is no breakpoint at which it stops applying. On a phone that meant
     * a 320px panel on a 390px screen, with the note squeezed into what was
     * left. As a variable the width is only read from `md` up.
     */
    <div
      className={cn('relative w-full shrink-0 md:w-[var(--panel-w)]', className)}
      style={{ '--panel-w': `${width}px` } as CSSProperties}
    >
      {children}
      <div
        onMouseDown={onMouseDown}
        className={cn(
          // Dragging needs a pointer and room to drag; below md there is
          // neither, and the handle only sits on top of the content.
          'absolute top-0 z-10 hidden h-full w-1 cursor-col-resize select-none md:block',
          'hover:bg-accent/40',
          dragging && 'bg-accent/60',
          side === 'left' ? '-right-0.5' : '-left-0.5',
        )}
      />
    </div>
  );
}

export function usePersistedWidth(
  key: string,
  defaultWidth: number,
): [number, (n: number) => void] {
  const [width, setWidth] = useState(defaultWidth);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) setWidth(parsed);
      }
    } catch {
      // ignore
    }
  }, [key]);

  const update = useCallback(
    (next: number) => {
      setWidth(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // ignore
      }
    },
    [key],
  );

  return [width, update];
}
