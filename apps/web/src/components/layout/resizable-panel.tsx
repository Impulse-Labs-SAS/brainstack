'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

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
    <div className={cn('relative shrink-0', className)} style={{ width }}>
      {children}
      <div
        onMouseDown={onMouseDown}
        className={cn(
          'absolute top-0 z-10 h-full w-1 cursor-col-resize select-none',
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
