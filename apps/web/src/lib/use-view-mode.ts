'use client';

// Tiny hook that persists the markdown view mode in localStorage. Global
// (not per-note) — the user picks once and the choice sticks.
//
// There used to be a third mode, split, which showed the same note twice:
// its markdown beside its rendering. The editor now reads like the rendered
// note, so it was dropped; a stored "split" opens in Edit.

import { useEffect, useState } from 'react';

export type ViewMode = 'edit' | 'preview';

const KEY = 'brainstack:note-view-mode';
const VALID: ViewMode[] = ['edit', 'preview'];

export function usePersistedViewMode(defaultMode: ViewMode = 'edit'): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(defaultMode);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw && (VALID as string[]).includes(raw)) setMode(raw as ViewMode);
      else if (raw === 'split') setMode('edit');
    } catch {
      /* ignore */
    }
  }, []);

  const update = (m: ViewMode): void => {
    setMode(m);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(KEY, m);
      } catch {
        /* ignore */
      }
    }
  };

  return [mode, update];
}
