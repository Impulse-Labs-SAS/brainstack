'use client';

import { useParams } from 'next/navigation';
import { Download } from 'lucide-react';

import { AppShell } from '@/components/layout/app-shell';
import { FileTree } from '@/components/file-tree/file-tree';
import { ResizablePanel, usePersistedWidth } from '@/components/layout/resizable-panel';
import { AttachmentViewer, humanSize } from '@/components/viewer/attachment-viewer';
import { mimeFromExt } from '@/lib/mime';
import { attachmentUrl } from '@/lib/server-url';
import { trpc } from '@/lib/trpc';

export default function FilePage() {
  const params = useParams<{ path: string[] }>();
  const path = decodeURIComponent((params.path ?? []).join('/'));

  const meta = trpc.notes.getAttachment.useQuery({ path }, { enabled: !!path });

  const [treeWidth, setTreeWidth] = usePersistedWidth('brainstack:notes-tree-width', 320);

  const name = path.split('/').pop() ?? path;
  const mime = mimeFromExt(path);
  const src = attachmentUrl(path);
  const downloadHref = `${src}?download=1`;

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

        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg-primary">{name}</div>
              <div className="truncate font-mono text-[11px] text-fg-muted">{path}</div>
            </div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-[11px] text-fg-muted">
                {meta.data ? humanSize(meta.data.sizeBytes) : '—'} · {mime}
              </div>
              <a
                href={downloadHref}
                className="inline-flex items-center gap-1.5 rounded border border-border-default bg-bg-elevated px-2 py-1 text-xs text-fg-primary hover:bg-bg-hover"
              >
                <Download size={12} strokeWidth={1.75} />
                Download
              </a>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {meta.isLoading && (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-fg-muted">
                cargando…
              </div>
            )}
            {meta.error && (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-red-300">
                {meta.error.message}
              </div>
            )}
            {meta.data && <AttachmentViewer mime={mime} src={src} path={path} />}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
