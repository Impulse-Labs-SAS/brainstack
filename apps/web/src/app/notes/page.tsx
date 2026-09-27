'use client';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';

export default function NotesPage() {
  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 272);

  return (
    <AppShell>
      <div className="flex h-full overflow-hidden">
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
        {/* With no note picked, a phone shows the tree and nothing else: the
            message would take the whole screen to say nothing. */}
        <div className="hidden flex-1 flex-col items-center justify-center gap-1 text-center md:flex">
          <div className="text-sm text-fg-secondary">Pick a note on the left</div>
          <div className="text-xs text-fg-muted">
            or press Ctrl/⌘ K to jump to one, or right-click the tree to create one.
          </div>
        </div>
      </div>
    </AppShell>
  );
}
