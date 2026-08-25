'use client';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';

export default function NotesPage() {
  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 320);

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
        {/* Sin nota elegida, el teléfono muestra el árbol y nada más: el
            cartel ocuparía la pantalla entera para no decir nada. */}
        <div className="hidden flex-1 items-center justify-center font-mono text-[12px] text-fg-muted md:flex">
          select a note on the left, or right-click to create one
        </div>
      </div>
    </AppShell>
  );
}
