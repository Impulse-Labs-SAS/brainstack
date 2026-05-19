'use client';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';

export default function NotesPage() {
  return (
    <AppShell>
      <div className="grid h-full grid-cols-[320px_1fr] overflow-hidden">
        <div className="border-r border-border-subtle">
          <FileTree />
        </div>
        <div className="flex h-full items-center justify-center font-mono text-[12px] text-fg-muted">
          select a note on the left, or right-click to create one
        </div>
      </div>
    </AppShell>
  );
}
