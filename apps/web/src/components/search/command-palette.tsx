'use client';

import { useEffect } from 'react';

import { SearchInput } from './search-input';

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex h-[60vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <SearchInput
          autoFocus
          placeholder="Search the brain… (Esc to close)"
          onPick={onClose}
        />
      </div>
    </div>
  );
}
