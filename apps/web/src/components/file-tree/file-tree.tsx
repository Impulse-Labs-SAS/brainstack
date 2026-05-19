'use client';

// Hierarchical vault browser. Drag a node onto a folder to move it
// (server rewrites wikilinks). Right-click for context actions. Drop OS
// files onto the tree to upload them as attachments — uploads run
// one-by-one so a single failure doesn't take down the rest of the batch.

import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';

import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

const MAX_TREE_DEPTH = 20;

type TreeNode = {
  path: string;
  name: string;
  type: 'folder' | 'note' | 'attachment';
  children?: TreeNode[];
};

type Toast = { id: number; kind: 'info' | 'error'; text: string };

const ROOT_DROP_ID = '__root__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDescendantOf(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  return candidate.startsWith(`${ancestor}/`);
}

function notePathToRoute(path: string): string {
  return `/notes/${path.replace(/\.md$/i, '')}`;
}

function attachmentDestForFile(file: File): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  // Strip path components (the browser shouldn't send any, but be defensive)
  // and replace control chars; keep accents/spaces — the server only blocks
  // traversal, not Unicode.
  const safeName = file.name.replace(/[/\\]+/g, '_');
  return `Attachments/${yyyy}/${mm}/${safeName}`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('unexpected reader result type'));
        return;
      }
      // strip the `data:<mime>;base64,` prefix
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

interface NodeRowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle(path: string): void;
  menuFor: string | null;
  openMenu(path: string, x: number, y: number): void;
  busy: Set<string>;
}

