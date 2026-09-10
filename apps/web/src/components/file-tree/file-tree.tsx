'use client';

// Hierarchical vault browser. Drag a node onto a folder to move it
// (server rewrites wikilinks). Right-click for context actions. Drop OS
// `.md` files onto a folder to import them as notes — imports run
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
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { SearchInput } from '@/components/search/search-input';
import { ConfirmModal, PromptModal } from '@/components/ui/prompt-modal';
import { isInside, nodeId, parseNodeId, sameNode, type NodeRef } from '@/lib/tree-node-id';
import { importMarkdownFiles, isMarkdownFile, summarizeImport } from '@/lib/import-md';
import { ShareFolderModal } from '@/components/sharing/share-folder-modal';
import { useSharingEnabled } from '@/lib/use-deployment';

type PromptKind = 'createNote' | 'createFolder' | 'rename';
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

const EXPANDED_KEY = 'brainstack:tree-expanded';

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
  openMenu(ref: NodeRef, canWrite: boolean, isFolder: boolean, x: number, y: number): void;
  onDeleteClick(ref: NodeRef): void;
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

function NodeRow({
  node,
  ownerId,
  canWrite,
  depth,
  expanded,
  toggle,
  menuFor,
  openMenu,
  onDeleteClick,
  onPrefetch,
  onFilesDrop,
  busy,
  sharedWith,
  mine,
}: NodeRowProps) {
  const router = useRouter();
  const isFolder = node.type === 'folder';
  const ref: NodeRef = { ownerId, path: node.path };
  const id = nodeId(ref);
  const isRoot = node.path === '';
  const isExpanded = isFolder ? expanded.has(id) || isRoot : false;

  const draggable = useDraggable({ id, disabled: isRoot || !canWrite });
  const droppable = useDroppable({ id, disabled: !isFolder || !canWrite });

  const Icon = isFolder ? Folder : node.type === 'note' ? FileText : ImageIcon;
  const sharedTo = isFolder && ownerId === mine ? sharedWith.get(node.path) : undefined;

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(ref, canWrite, isFolder, e.clientX, e.clientY);
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
    } else if (node.type === 'attachment') {
      router.push(`/files/${node.path.split('/').map(encodeURIComponent).join('/')}`);
    }
  };

  return (
    <div>
      {!isRoot && (
        <div
          ref={(el) => {
            draggable.setNodeRef(el);
            droppable.setNodeRef(el);
          }}
          {...draggable.attributes}
          {...draggable.listeners}
          onClick={onClick}
          onMouseEnter={() => {
            if (node.type === 'note') onPrefetch(ref);
          }}
          onContextMenu={onContext}
          onDragOver={onFileDragOver}
          onDragLeave={() => setFilesOver(false)}
          onDrop={onFileDrop}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            'group flex h-7 cursor-default select-none items-center gap-1.5 rounded pr-1 text-sm transition-colors',
            'hover:bg-bg-elevated',
            (droppable.isOver && isFolder) || filesOver ? 'bg-accent/10 ring-1 ring-accent' : '',
            menuFor === id ? 'bg-bg-elevated' : '',
            draggable.isDragging ? 'opacity-40' : '',
          )}
        >
          {isFolder ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle(id);
              }}
              className="flex h-5 w-5 items-center justify-center text-fg-muted"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <Icon size={13} className="text-fg-muted" strokeWidth={1.75} />
          <span className="flex-1 truncate font-mono text-[12px] text-fg-secondary">
            {node.name}
          </span>
          {sharedTo && sharedTo.length > 0 && (
            <span
              title={`Shared with ${sharedTo.join(', ')}`}
              className="flex shrink-0 items-center gap-0.5 rounded border border-border-subtle px-1 font-mono text-[9px] text-fg-muted"
            >
              <Users size={9} strokeWidth={2} />
              {sharedTo.length}
            </span>
          )}
          {busy.has(id) ? (
            <Loader2 size={11} className="animate-spin text-fg-muted" />
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteClick(ref);
              }}
              title="Delete"
              className="flex h-5 w-5 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-bg-surface hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 size={11} strokeWidth={1.75} />
            </button>
          )}
        </div>
      )}
      {isFolder && (isExpanded || isRoot) && node.children && (
        <div>
          {node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              ownerId={ownerId}
              canWrite={canWrite}
              depth={isRoot ? 0 : depth + 1}
              expanded={expanded}
              toggle={toggle}
              menuFor={menuFor}
              openMenu={openMenu}
              onDeleteClick={onDeleteClick}
              onPrefetch={onPrefetch}
              onFilesDrop={onFilesDrop}
              busy={busy}
              sharedWith={sharedWith}
              mine={mine}
            />
          ))}
          {node.children.length === 0 && !isRoot && (
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

  // What this user has shared, folded into a path -> people map so the tree can
  // mark it. Only asked for where sharing exists; self-host has nobody to share
  // with and the procedure returns an empty list there anyway.
  const sharingEnabled = useSharingEnabled();
  const mySharesQ = trpc.sharing.listMyShares.useQuery(undefined, { enabled: sharingEnabled });
  const sharedRootsQ = trpc.sharing.listSharedWithMe.useQuery(undefined, {
    enabled: sharingEnabled,
  });
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
      const who = `${m.displayName ?? m.email} (${m.permission === 'write' ? 'escritura' : 'lectura'})`;
      const at = map.get(m.folderPath);
      if (at) at.push(who);
      else map.set(m.folderPath, [who]);
    }
    return map;
  }, [mySharesQ.data]);
  const utils = trpc.useUtils();

  const moveM = trpc.notes.move.useMutation();
  const moveToOwnerM = trpc.notes.moveToOwner.useMutation();
  const createM = trpc.notes.create.useMutation();
  const createFolderM = trpc.notes.createFolder.useMutation();
  const removeM = trpc.notes.remove.useMutation();

  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());

  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);
  const [menu, setMenu] = useState<{
    ref: NodeRef;
    canWrite: boolean;
    isFolder: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  /** Archivos del escritorio sobrevolando el hueco del árbol (= la raíz). */
  const [rootFilesOver, setRootFilesOver] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<NodeRef | null>(null);
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

  const openMenu = useCallback(
    (ref: NodeRef, canWrite: boolean, isFolder: boolean, x: number, y: number) => {
      setMenu({ ref, canWrite, isFolder, x, y });
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const onRootContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // El root del menú de fondo es tu propia bóveda.
      if (mine) openMenu({ ownerId: mine, path: '' }, true, true, e.clientX, e.clientY);
    },
    [openMenu, mine],
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
      if (ownerId === mine) return 'vos';
      const root = sharedRoots.find((r) => r.ownerId === ownerId);
      if (!root) return 'la otra persona';
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
          `moved to ${result.path} — ahora es de ${ownerLabel(dst.ownerId)}` +
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
      title: 'New note',
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
      title: 'New folder',
      label: 'Folder name',
    });
  }, []);

  const renamePath = useCallback((ref: NodeRef) => {
    if (ref.path === '') return;
    const basename = ref.path.split('/').pop() ?? ref.path;
    setPromptRef(ref);
    setPrompt({
      kind: 'rename',
      targetPath: ref.path,
      title: `Rename ${basename}`,
      label: 'New name',
      defaultValue: basename,
    });
  }, []);

  const deletePath = useCallback((ref: NodeRef) => {
    if (ref.path === '') return;
    setConfirmDelete(ref);
  }, []);

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
      } else if (kind === 'rename') {
        const from = targetPath;
        const basename = from.split('/').pop() ?? from;
        if (name === basename) return;
        const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
        const to = parent === '' ? name : `${parent}/${name}`;
        try {
          const result = await moveM.mutateAsync({ from, to, ownerId: owner });
          await refresh();
          pushToast('info', `renamed to ${result.path}`);
        } catch (err) {
          pushToast('error', (err as Error).message);
        }
      }
    },
    [prompt, promptRef, createM, createFolderM, moveM, refresh, pushToast],
  );

  const runDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    markBusy(target, true);
    try {
      await removeM.mutateAsync({
        path: target.path,
        recursive: true,
        ownerId: target.ownerId,
      });
      await refresh();
      pushToast('info', `deleted ${target.path}`);
    } catch (err) {
      pushToast('error', (err as Error).message);
    } finally {
      markBusy(target, false);
    }
  }, [confirmDelete, removeM, refresh, pushToast, markBusy]);

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
    <div className="relative flex h-full flex-col" onContextMenu={onRootContextMenu}>
      <SearchInput onActiveChange={setSearchActive} placeholder="Search notes…" />

      {!searchActive && (
        <>
          <div
            onContextMenu={onRootContextMenu}
            className="flex h-8 items-center justify-between border-y border-border-subtle px-3 font-mono text-[11px] text-fg-muted"
          >
            <span className="flex items-center gap-1.5">
              vault
              {treeQ.isFetching && <Loader2 size={10} className="animate-spin" />}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => mine && createNote({ ownerId: mine, path: '' })}
                title="New note in root"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <FilePlus size={12} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => mine && createFolder({ ownerId: mine, path: '' })}
                title="New folder in root"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <FolderPlus size={12} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => mine && importNotes({ ownerId: mine, path: '' })}
                title="Import .md files into root"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <FileUp size={12} strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {/* La raíz de tu bóveda no dibuja fila propia, así que soltar
                archivos en el hueco del árbol importa a la raíz. Las filas
                paran la propagación, de modo que esto sólo salta en el vacío. */}
            <div
              className={cn(
                'flex-1 overflow-y-auto py-1',
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
              {mine && (
                <NodeRow
                  node={root}
                  ownerId={mine}
                  canWrite
                  depth={-1}
                  expanded={expanded}
                  toggle={toggle}
                  menuFor={menu ? nodeId(menu.ref) : null}
                  openMenu={openMenu}
                  onDeleteClick={deletePath}
                  onPrefetch={prefetchNote}
                  onFilesDrop={(ref, files) => void runImport(ref, files)}
                  busy={busy}
                  sharedWith={sharedWith}
                  mine={mine}
                />
              )}
              {root.children && root.children.length === 0 && sharedRoots.length === 0 && (
                <div className="px-4 py-6 text-center font-mono text-[11px] text-fg-muted">
                  empty vault — use + above or right-click to add a note or folder
                </div>
              )}
              {/* Lo compartido va en la misma lista y con las mismas filas que
                  lo propio: una sección aparte obligaba a aprender dos árboles,
                  y el de abajo no dejaba crear ni arrastrar nada. */}
              {sharedRoots.map((r) => (
                <SharedBranch
                  key={`${r.ownerId}:${r.folderPath}`}
                  root={r}
                  expanded={expanded}
                  toggle={toggle}
                  menuFor={menu ? nodeId(menu.ref) : null}
                  openMenu={openMenu}
                  onDeleteClick={deletePath}
                  onPrefetch={prefetchNote}
                  onFilesDrop={(ref, files) => void runImport(ref, files)}
                  busy={busy}
                  sharedWith={sharedWith}
                  mine={mine}
                />
              ))}
            </div>
          </DndContext>
        </>
      )}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-[61] min-w-[150px] overflow-hidden rounded-md border border-border-default bg-bg-surface text-sm shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            {menu.canWrite && (
              <>
                <MenuItem
                  onClick={() => {
                    // Crear "en" una nota significa crear junto a ella.
                    const target = menu.isFolder
                      ? menu.ref
                      : { ownerId: menu.ref.ownerId, path: parentOf(menu.ref.path) };
                    setMenu(null);
                    createNote(target);
                  }}
                >
                  New note
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    const target = menu.isFolder
                      ? menu.ref
                      : { ownerId: menu.ref.ownerId, path: parentOf(menu.ref.path) };
                    setMenu(null);
                    createFolder(target);
                  }}
                >
                  New folder
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    const target = menu.isFolder
                      ? menu.ref
                      : { ownerId: menu.ref.ownerId, path: parentOf(menu.ref.path) };
                    setMenu(null);
                    importNotes(target);
                  }}
                >
                  Import .md…
                </MenuItem>
              </>
            )}
            {menu.canWrite && menu.ref.path !== '' && (
              <MenuItem
                onClick={() => {
                  const r = menu.ref;
                  setMenu(null);
                  renamePath(r);
                }}
              >
                Rename
              </MenuItem>
            )}
            {/* Re-compartir lo que te compartieron no existe, así que la opción
                sólo aparece sobre carpetas propias. */}
            {sharingEnabled &&
              menu.ref.ownerId === mine &&
              menu.ref.path !== '' &&
              menu.isFolder && (
                <MenuItem
                  onClick={() => {
                    const p = menu.ref.path;
                    setMenu(null);
                    setShareFolderPath(p);
                  }}
                >
                  Share…
                </MenuItem>
              )}
            {menu.canWrite && menu.ref.path !== '' && (
              <MenuItem
                danger
                onClick={() => {
                  const r = menu.ref;
                  setMenu(null);
                  deletePath(r);
                }}
              >
                Delete
              </MenuItem>
            )}
            {!menu.canWrite && (
              <div className="px-3 py-2 font-mono text-[11px] text-fg-muted">sólo lectura</div>
            )}
          </div>
        </>
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
        okLabel={prompt?.kind === 'rename' ? 'Rename' : 'Create'}
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
        title="¿Cambiar de dueño?"
        message={
          confirmCrossVault
            ? `«${confirmCrossVault.src.path.split('/').pop()}» pasa de ` +
              `${ownerLabel(confirmCrossVault.src.ownerId)} a ` +
              `${ownerLabel(confirmCrossVault.dst.ownerId)}.

` +
              'No es una copia: las notas se van de la bóveda de origen. Quien deja de ser ' +
              'dueño sólo la seguirá viendo si el destino está compartido con esa persona, y ' +
              'con el permiso que tenga ahí.'
            : undefined
        }
        okLabel="Mover y cambiar dueño"
        onCancel={() => setConfirmCrossVault(null)}
        onConfirm={() => {
          const pending = confirmCrossVault;
          setConfirmCrossVault(null);
          if (pending) void runCrossVaultMove(pending.src, pending.dst, pending.toPath);
        }}
      />

      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete?"
        message={confirmDelete ? `${confirmDelete} will be removed permanently.` : undefined}
        okLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={runDelete}
      />

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
  expanded,
  toggle,
  menuFor,
  openMenu,
  onDeleteClick,
  onPrefetch,
  onFilesDrop,
  busy,
  sharedWith,
  mine,
}: {
  root: {
    ownerId: string;
    folderPath: string;
    ownerDisplayName: string | null;
    ownerEmail: string;
    permission: 'read' | 'write';
  };
  expanded: Set<string>;
  toggle(id: string): void;
  menuFor: string | null;
  openMenu(ref: NodeRef, canWrite: boolean, isFolder: boolean, x: number, y: number): void;
  onDeleteClick(ref: NodeRef): void;
  onPrefetch(ref: NodeRef): void;
  onFilesDrop(ref: NodeRef, files: FileList): void;
  busy: Set<string>;
  sharedWith: Map<string, string[]>;
  mine: string | undefined;
}) {
  const q = trpc.notes.treeForOwner.useQuery(
    { ownerId: root.ownerId, path: root.folderPath, depth: MAX_TREE_DEPTH },
    { enabled: !!root.ownerId },
  );

  const owner = root.ownerDisplayName ?? root.ownerEmail.split('@')[0];

  if (q.error) {
    return (
      <div className="px-4 py-1 font-mono text-[11px] text-red-300" title={q.error.message}>
        {root.folderPath} — sin acceso
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 font-mono text-[11px] text-fg-muted">
        <Loader2 size={10} className="animate-spin" />
        {root.folderPath}
      </div>
    );
  }

  return (
    <div className="relative">
      <span
        title={`Compartida por ${root.ownerEmail} — ${
          root.permission === 'write' ? 'lectura y escritura' : 'sólo lectura'
        }`}
        className="pointer-events-none absolute right-1 top-1 z-10 rounded border border-border-subtle bg-bg-surface px-1 font-mono text-[9px] text-fg-muted"
      >
        @{owner}
      </span>
      <NodeRow
        node={q.data}
        ownerId={root.ownerId}
        canWrite={root.permission === 'write'}
        depth={0}
        expanded={expanded}
        toggle={toggle}
        menuFor={menuFor}
        openMenu={openMenu}
        onDeleteClick={onDeleteClick}
        onPrefetch={onPrefetch}
        onFilesDrop={onFilesDrop}
        busy={busy}
        sharedWith={sharedWith}
        mine={mine}
      />
    </div>
  );
}
