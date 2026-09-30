'use client';

// Hierarchical vault browser. Drag a node onto a folder to move it
// (server rewrites wikilinks). Every row has a ⋯ menu, also on right-click,
// and Delete on a focused row asks to delete it. Drop OS `.md` files onto a
// folder to import them as notes — imports run one-by-one so a single failure
// doesn't take down the rest of the batch.
//
// Three groups, top to bottom: the notes this browser opened last, your own
// vault, and the folders other people shared with you, grouped by owner.

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
  Clock,
  Ellipsis,
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  House,
  Image as ImageIcon,
  Loader2,
  Lock,
  Pencil,
  Search,
  Trash2,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { useModKey, useOpenPalette } from '@/components/layout/app-shell';
import { ConfirmModal, PromptModal } from '@/components/ui/prompt-modal';
import { isInside, nodeId, parseNodeId, sameNode, type NodeRef } from '@/lib/tree-node-id';
import { importMarkdownFiles, isMarkdownFile, summarizeImport } from '@/lib/import-md';
import { forgetRecent, useRecentNotes } from '@/lib/recent-notes';
import { groupSharedOwners } from '@/lib/shared-owners';
import { ShareFolderModal } from '@/components/sharing/share-folder-modal';

import { REVEAL_FOLDER_EVENT, type RevealFolderDetail } from '@/components/note/note-header';

import { DeleteDialog, type DeleteTarget } from './delete-dialog';

type PromptKind = 'createNote' | 'createFolder' | 'rename' | 'move';
type PromptState = {
  kind: PromptKind;
  targetPath: string;
  title: string;
  label?: string;
  defaultValue?: string;
};

const MAX_TREE_DEPTH = 20;

type TreeNode = {
  path: string;
  name: string;
  type: 'folder' | 'note' | 'attachment';
  children?: TreeNode[];
};

type Toast = { id: number; kind: 'info' | 'error'; text: string };

type MenuState = {
  ref: NodeRef;
  node: TreeNode;
  canWrite: boolean;
  isFolder: boolean;
  x: number;
  y: number;
};

const EXPANDED_KEY = 'brainstack:tree-expanded';
const RECENT_OPEN_KEY = 'brainstack:tree-recent-open';

function loadExpanded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    // ignore
  }
  return new Set();
}