function NodeRow({ node, depth, expanded, toggle, menuFor, openMenu, busy }: NodeRowProps) {
  const router = useRouter();
  const isFolder = node.type === 'folder';
  const isExpanded = isFolder ? expanded.has(node.path) || node.path === '' : false;

  const draggable = useDraggable({
    id: node.path === '' ? ROOT_DROP_ID : node.path,
    disabled: node.path === '', // root isn't draggable
  });
  const droppable = useDroppable({
    id: node.path === '' ? ROOT_DROP_ID : node.path,
    disabled: !isFolder,
  });

  const Icon = isFolder ? Folder : node.type === 'note' ? FileText : ImageIcon;

  const onContext = (e: ReactDragEvent | React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(node.path, (e as React.MouseEvent).clientX, (e as React.MouseEvent).clientY);
  };

  const onClick = () => {
    if (node.path === '') return;
    if (isFolder) {
      toggle(node.path);
    } else if (node.type === 'note') {
      router.push(notePathToRoute(node.path));
    }
  };

  return (
    <div>
      {node.path !== '' && (
        <div
          ref={(el) => {
            draggable.setNodeRef(el);
            droppable.setNodeRef(el);
          }}
          {...draggable.attributes}
          {...draggable.listeners}
          onClick={onClick}
          onContextMenu={onContext}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            'group flex h-7 cursor-default select-none items-center gap-1.5 rounded pr-2 text-sm transition-colors',
            'hover:bg-bg-elevated',
            droppable.isOver && isFolder ? 'bg-accent/10 ring-1 ring-accent' : '',
            menuFor === node.path ? 'bg-bg-elevated' : '',
            draggable.isDragging ? 'opacity-40' : '',
          )}
        >
          {isFolder ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.path);
              }}
              className="flex h-5 w-5 items-center justify-center text-fg-muted"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <Icon size={13} className="text-fg-muted" strokeWidth={1.75} />
          <span className="truncate font-mono text-[12px] text-fg-secondary">{node.name}</span>
          {busy.has(node.path) && (
            <Loader2 size={11} className="ml-auto animate-spin text-fg-muted" />
          )}
        </div>
      )}
      {isFolder && (isExpanded || node.path === '') && node.children && (
        <div>
          {node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={node.path === '' ? 0 : depth + 1}
              expanded={expanded}
              toggle={toggle}
              menuFor={menuFor}
              openMenu={openMenu}
              busy={busy}
            />
          ))}
          {node.children.length === 0 && node.path !== '' && (
            <div
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
              className="py-1 font-mono text-[11px] text-fg-muted"
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileTree
// ---------------------------------------------------------------------------

export function FileTree() {
  const treeQ = trpc.notes.tree.useQuery({ depth: MAX_TREE_DEPTH });
  const utils = trpc.useUtils();

  const moveM = trpc.notes.move.useMutation();
  const createM = trpc.notes.create.useMutation();
  const createFolderM = trpc.notes.createFolder.useMutation();
  const removeM = trpc.notes.remove.useMutation();
  const uploadM = trpc.notes.uploadAttachment.useMutation();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const pushToast = useCallback((kind: 'info' | 'error', text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([utils.notes.tree.invalidate(), utils.notes.list.invalidate()]);
  }, [utils]);

  const markBusy = useCallback((path: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openMenu = useCallback((path: string, x: number, y: number) => {
    setMenu({ path, x, y });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menu]);

  // ---------------------------------------------------------------------------
  // DnD: move on drop
  // ---------------------------------------------------------------------------

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const from = String(e.active.id);
      const overId = e.over?.id != null ? String(e.over.id) : null;
      if (!overId) return;
      const destFolder = overId === ROOT_DROP_ID ? '' : overId;

      // Can't drop on self or on a child of self (would create a cycle).
      if (from === destFolder) return;
      if (destFolder !== '' && isDescendantOf(destFolder, from)) {
        pushToast('error', "can't move a folder inside itself");
        return;
      }

      const basename = from.split('/').pop() ?? from;
      const to = destFolder === '' ? basename : `${destFolder}/${basename}`;
      if (from === to) return;

      markBusy(from, true);
      try {
        const result = await moveM.mutateAsync({ from, to });
        await refresh();
        const mocs = result.affectedMocs.length
          ? ` (review MOCs: ${result.affectedMocs.join(', ')})`
          : '';
        pushToast('info', `moved to ${result.path}${mocs}`);
      } catch (err) {
        pushToast('error', (err as Error).message);
      } finally {
        markBusy(from, false);
      }
    },
    [moveM, pushToast, refresh, markBusy],
  );

  // ---------------------------------------------------------------------------
  // OS file drop on the tree → uploadAttachment one by one
  // ---------------------------------------------------------------------------

  const onNativeDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onNativeDrop = async (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    for (const file of files) {
      const dest = attachmentDestForFile(file);
      markBusy(dest, true);
      try {
        const dataBase64 = await readAsBase64(file);
        const finalPath = await uploadM.mutateAsync({
          path: dest,
          dataBase64,
          mime: file.type || undefined,
        });
        pushToast('info', `uploaded ${finalPath}`);
      } catch (err) {
        pushToast('error', `${file.name}: ${(err as Error).message}`);
      } finally {
        markBusy(dest, false);
      }
    }
    await refresh();
  };

  // ---------------------------------------------------------------------------
  // Context menu actions
  // ---------------------------------------------------------------------------

  const folderForPath = useCallback(
    (path: string, tree: TreeNode | undefined): string => {
      if (!tree) return '';
      const node = findNode(tree, path);
      if (!node) return '';
      if (node.type === 'folder') return node.path;
      const lastSlash = node.path.lastIndexOf('/');
      return lastSlash === -1 ? '' : node.path.slice(0, lastSlash);
    },
    [],
  );

  const doCreateNote = useCallback(async () => {
    if (!menu) return;
    const folder = folderForPath(menu.path, treeQ.data);
    const name = window.prompt('New note name (without .md):');
    setMenu(null);
    if (!name?.trim()) return;
    const path = folder === '' ? `${name.trim()}.md` : `${folder}/${name.trim()}.md`;
    try {
      const result = await createM.mutateAsync({
        path,
        content: `# ${name.trim()}\n`,
        frontmatter: { created: new Date().toISOString().slice(0, 10), tags: [] },
      });
      await refresh();
      const mocs = result.affectedMocs.length
        ? ` (review MOCs: ${result.affectedMocs.join(', ')})`
        : '';
      pushToast('info', `created ${result.path}${mocs}`);
    } catch (err) {
      pushToast('error', (err as Error).message);
    }
  }, [menu, folderForPath, treeQ.data, createM, refresh, pushToast]);

  const doCreateFolder = useCallback(async () => {
    if (!menu) return;
    const folder = folderForPath(menu.path, treeQ.data);
    const name = window.prompt('New folder name:');
    setMenu(null);
    if (!name?.trim()) return;
    const path = folder === '' ? name.trim() : `${folder}/${name.trim()}`;
    try {
      await createFolderM.mutateAsync({ path });
      setExpanded((prev) => new Set(prev).add(path));
      await refresh();
      pushToast('info', `created folder ${path}`);
    } catch (err) {
      pushToast('error', (err as Error).message);
    }
  }, [menu, folderForPath, treeQ.data, createFolderM, refresh, pushToast]);

  const doRename = useCallback(async () => {
    if (!menu) return;
    const from = menu.path;
    setMenu(null);
    const basename = from.split('/').pop() ?? from;
    const next = window.prompt('Rename to:', basename);
    if (!next || next === basename) return;
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const to = parent === '' ? next : `${parent}/${next}`;
    try {
      const result = await moveM.mutateAsync({ from, to });
      await refresh();
      pushToast('info', `renamed to ${result.path}`);
    } catch (err) {
      pushToast('error', (err as Error).message);
    }
  }, [menu, moveM, refresh, pushToast]);

  const doDelete = useCallback(async () => {
    if (!menu) return;
    const target = menu.path;
    setMenu(null);
    if (!window.confirm(`Delete ${target}? Contents are removed permanently.`)) return;
    try {
      const result = await removeM.mutateAsync({ path: target, recursive: true });
      await refresh();
      pushToast('info', `deleted ${result.deleted.length} item(s)`);
    } catch (err) {
      pushToast('error', (err as Error).message);
    }
  }, [menu, removeM, refresh, pushToast]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const root: TreeNode = useMemo(
    () =>
      treeQ.data ?? {
        path: '',
        name: '',
        type: 'folder',
        children: [],
      },
    [treeQ.data],
  );

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={onNativeDragOver}
      onDrop={onNativeDrop}
      onContextMenu={(e) => {
        // Right-click on the empty area of the tree → menu for root folder.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          openMenu('', e.clientX, e.clientY);
        }
      }}
    >
      <div className="flex h-9 items-center justify-between border-b border-border-subtle px-3 font-mono text-[11px] text-fg-muted">
        <span>vault</span>
        {treeQ.isFetching && <Loader2 size={11} className="animate-spin" />}
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex-1 overflow-y-auto py-1">
          <NodeRow
            node={root}
            depth={-1}
            expanded={expanded}
            toggle={toggle}
            menuFor={menu?.path ?? null}
            openMenu={openMenu}
            busy={busy}
          />
          {root.children && root.children.length === 0 && (
            <div className="px-4 py-6 text-center font-mono text-[11px] text-fg-muted">
              empty vault — right-click to add a note or folder
            </div>
          )}
        </div>
      </DndContext>

      {menu && (
        <div
          className="fixed z-50 min-w-[150px] overflow-hidden rounded-md border border-border bg-bg-surface text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={doCreateNote}>New note</MenuItem>
          <MenuItem onClick={doCreateFolder}>New folder</MenuItem>
          {menu.path !== '' && <MenuItem onClick={doRename}>Rename</MenuItem>}
          {menu.path !== '' && (
            <MenuItem onClick={doDelete} danger>
              Delete
            </MenuItem>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-end gap-1">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto max-w-md rounded border px-3 py-1.5 font-mono text-[11px] shadow',
              t.kind === 'error'
                ? 'border-red-700/40 bg-red-950/80 text-red-200'
                : 'border-border bg-bg-elevated text-fg-secondary',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-bg-elevated',
        danger ? 'text-red-400 hover:text-red-300' : 'text-fg-secondary',
      )}
    >
      {children}
    </button>
  );
}

function findNode(tree: TreeNode, path: string): TreeNode | null {
  if (tree.path === path) return tree;
  if (!tree.children) return null;
  for (const child of tree.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}
