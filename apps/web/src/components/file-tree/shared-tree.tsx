'use client';

// Tree read-only de una carpeta compartida ajena. Toma ownerId + rootPath y
// llama notes.treeForOwner. Cada nota linkea a /notes/shared/<ownerId>/<path>.

import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface TreeNode {
  path: string;
  name: string;
  type: 'folder' | 'note' | 'attachment';
  children?: TreeNode[];
}

interface Props {
  ownerId: string;
  rootPath: string;
  activePath?: string;
}

export function SharedTree({ ownerId, rootPath, activePath }: Props) {
  const q = trpc.notes.treeForOwner.useQuery(
    { ownerId, path: rootPath, depth: 8 },
    { enabled: !!ownerId && !!rootPath },
  );

  if (q.isLoading) {
    return <div className="px-3 py-2 font-mono text-[11px] text-fg-muted">cargando…</div>;
  }
  if (q.error) {
    return <div className="px-3 py-2 font-mono text-[11px] text-red-300">{q.error.message}</div>;
  }
  if (!q.data) return null;
  return (
    <div className="py-1">
      <NodeView node={q.data} ownerId={ownerId} activePath={activePath} depth={0} />
    </div>
  );
}

function NodeView({
  node,
  ownerId,
  activePath,
  depth,
}: {
  node: TreeNode;
  ownerId: string;
  activePath?: string;
  depth: number;
}) {
  const isRoot = depth === 0;
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 8 + depth * 12 };
  const isActive = activePath === node.path;

  const sortedChildren = useMemo(
    () =>
      (node.children ?? []).slice().sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      }),
    [node.children],
  );

  if (node.type === 'folder') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-1.5 py-1 pr-2 font-mono text-[12px]',
            isRoot ? 'text-fg-primary' : 'text-fg-secondary',
            'hover:bg-bg-elevated',
          )}
          style={pad}
        >
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Folder size={11} />
          <span className="truncate">{node.name || node.path}</span>
        </button>
        {open &&
          sortedChildren.map((c) => (
            <NodeView
              key={c.path}
              node={c}
              ownerId={ownerId}
              activePath={activePath}
              depth={depth + 1}
            />
          ))}
      </>
    );
  }

  if (node.type === 'note') {
    return (
      <Link
        href={`/notes/shared/${encodeURIComponent(ownerId)}/${node.path}`}
        className={cn(
          'flex items-center gap-1.5 py-1 pr-2 font-mono text-[12px]',
          isActive ? 'bg-bg-elevated text-fg-primary' : 'text-fg-secondary',
          'hover:bg-bg-elevated hover:text-fg-primary',
        )}
        style={pad}
      >
        <FileText size={11} className="opacity-60" />
        <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
      </Link>
    );
  }

  return null;
}