function saveExpanded(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The folder a path sits in. Empty when it sits at the vault root. */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function notePathToRoute(ref: NodeRef, mine: string | undefined): string {
  const clean = ref.path.replace(/\.md$/i, '');
  // Somebody else's note opens in the shared view; paths there are relative to
  // their root, which is exactly what the node already carries.
  if (mine !== undefined && ref.ownerId !== mine) {
    return `/notes/shared/${encodeURIComponent(ref.ownerId)}/${clean}`;
  }
  return `/notes/${clean}`;
}

/** The note the URL has open, as a tree node reference. */
function activeRefFrom(pathname: string, mine: string | undefined): NodeRef | null {
  if (!mine) return null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const shared = pathname.match(/^\/notes\/shared\/([^/]+)\/(.+)$/);
  if (shared) return { ownerId: decode(shared[1]!), path: `${decode(shared[2]!)}.md` };
  const own = pathname.match(/^\/notes\/(.+)$/);
  if (!own || /^(tag|facet|shared)\//.test(own[1]!)) return null;
  return { ownerId: mine, path: `${decode(own[1]!)}.md` };
}

/** A folder's index note: `_Atlas.md` inside `Atlas/`. It opens the folder's map. */
function isIndexNote(node: TreeNode): boolean {
  return node.type === 'note' && node.name.startsWith('_');
}

function displayName(node: TreeNode): string {
  const bare = node.name.replace(/\.md$/i, '');
  return isIndexNote(node) ? bare.slice(1) : bare;
}

/** Index note first, then everything else in the order the server sorted it. */
function orderChildren(children: readonly TreeNode[]): TreeNode[] {
  return [...children.filter(isIndexNote), ...children.filter((c) => !isIndexNote(c))];
}

function notesUnder(node: TreeNode): string[] {
  if (node.type === 'note') return [node.path];
  return (node.children ?? []).flatMap(notesUnder);
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

interface NodeRowProps {
  node: TreeNode;
  /**
   * Whose vault this subtree is. Yours for your own notes, somebody else's for
   * a folder they shared — the tree shows both, so no node can assume.
   */
  ownerId: string;
  /** False for a folder shared read-only: no writes, and nothing to drag. */
  canWrite: boolean;
  depth: number;
  expanded: Set<string>;
  toggle(id: string): void;
  menuFor: string | null;
  /** The note the page has open, so its row can say so. */
  activeId: string | null;
  openMenu(menu: MenuState): void;
  onDeleteKey(ref: NodeRef, node: TreeNode): void;
  onShare(path: string): void;
  onPrefetch(ref: NodeRef): void;
  /** Archivos .md soltados del escritorio sobre esta carpeta. */
  onFilesDrop(ref: NodeRef, files: FileList): void;
  busy: Set<string>;
  /**
   * Who each folder is shared with, keyed by folder path.
   *
   * Sharing a folder used to leave no trace in the tree: "shared with me" only
   * lists what others shared with you, so an owner had no way to tell a shared
   * folder from a private one without opening the share dialog.
   */
  sharedWith: Map<string, string[]>;
  /** Your own id, so a note routes to your view or to the shared one. */
  mine: string | undefined;
}

type RowShared = Omit<NodeRowProps, 'node' | 'ownerId' | 'canWrite' | 'depth'>;

function NodeRow(props: NodeRowProps) {
  const {
    node,
    ownerId,
    canWrite,
    depth,
    expanded,
    toggle,
    menuFor,
    activeId,
    openMenu,
    onDeleteKey,
    onShare,
    onPrefetch,
    onFilesDrop,
    busy,
    sharedWith,
    mine,
  } = props;
  const router = useRouter();
  const isFolder = node.type === 'folder';
  const ref: NodeRef = { ownerId, path: node.path };
  const id = nodeId(ref);
  const isRoot = node.path === '';
  const isExpanded = isFolder ? expanded.has(id) || isRoot : false;
  const isActive = activeId === id;
  const own = ownerId === mine;
  const label = displayName(node);

  const draggable = useDraggable({ id, disabled: isRoot || !canWrite });
  const droppable = useDroppable({ id, disabled: !isFolder || !canWrite });

  const Icon: LucideIcon = isFolder
    ? isExpanded
      ? FolderOpen
      : Folder
    : isIndexNote(node)
      ? House
      : node.type === 'note'
        ? FileText
        : ImageIcon;
  const sharedTo = isFolder && own ? sharedWith.get(node.path) : undefined;

  const menuAt = (x: number, y: number) => openMenu({ ref, node, canWrite, isFolder, x, y });

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    menuAt(e.clientX, e.clientY);
  };

  // Soltar archivos del escritorio va por el canal `DataTransfer` del
  // navegador, no por dnd-kit, que arrastra con pointer events. Conviven en la
  // misma fila sin pisarse: uno mueve nodos del árbol, el otro trae archivos
  // de fuera.
  const [filesOver, setFilesOver] = useState(false);
  const acceptsFiles = isFolder && canWrite;
  const carriesFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const onFileDragOver = (e: React.DragEvent) => {
    if (!acceptsFiles || !carriesFiles(e)) return;
    // Sin `preventDefault` el navegador se queda el drop y abre el archivo.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setFilesOver(true);
  };

  const onFileDrop = (e: React.DragEvent) => {
    if (!acceptsFiles || !carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFilesOver(false);
    onFilesDrop(ref, e.dataTransfer.files);
  };

  const onClick = () => {
    if (isRoot) return;
    if (isFolder) {
      toggle(id);
    } else if (node.type === 'note') {
      router.push(notePathToRoute(ref, mine));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onClick();
    } else if (e.key === 'Delete' && canWrite && !isRoot) {
      e.preventDefault();
      onDeleteKey(ref, node);
    } else if (
      (e.key === 'ArrowRight' && isFolder && !isExpanded) ||
      (e.key === 'ArrowLeft' && isFolder && isExpanded)
    ) {
      e.preventDefault();
      toggle(id);
    }
  };

  return (
    <div>
      {!isRoot && (
        <div className="group/row relative">
          <div
            ref={(el) => {
              draggable.setNodeRef(el);
              droppable.setNodeRef(el);
            }}
            {...draggable.attributes}
            {...draggable.listeners}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onMouseEnter={() => {
              if (node.type === 'note') onPrefetch(ref);
            }}
            onContextMenu={onContext}
            onDragOver={onFileDragOver}
            onDragLeave={() => setFilesOver(false)}
            onDrop={onFileDrop}
            data-node-id={id}
            aria-current={isActive ? 'page' : undefined}
            aria-expanded={isFolder ? isExpanded : undefined}
            aria-label={label}
            title={node.type !== 'folder' ? node.name : undefined}
            style={{ paddingLeft: 6 + depth * 14 }}
            className={cn(
              'flex h-7 cursor-default select-none items-center gap-1.5 rounded-md pr-2 text-[13px] outline-none transition-colors',
              'text-fg-secondary focus-visible:ring-1 focus-visible:ring-accent',
              'group-hover/row:bg-bg-hover group-hover/row:text-fg-primary',
              isActive && 'bg-bg-elevated text-fg-primary',
              (droppable.isOver && isFolder) || filesOver ? 'bg-accent/10 ring-1 ring-accent' : '',
              menuFor === id && 'bg-bg-hover text-fg-primary',
              draggable.isDragging && 'opacity-40',
            )}
          >
            {isFolder ? (
              <span className="flex h-5 w-4 shrink-0 items-center justify-center text-fg-muted">
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <Icon
              size={14}
              strokeWidth={1.75}
              className={cn('shrink-0', isActive ? 'text-accent-hover' : 'text-fg-muted')}
            />
            <span className={cn('flex-1 truncate', isIndexNote(node) && 'text-fg-primary')}>
              {label}
            </span>
            {busy.has(id) ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-fg-muted" />
            ) : (
              sharedTo &&
              sharedTo.length > 0 && (
                <span
                  title={`Shared with ${sharedTo.join(', ')}`}
                  className="flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-accent-hover group-hover/row:invisible"
                >
                  <Users size={11} strokeWidth={2} />
                  {sharedTo.length}
                </span>
              )
            )}
          </div>
          {/*
            Hover actions sit beside the row rather than inside it, so they are
            real buttons a keyboard can reach, and dnd-kit does not take a click
            on them for the start of a drag.
          */}
          <div
            className={cn(
              'absolute right-1 top-0.5 hidden items-center gap-px rounded-md bg-bg-hover',
              'group-hover/row:flex group-focus-within/row:flex',
              menuFor === id && 'flex',
            )}
          >
            {isFolder && own && (
              <button
                type="button"
                onClick={() => onShare(node.path)}
                title={`Share “${label}”`}
                aria-label={`Share ${label}`}
                className="grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <UserPlus size={13} strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                menuAt(r.left, r.bottom + 4);
              }}
              title="More actions"
              aria-label={`More actions for ${label}`}
              aria-haspopup="menu"
              className="grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
            >
              <Ellipsis size={14} />
            </button>
          </div>
        </div>
      )}
      {isFolder && (isExpanded || isRoot) && node.children && (
        <div>
          {orderChildren(node.children).map((child) => (
            <NodeRow key={child.path} {...props} node={child} depth={isRoot ? 0 : depth + 1} />
          ))}
          {node.children.length === 0 && !isRoot && (
            <div
              style={{ paddingLeft: 6 + (depth + 1) * 14 + 22 }}
              className="py-1 text-xs text-fg-muted"
            >
              Empty folder
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroupHeader({
  children,
  actions,
  onToggle,
  open,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  onToggle?(): void;
  open?: boolean;
}) {
  const label = (
    <span className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
      {onToggle && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      {children}
    </span>
  );
  return (
    <div className="mt-2 flex h-7 items-center justify-between pl-2 pr-1">
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={open}>
          {label}
        </button>
      ) : (
        label
      )}
      {actions && <div className="flex items-center gap-px">{actions}</div>}
    </div>
  );
}

function HeaderAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg-primary"
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// FileTree
// ---------------------------------------------------------------------------

export function FileTree() {
  const router = useRouter();
  const treeQ = trpc.notes.tree.useQuery({ depth: MAX_TREE_DEPTH });
  const pathname = usePathname() ?? '';
  const openPalette = useOpenPalette();
  const mod = useModKey();
  const recent = useRecentNotes();

  // What this user has shared, folded into a path -> people map so the tree can
  // mark it.
  const mySharesQ = trpc.sharing.listMyShares.useQuery();
  const sharedRootsQ = trpc.sharing.listSharedWithMe.useQuery();
  const sharedRoots = useMemo(() => sharedRootsQ.data ?? [], [sharedRootsQ.data]);

  /**
   * Every write from this tree names this vault explicitly.
   *
   * The server refuses a write whose path could mean a folder somebody shared
   * with you, because a bare path is ambiguous. Here it never is — you clicked
   * a node in your own tree. Saying so is what keeps a folder of yours writable
   * when somebody happens to share one of the same name.
   */
  const meQ = trpc.auth.me.useQuery();
  const mine = meQ.data?.user?.id;
  const sharedWith = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of mySharesQ.data ?? []) {
      const who = `${m.displayName ?? m.email} (${m.permission === 'write' ? 'can edit' : 'read only'})`;
      const at = map.get(m.folderPath);
      if (at) at.push(who);
      else map.set(m.folderPath, [who]);
    }
    return map;
  }, [mySharesQ.data]);
  const utils = trpc.useUtils();

  const activeRef = useMemo(() => activeRefFrom(pathname, mine), [pathname, mine]);
  const activeId = activeRef ? nodeId(activeRef) : null;

  const moveM = trpc.notes.move.useMutation();
  const moveToOwnerM = trpc.notes.moveToOwner.useMutation();
  const createM = trpc.notes.create.useMutation();
  const createFolderM = trpc.notes.createFolder.useMutation();
  const removeM = trpc.notes.remove.useMutation();

  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());
  const [recentOpen, setRecentOpen] = useState(true);

  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);

  useEffect(() => {
    try {
      setRecentOpen(window.localStorage.getItem(RECENT_OPEN_KEY) !== '0');
    } catch {
      // ignore
    }
  }, []);
  const toggleRecent = () =>
    setRecentOpen((prev) => {
      try {
        window.localStorage.setItem(RECENT_OPEN_KEY, prev ? '0' : '1');
      } catch {
        // ignore
      }
      return !prev;
    });

  // The open note's folders unfold on their own, so it is always in sight.
  useEffect(() => {
    if (!activeRef) return;
    const parts = activeRef.path.split('/').slice(0, -1);
    if (parts.length === 0) return;
    setExpanded((prev) => {
      let next: Set<string> | null = null;
      for (let i = 1; i <= parts.length; i++) {
        const id = nodeId({ ownerId: activeRef.ownerId, path: parts.slice(0, i).join('/') });
        if (!prev.has(id)) (next ??= new Set(prev)).add(id);
      }
      return next ?? prev;
    });
  }, [activeRef]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // A breadcrumb in the note header asks to see its folder here.
  useEffect(() => {
    if (!mine) return;
    const onReveal = (e: Event) => {
      const { ownerId = mine, path } = (e as CustomEvent<RevealFolderDetail>).detail;
      const parts = path.split('/');
      const ids = parts.map((_, i) => nodeId({ ownerId, path: parts.slice(0, i + 1).join('/') }));
      setExpanded((prev) => new Set([...prev, ...ids]));
      requestAnimationFrame(() => {
        const row = scrollRef.current?.querySelector<HTMLElement>(
          `[data-node-id="${CSS.escape(ids[ids.length - 1]!)}"]`,
        );
        row?.scrollIntoView({ block: 'center' });
        row?.focus();
      });
    };
    window.addEventListener(REVEAL_FOLDER_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_FOLDER_EVENT, onReveal);
  }, [mine]);

  useEffect(() => {
    if (!activeId) return;
    const h = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(h);
  }, [activeId, treeQ.data]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Archivos del escritorio sobrevolando el hueco del árbol (= la raíz). */
  const [rootFilesOver, setRootFilesOver] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  /** Un move entre bóvedas, esperando que lo confirmen. */
  const [confirmCrossVault, setConfirmCrossVault] = useState<{
    src: NodeRef;
    dst: NodeRef;
    toPath: string;
  } | null>(null);
  const [shareFolderPath, setShareFolderPath] = useState<string | null>(null);
  /** The node a prompt is about, so create/rename know whose vault to write to. */
  const [promptRef, setPromptRef] = useState<NodeRef | null>(null);
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
    await Promise.all([
      utils.notes.tree.invalidate(),
      utils.notes.list.invalidate(),
      // A migration into a shared folder changes the other side of the sidebar
      // too, and that tree is a different query.
      utils.notes.treeForOwner.invalidate(),
      // New/renamed/moved/deleted notes change link targets, so the full
      // Graph view's edge set is stale otherwise.
      utils.notes.graph.invalidate(),
    ]);
  }, [utils]);

  // Warm the cache so clicking a note shows content immediately.
  const prefetchedRef = useRef<Set<string>>(new Set());
  const prefetchNote = useCallback(
    (ref: NodeRef) => {
      const key = nodeId(ref);
      if (prefetchedRef.current.has(key)) return;
      prefetchedRef.current.add(key);
      void utils.notes.get.prefetch({ path: ref.path, ownerId: ref.ownerId });
    },
    [utils],
  );

  const markBusy = useCallback((ref: NodeRef, on: boolean) => {
    const key = nodeId(ref);
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openMenu = useCallback((m: MenuState) => setMenu(m), []);

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const rootNode = useMemo<TreeNode>(
    () => treeQ.data ?? { path: '', name: '', type: 'folder', children: [] },
    [treeQ.data],
  );

  const onRootContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // El root del menú de fondo es tu propia bóveda.
      if (mine) {
        openMenu({
          ref: { ownerId: mine, path: '' },
          node: rootNode,
          canWrite: true,
          isFolder: true,
          x: e.clientX,
          y: e.clientY,
        });
      }
    },
    [openMenu, mine, rootNode],
  );

  // ---------------------------------------------------------------------------
  // DnD: move on drop
  // ---------------------------------------------------------------------------

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const src = parseNodeId(String(e.active.id));
      const dst = e.over?.id != null ? parseNodeId(String(e.over.id)) : null;
      if (!src || !dst) return;

      // Un nodo dentro de sí mismo no tiene destino. `isInside` no cruza de
      // bóveda, así que soltar sobre una carpeta ajena del mismo nombre no se
      // confunde con esto.
      if (isInside(dst, src)) {
        pushToast('error', "can't move a folder inside itself");
        return;
      }

      const name = src.path.split('/').pop() ?? src.path;
      const toPath = dst.path === '' ? name : `${dst.path}/${name}`;
      if (sameNode(src, { ownerId: dst.ownerId, path: toPath })) return;

      // Cruzar de bóveda no es mover: transfiere la propiedad. Las notas se van
      // del vault de origen, y quien era dueño puede quedarse sin ellas o con
      // menos permiso del que tenía. Un drag es demasiado barato para algo que
      // le cambia el acceso a otra persona, así que acá se pregunta.
      if (src.ownerId !== dst.ownerId) {
        setConfirmCrossVault({ src, dst, toPath });
        return;
      }

      markBusy(src, true);
      try {
        const result = await moveM.mutateAsync({
          from: src.path,
          to: toPath,
          ownerId: src.ownerId,
        });
        await refresh();
        const mocs = result.affectedMocs.length
          ? ` (review MOCs: ${result.affectedMocs.join(', ')})`
          : '';
        pushToast('info', `moved to ${result.path}${mocs}`);
      } catch (err) {
        pushToast('error', (err as Error).message);
      } finally {
        markBusy(src, false);
      }
    },
    [moveM, pushToast, refresh, markBusy],
  );

  /** El nombre con el que esta persona aparece en el árbol. */
  const ownerLabel = useCallback(
    (ownerId: string): string => {
      if (ownerId === mine) return 'you';
      const root = sharedRoots.find((r) => r.ownerId === ownerId);
      if (!root) return 'the other person';
      return root.ownerDisplayName ?? root.ownerEmail.split('@')[0] ?? root.ownerEmail;
    },
    [mine, sharedRoots],
  );

  const runCrossVaultMove = useCallback(
    async (src: NodeRef, dst: NodeRef, toPath: string) => {
      markBusy(src, true);
      try {
        // Los wikilinks que cruzan el borde nuevo no se pueden reescribir, y
        // `moveToOwner` informa cuáles.
        const result = await moveToOwnerM.mutateAsync({
          from: src.path,
          fromOwnerId: src.ownerId,
          to: toPath,
          toOwnerId: dst.ownerId,
        });
        await refresh();
        const dangling = result.linksLeftDangling.length + result.linksNowBroken.length;
        pushToast(
          'info',
          `moved to ${result.path}, now owned by ${ownerLabel(dst.ownerId)}` +
            (dangling > 0 ? `; ${dangling} wikilink(s) no longer resolve` : ''),
        );
      } catch (err) {
        pushToast('error', (err as Error).message);
      } finally {
        markBusy(src, false);
      }
    },
    [moveToOwnerM, pushToast, refresh, markBusy, ownerLabel],
  );

  const createNote = useCallback((ref: NodeRef) => {
    setPromptRef(ref);
    setPrompt({
      kind: 'createNote',
      targetPath: ref.path,
      title: ref.path ? `New note in ${ref.path}` : 'New note',
      label: 'Name (without .md)',
    });
  }, []);

  /**
   * Importa archivos .md como notas de verdad, por el mismo camino que "New
   * note": una llamada a `notes.create` por archivo, con el contenido literal.
   *
   * El dueño es el de la carpeta destino, no quien importa: soltar en una
   * carpeta compartida escribe en la bóveda de su dueño, que es lo que
   * mantiene el share cubriendo lo que acaba de entrar.
   */
  const runImport = useCallback(
    async (ref: NodeRef, fileList: FileList) => {
      const files = Array.from(fileList).filter(isMarkdownFile);
      const ignored = fileList.length - files.length;
      if (files.length === 0) {
        pushToast('error', 'nothing to import — only .md files');
        return;
      }

      markBusy(ref, true);
      try {
        const summary = await importMarkdownFiles(files, ref.path, ({ path, content }) =>
          createM.mutateAsync({ path, ownerId: ref.ownerId, content }),
        );
        setExpanded((prev) => new Set(prev).add(nodeId(ref)));
        await refresh();
        const { kind, text } = summarizeImport(summary);
        pushToast(kind, ignored > 0 ? `${text} — ${ignored} ignored (not .md)` : text);
      } finally {
        markBusy(ref, false);
      }
    },
    [createM, refresh, pushToast, markBusy],
  );

  /** El destino elegido, esperando a que el diálogo de archivos devuelva algo. */
  const importRef = useRef<NodeRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const importNotes = useCallback((ref: NodeRef) => {
    importRef.current = ref;
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const ref = importRef.current;
      const files = e.target.files;
      // Reiniciar el input: sin esto, volver a elegir los mismos archivos no
      // dispara `change` y el segundo intento parece no hacer nada.
      if (ref && files && files.length > 0) void runImport(ref, files);
      e.target.value = '';
    },
    [runImport],
  );

  const createFolder = useCallback((ref: NodeRef) => {
    setPromptRef(ref);
    setPrompt({
      kind: 'createFolder',
      targetPath: ref.path,
      title: ref.path ? `New folder in ${ref.path}` : 'New folder',
      label: 'Folder name',
    });
  }, []);

  const renamePath = useCallback((ref: NodeRef) => {
    if (ref.path === '') return;
    const basename = (ref.path.split('/').pop() ?? ref.path).replace(/\.md$/i, '');
    setPromptRef(ref);
    setPrompt({
      kind: 'rename',
      targetPath: ref.path,
      title: `Rename ${basename}`,
      label: 'New name. Links to it are updated.',
      defaultValue: basename,
    });
  }, []);

  const movePath = useCallback((ref: NodeRef) => {
    if (ref.path === '') return;
    const basename = (ref.path.split('/').pop() ?? ref.path).replace(/\.md$/i, '');
    setPromptRef(ref);
    setPrompt({
      kind: 'move',
      targetPath: ref.path,
      title: `Move ${basename}`,
      label: 'Destination folder, or / for the vault root. Links to it are updated.',
      defaultValue: parentOf(ref.path) || '/',
    });
  }, []);

  const deletePath = useCallback(
    (ref: NodeRef, node: TreeNode) => {
      if (ref.path === '') return;
      const isFolder = node.type === 'folder';
      const own = ref.ownerId === mine;
      let people = 0;
      if (isFolder && own) {
        for (const [folder, who] of sharedWith) {
          if (folder === ref.path || folder.startsWith(`${ref.path}/`)) people += who.length;
        }
      }
      setConfirmDelete({
        ownerId: ref.ownerId,
        path: ref.path,
        isFolder,
        notePaths: notesUnder(node),
        people,
        own,
      });
    },
    [mine, sharedWith],
  );

  const runPrompt = useCallback(
    async (value: string) => {
      if (!prompt || !promptRef) return;
      const { kind, targetPath } = prompt;
      // La bóveda la decide el nodo sobre el que se abrió el menú, no quien
      // está mirando: crear dentro de una carpeta compartida escribe en la
      // bóveda de su dueño, que es lo que mantiene el share cubriéndola.
      const owner = promptRef.ownerId;
      setPrompt(null);
      const name = value.trim();
      if (!name) return;

      if (kind === 'createNote') {
        const path = targetPath === '' ? `${name}.md` : `${targetPath}/${name}.md`;
        try {
          const result = await createM.mutateAsync({
            path,
            ownerId: owner,
            content: `# ${name}\n`,
            frontmatter: { created: new Date().toISOString().slice(0, 10), tags: [] },
          });
          setExpanded((prev) => new Set(prev).add(nodeId({ ownerId: owner, path: targetPath })));
          await refresh();
          const mocs = result.affectedMocs.length
            ? ` (review MOCs: ${result.affectedMocs.join(', ')})`
            : '';
          pushToast('info', `created ${result.path}${mocs}`);
          router.push(notePathToRoute({ ownerId: owner, path: result.path }, mine));
        } catch (err) {
          pushToast('error', (err as Error).message);
        }
      } else if (kind === 'createFolder') {
        const path = targetPath === '' ? name : `${targetPath}/${name}`;
        try {
          await createFolderM.mutateAsync({ path, ownerId: owner });
          // La nueva y la que la contiene: crear dentro de una carpeta colapsada
          // dejaba lo recién creado fuera de la vista, y el cartel de éxito
          // parecía estar mintiendo.
          setExpanded((prev) =>
            new Set(prev)
              .add(nodeId({ ownerId: owner, path }))
              .add(nodeId({ ownerId: owner, path: targetPath })),
          );
          await refresh();
          pushToast('info', `created folder ${path}`);
        } catch (err) {
          pushToast('error', (err as Error).message);
        }
      } else {
        const from = targetPath;
        const basename = from.split('/').pop() ?? from;
        const isNote = /\.md$/i.test(basename);
        let to: string;
        if (kind === 'rename') {
          const next = isNote && !/\.md$/i.test(name) ? `${name}.md` : name;
          if (next === basename) return;
          const parent = parentOf(from);
          to = parent === '' ? next : `${parent}/${next}`;
        } else {
          const folder = name.replace(/^\/+|\/+$/g, '');
          to = folder === '' ? basename : `${folder}/${basename}`;
          if (to === from) return;
        }
        try {
          const result = await moveM.mutateAsync({ from, to, ownerId: owner });
          await refresh();
          pushToast('info', `${kind === 'rename' ? 'renamed' : 'moved'} to ${result.path}`);
          // The open note moved with it: follow it to its new address.
          const fromRef = { ownerId: owner, path: from };
          if (activeRef && isInside(activeRef, fromRef)) {
            const moved = `${result.path}${activeRef.path.slice(from.length)}`;
            router.replace(notePathToRoute({ ownerId: owner, path: moved }, mine));
          }
        } catch (err) {
          pushToast('error', (err as Error).message);
        }
      }
    },
    [prompt, promptRef, createM, createFolderM, moveM, refresh, pushToast, activeRef, mine, router],
  );

  const runDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    const ref: NodeRef = { ownerId: target.ownerId, path: target.path };
    markBusy(ref, true);
    try {
      await removeM.mutateAsync({
        path: target.path,
        recursive: true,
        ownerId: target.ownerId,
      });
      await Promise.all([refresh(), utils.sharing.listMyShares.invalidate()]);
      forgetRecent(notePathToRoute(ref, mine));
      pushToast('info', `deleted ${target.path}`);
      // The note on screen went with it.
      if (activeRef && isInside(activeRef, ref)) router.push('/notes');
    } catch (err) {
      pushToast('error', (err as Error).message);
    } finally {
      markBusy(ref, false);
    }
  }, [confirmDelete, removeM, refresh, pushToast, markBusy, utils, mine, activeRef, router]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const ownerGroups = useMemo(() => groupSharedOwners(sharedRoots), [sharedRoots]);

  const recentOthers = recent.filter((r) => r.href !== pathname).slice(0, 4);

  const rowShared: RowShared = {
    expanded,
    toggle,
    menuFor: menu ? nodeId(menu.ref) : null,
    activeId,
    openMenu,
    onDeleteKey: deletePath,
    onShare: setShareFolderPath,
    onPrefetch: prefetchNote,
    onFilesDrop: (ref, files) => void runImport(ref, files),
    busy,
    sharedWith,
    mine,
  };

  return (
    <div className="relative flex h-full flex-col bg-bg-surface" onContextMenu={onRootContextMenu}>
      {/* pl-10 on phones: the menu button floats over this row there. */}
      <div className="p-2.5 pb-1 pl-10 md:pl-2.5">
        <button
          type="button"
          onClick={openPalette}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-bg-base pl-2.5 pr-1.5 text-[13px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg-secondary"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded border border-border bg-bg-elevated px-1 font-mono text-[10.5px] text-fg-secondary">
            {mod} K
          </kbd>
        </button>
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/* La raíz de tu bóveda no dibuja fila propia, así que soltar
            archivos en el hueco del árbol importa a la raíz. Las filas
            paran la propagación, de modo que esto sólo salta en el vacío. */}
        <div
          ref={scrollRef}
          className={cn(
            'flex-1 overflow-y-auto px-1.5 pb-4',
            rootFilesOver ? 'bg-accent/5 ring-1 ring-inset ring-accent' : '',
          )}
          onContextMenu={onRootContextMenu}
          onDragOver={(e) => {
            if (!mine || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setRootFilesOver(true);
          }}
          onDragLeave={() => setRootFilesOver(false)}
          onDrop={(e) => {
            if (!mine || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setRootFilesOver(false);
            void runImport({ ownerId: mine, path: '' }, e.dataTransfer.files);
          }}
        >
          {recentOthers.length > 0 && (
            <>
              <GroupHeader onToggle={toggleRecent} open={recentOpen}>
                Recent
              </GroupHeader>
              {recentOpen &&
                recentOthers.map((r) => (
                  <button
                    key={r.href}
                    type="button"
                    onClick={() => router.push(r.href)}
                    title={r.path}
                    className="flex h-7 w-full items-center gap-1.5 rounded-md pl-[28px] pr-2 text-left text-[13px] text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
                  >
                    <Clock size={13} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
                    <span className="truncate">{r.title}</span>
                  </button>
                ))}
            </>
          )}

          <GroupHeader
            actions={
              mine && (
                <>
                  <HeaderAction
                    icon={FilePlus}
                    label="New note"
                    onClick={() => createNote({ ownerId: mine, path: '' })}
                  />
                  <HeaderAction
                    icon={FolderPlus}
                    label="New folder"
                    onClick={() => createFolder({ ownerId: mine, path: '' })}
                  />
                  <HeaderAction
                    icon={FileUp}
                    label="Import .md files"
                    onClick={() => importNotes({ ownerId: mine, path: '' })}
                  />
                </>
              )
            }
          >
            My vault
            {treeQ.isFetching && <Loader2 size={10} className="animate-spin" />}
          </GroupHeader>
          {mine && <NodeRow {...rowShared} node={rootNode} ownerId={mine} canWrite depth={-1} />}
          {treeQ.data && rootNode.children?.length === 0 && (
            <div className="px-4 py-4 text-center text-xs text-fg-muted">
              Your vault is empty. Use the buttons above, or right-click here, to add a note or a
              folder.
            </div>
          )}

          {/* Lo compartido va en la misma lista y con las mismas filas que
              lo propio: una sección aparte obligaba a aprender dos árboles,
              y el de abajo no dejaba crear ni arrastrar nada. */}
          {ownerGroups.length > 0 && (
            <>
              <GroupHeader>
                <Users size={11} /> Shared with me
              </GroupHeader>
              {ownerGroups.map((g) => {
                const { color } = g;
                const canEdit = g.roots.some((r) => r.permission === 'write');
                return (
                  <div key={g.ownerId} className="mt-1">
                    <div className="flex h-6 items-center gap-2 px-2 text-xs text-fg-secondary">
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: color, boxShadow: `0 0 0 3px ${color}2e` }}
                      />
                      <span className="truncate" title={g.roots[0]?.ownerEmail}>
                        {g.name}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-fg-muted">
                        {canEdit ? (
                          'can edit'
                        ) : (
                          <>
                            <Lock size={10} /> read only
                          </>
                        )}
                      </span>
                    </div>
                    {g.roots.map((r) => (
                      <SharedBranch
                        key={`${r.ownerId}:${r.folderPath}`}
                        root={r}
                        rowShared={rowShared}
                      />
                    ))}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </DndContext>

      {menu && (
        <RowMenu
          menu={menu}
          menuRef={menuRef}
          mine={mine}
          onClose={() => setMenu(null)}
          actions={{
            newNote: createNote,
            newFolder: createFolder,
            importHere: importNotes,
            rename: renamePath,
            move: movePath,
            share: setShareFolderPath,
            remove: deletePath,
          }}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,text/markdown"
        className="hidden"
        onChange={onFilePicked}
      />

      <PromptModal
        open={prompt !== null}
        title={prompt?.title ?? ''}
        label={prompt?.label}
        defaultValue={prompt?.defaultValue}
        okLabel={prompt?.kind === 'rename' ? 'Rename' : prompt?.kind === 'move' ? 'Move' : 'Create'}
        onCancel={() => setPrompt(null)}
        onConfirm={runPrompt}
      />

      <ShareFolderModal
        folderPath={shareFolderPath ?? ''}
        open={shareFolderPath !== null}
        onClose={() => setShareFolderPath(null)}
      />

      <ConfirmModal
        open={confirmCrossVault !== null}
        title="Change owner?"
        message={
          confirmCrossVault
            ? `“${confirmCrossVault.src.path.split('/').pop()}” moves from ` +
              `${ownerLabel(confirmCrossVault.src.ownerId)} to ` +
              `${ownerLabel(confirmCrossVault.dst.ownerId)}.

` +
              'It is not a copy: the notes leave the vault they are in. Whoever stops owning ' +
              'them keeps seeing them only if the destination is shared with them, and with ' +
              'the permission they have there.'
            : undefined
        }
        okLabel="Move and change owner"
        onCancel={() => setConfirmCrossVault(null)}
        onConfirm={() => {
          const pending = confirmCrossVault;
          setConfirmCrossVault(null);
          if (pending) void runCrossVaultMove(pending.src, pending.dst, pending.toPath);
        }}
      />

      <DeleteDialog
        target={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void runDelete()}
      />

      <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-end gap-1">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto max-w-md rounded-md border px-3 py-1.5 text-xs shadow-lg',
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

// ---------------------------------------------------------------------------
// Row menu
// ---------------------------------------------------------------------------

interface RowMenuActions {
  newNote(ref: NodeRef): void;
  newFolder(ref: NodeRef): void;
  importHere(ref: NodeRef): void;
  rename(ref: NodeRef): void;
  move(ref: NodeRef): void;
  share(path: string): void;
  remove(ref: NodeRef, node: TreeNode): void;
}

type MenuEntry =
  | { sep: true }
  | { note: string }
  | { label: string; icon: LucideIcon; run(): void; danger?: boolean; hint?: string };

function RowMenu({
  menu,
  menuRef,
  mine,
  onClose,
  actions,
}: {
  menu: MenuState;
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  mine: string | undefined;
  onClose(): void;
  actions: RowMenuActions;
}) {
  const { ref, node, canWrite, isFolder } = menu;
  const isRoot = ref.path === '';
  // Creating "in" a note means creating beside it.
  const container: NodeRef = isFolder ? ref : { ownerId: ref.ownerId, path: parentOf(ref.path) };
  const entries: MenuEntry[] = [];

  if (!canWrite) {
    entries.push({ note: 'Read only' });
  } else {
    if (isFolder) {
      entries.push(
        {
          label: isRoot ? 'New note' : 'New note here',
          icon: FilePlus,
          run: () => actions.newNote(container),
        },
        {
          label: isRoot ? 'New folder' : 'New folder here',
          icon: FolderPlus,
          run: () => actions.newFolder(container),
        },
        { label: 'Import .md files…', icon: FileUp, run: () => actions.importHere(container) },
      );
    }
    if (!isRoot) {
      entries.push(
        { label: 'Rename', icon: Pencil, run: () => actions.rename(ref) },
        { label: 'Move to…', icon: FolderInput, run: () => actions.move(ref) },
      );
    }
    // Re-sharing what somebody shared with you does not exist, so the option
    // only appears on your own folders.
    if (isFolder && !isRoot && ref.ownerId === mine) {
      entries.push({ label: 'Share…', icon: UserPlus, run: () => actions.share(ref.path) });
    }
    if (!isRoot) {
      entries.push(
        { sep: true },
        {
          label: isFolder ? 'Delete folder' : 'Delete note',
          icon: Trash2,
          danger: true,
          hint: 'Del',
          run: () => actions.remove(ref, node),
        },
      );
    }
  }

  const width = 220;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
  const estHeight = entries.length * 32 + 12;
  const top =
    menu.y + estHeight > window.innerHeight - 8 ? Math.max(8, menu.y - estHeight - 8) : menu.y;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        onKeyDown={onKeyDown}
        className="fixed z-[61] rounded-lg border border-border bg-bg-elevated p-1 shadow-2xl"
        style={{ left, top, width }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {entries.map((entry, i) => {
          if ('sep' in entry) return <div key={i} className="mx-0.5 my-1 h-px bg-border" />;
          if ('note' in entry) {
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11px] text-fg-muted"
              >
                <Lock size={11} /> {entry.note}
              </div>
            );
          }
          const Icon = entry.icon;
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                entry.run();
              }}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none',
                entry.danger
                  ? 'text-red-400 hover:bg-red-500/10 focus-visible:bg-red-500/10'
                  : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:text-fg-primary',
              )}
            >
              <Icon size={14} strokeWidth={1.75} />
              <span className="flex-1">{entry.label}</span>
              {entry.hint && (
                <kbd className="rounded border border-border px-1 font-mono text-[10px] text-fg-muted">
                  {entry.hint}
                </kbd>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * A folder somebody shared, drawn as a branch of the same tree.
 *
 * Its own query, because each shared root lives in a different vault and hooks
 * cannot be spun up per item in the parent. Everything below it is a plain
 * NodeRow, so the context menu, the drag and the permission all behave exactly
 * as they do over your own notes — which is the point: there is one tree.
 */
function SharedBranch({
  root,
  rowShared,
}: {
  root: {
    ownerId: string;
    folderPath: string;
    ownerDisplayName: string | null;
    ownerEmail: string;
    permission: 'read' | 'write';
  };
  rowShared: RowShared;
}) {
  const q = trpc.notes.treeForOwner.useQuery(
    { ownerId: root.ownerId, path: root.folderPath, depth: MAX_TREE_DEPTH },
    { enabled: !!root.ownerId },
  );

  if (q.error) {
    return (
      <div className="px-4 py-1 text-xs text-red-300" title={q.error.message}>
        {root.folderPath}: no access
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-fg-muted">
        <Loader2 size={10} className="animate-spin" />
        {root.folderPath}
      </div>
    );
  }

  return (
    <NodeRow
      {...rowShared}
      node={q.data}
      ownerId={root.ownerId}
      canWrite={root.permission === 'write'}
      depth={0}
    />
  );
}
