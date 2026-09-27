'use client';

// Everything under /notes shares this frame: the app shell and the notes tree.
//
// It lives in a layout, not in each page, because Next keeps a layout mounted
// across navigations and remounts a page whenever the route changes. With the
// tree in the pages, going from one of your notes to a shared one — two routes —
// tore the sidebar down and drew it again, blank for a moment in between.

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { FileTree } from '@/components/file-tree/file-tree';
import { AppShell } from '@/components/layout/app-shell';
import { NotesChromeContext, type NotesChrome } from '@/components/layout/notes-chrome';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';
import { readFlag, writeFlag } from '@/lib/local-flag';

const TREE_HIDDEN_KEY = 'brainstack:notes-tree-hidden';

/** Tag and facet listings stand on their own, without the tree. */
const WITHOUT_TREE = /^\/notes\/(tag|facet)\//;

export default function NotesLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 272);
  const [treeHidden, setTreeHidden] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  useEffect(() => {
    setTreeHidden(readFlag(TREE_HIDDEN_KEY) ?? false);
  }, []);
  const toggleTree = useCallback(() => {
    setTreeHidden((hidden) => {
      writeFlag(TREE_HIDDEN_KEY, !hidden);
      return !hidden;
    });
  }, []);

  const chrome = useMemo<NotesChrome>(
    () => ({ treeHidden, toggleTree, setNoteOpen }),
    [treeHidden, toggleTree],
  );

  /*
   * Hiding the tree is for making room for a note; with none open there is
   * nothing to make room for. On a phone the two do not fit side by side, so
   * an open note shows alone, with a way back to the tree in its header.
   */
  const showTree = !WITHOUT_TREE.test(pathname) && !(noteOpen && treeHidden);

  return (
    <NotesChromeContext.Provider value={chrome}>
      <AppShell>
        <div className="flex h-full overflow-hidden">
          {showTree && (
            <div className={noteOpen ? 'hidden md:contents' : 'contents'}>
              <ResizablePanel
                side="left"
                width={treeWidth}
                onWidthChange={setTreeWidth}
                min={200}
                max={560}
                className="border-r border-border-subtle"
              >
                <FileTree />
              </ResizablePanel>
            </div>
          )}
          {children}
        </div>
      </AppShell>
    </NotesChromeContext.Provider>
  );
}
