'use client';

// What a page under /notes can ask of the frame around it (app/notes/layout.tsx).

import { createContext, useContext, useEffect } from 'react';

export interface NotesChrome {
  treeHidden: boolean;
  toggleTree(): void;
  setNoteOpen(open: boolean): void;
}

export const NotesChromeContext = createContext<NotesChrome | null>(null);

export function useNotesChrome(): NotesChrome {
  const chrome = useContext(NotesChromeContext);
  if (!chrome) throw new Error('useNotesChrome must be used under app/notes/layout.tsx');
  return chrome;
}

/**
 * Tells the frame a note fills the page while `open` holds: the tree may be
 * hidden to make room, and on a phone it gives way to the note.
 */
export function useNoteOpen(open: boolean): void {
  const { setNoteOpen } = useNotesChrome();
  useEffect(() => {
    setNoteOpen(open);
    return () => setNoteOpen(false);
  }, [open, setNoteOpen]);
}
