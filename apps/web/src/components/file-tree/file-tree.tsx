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
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Trash2,
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
import { SearchInput } from '@/components/search/search-input';
import { ConfirmModal, PromptModal } from '@/components/ui/prompt-modal';
import { SharedWithMeSection } from './shared-with-me';
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

const ROOT_DROP_ID = '__root__';
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
  const safeName = file.name.replace(/[/\\]+/g, '_');
  return `Attachments/${yyyy}/${mm}/${safeName}`;
}

function baseNameFromFile(file: File): string {
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const cleaned = stem.replace(/[/\\]+/g, '_').trim();
  return cleaned || 'Untitled';
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
  onDeleteClick(path: string): void;
  onPrefetch(path: string): void;
  busy: Set<string>;
}

function NodeRow({
  node,
  depth,
  expanded,
  toggle,
  menuFor,
  openMenu,
  onDeleteClick,
  onPrefetch,
  busy,
}: NodeRowProps) {
  const router = useRouter();
  const isFolder = node.type === 'folder';
  const isExpanded = isFolder ? expanded.has(node.path) || node.path === '' : false;

  const draggable = useDraggable({
    id: node.path === '' ? ROOT_DROP_ID : node.path,
    disabled: node.path === '',
  });
  const droppable = useDroppable({
    id: node.path === '' ? ROOT_DROP_ID : node.path,
    disabled: !isFolder,
  });

  const Icon = isFolder ? Folder : node.type === 'note' ? FileText : ImageIcon;

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(node.path, e.clientX, e.clientY);
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
          onMouseEnter={() => {
            if (node.type === 'note') onPrefetch(node.path);
          }}
          onContextMenu={onContext}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            'group flex h-7 cursor-default select-none items-center gap-1.5 rounded pr-1 text-sm transition-colors',
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
          <span className="flex-1 truncate font-mono text-[12px] text-fg-secondary">
            {node.name}
          </span>
          {busy.has(node.path) ? (
            <Loader2 size={11} className="animate-spin text-fg-muted" />
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteClick(node.path);
              }}
              title="Delete"
              className="flex h-5 w-5 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-bg-surface hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 size={11} strokeWidth={1.75} />
            </button>
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
              onDeleteClick={onDeleteClick}
              onPrefetch={onPrefetch}
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

  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());

  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [shareFolderPath, setShareFolderPath] = useState<string | null>(null);
  const sharingEnabled = useSharingEnabled();
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

  // Warm the cache so clicking a note shows content immediately.
  const prefetchedRef = useRef<Set<string>>(new Set());
  const prefetchNote = useCallback(
    (path: string) => {
      if (prefetchedRef.current.has(path)) return;
      prefetchedRef.current.add(path);
      void utils.notes.get.prefetch({ path });
    },
    [utils],
  );

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
      openMenu('', e.clientX, e.clientY);
    },
    [openMenu],
  );

  // ---------------------------------------------------------------------------
  // DnD: move on drop
  // ---------------------------------------------------------------------------

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const from = String(e.active.id);
      const overId = e.over?.id != null ? String(e.over.id) : null;
      if (!overId) return;
      const destFolder = overId === ROOT_DROP_ID ? '' : overId;

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

  /**
   * Upload de archivos arbitrarios a Attachments/YYYY/MM/. No inserta
   * wikilinks en ninguna nota — solo persiste el archivo y refresca el
   * árbol. Compartido entre el drop nativo en el sidebar y el botón
   * Paperclip del header.
   */
  const uploadFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
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
    },
    [markBusy, pushToast, refresh, uploadM],
  );

  const onNativeDrop = async (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    await uploadFiles(Array.from(e.dataTransfer.files));
  };

  const headerUploadInputRef = useRef<HTMLInputElement | null>(null);
  const onHeaderUploadClick = useCallback((): void => {
    headerUploadInputRef.current?.click();
  }, []);
  const onHeaderUploadChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      await uploadFiles(files);
    },
    [uploadFiles],
  );

  /**
   * Upload de archivos dirigidos a una carpeta. El archivo físico sigue
   * yendo a Attachments/YYYY/MM/... — lo que cambia es que además se crea
   * una nota nueva dentro del folder elegido con el embed ![[...]] del
   * adjunto. Si el nombre choca con una nota existente, se aplica sufijo
   * incremental (' 2', ' 3'…). 99 intentos máx antes de tirar error.
   */
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadTargetRef = useRef<string | null>(null);

  const createNoteWithEmbed = useCallback(
    async (folderPath: string, baseName: string, attachmentPath: string): Promise<string> => {
      for (let i = 1; i <= 99; i++) {
        const candidateName = i === 1 ? baseName : `${baseName} ${i}`;
        const notePath =
          folderPath === '' ? `${candidateName}.md` : `${folderPath}/${candidateName}.md`;
        try {
          const result = await createM.mutateAsync({
            path: notePath,
            content: `![[${attachmentPath}]]\n`,
          });
          return result.path;
        } catch (err) {
          const code = (err as { data?: { code?: string } })?.data?.code;
          const msg = (err as Error).message ?? '';
          if (code === 'CONFLICT' || /already exists/i.test(msg)) continue;
          throw err;
        }
      }
      throw new Error(`no se pudo asignar un nombre único para ${baseName}`);
    },
    [createM],
  );

  const onFolderUploadClick = useCallback((folder: string): void => {
    folderUploadTargetRef.current = folder;
    folderUploadInputRef.current?.click();
  }, []);

  const onFolderUploadChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const folder = folderUploadTargetRef.current ?? '';
      folderUploadTargetRef.current = null;
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (files.length === 0) return;
      for (const file of files) {
        const dest = attachmentDestForFile(file);
        markBusy(dest, true);
        try {
          const dataBase64 = await readAsBase64(file);
          const attachmentPath = await uploadM.mutateAsync({
            path: dest,
            dataBase64,
            mime: file.type || undefined,
          });
          const baseName = baseNameFromFile(file);
          const notePath = await createNoteWithEmbed(folder, baseName, attachmentPath);
          pushToast('info', `uploaded ${attachmentPath} + ${notePath}`);
        } catch (err) {
          pushToast('error', `${file.name}: ${(err as Error).message}`);
        } finally {
          markBusy(dest, false);
        }
      }
      await refresh();
    },
    [createNoteWithEmbed, markBusy, pushToast, refresh, uploadM],
  );

  // ---------------------------------------------------------------------------
  // Actions (reusable from menu, header buttons, hover row actions)
  // ---------------------------------------------------------------------------

  const folderForPath = useCallback((path: string, tree: TreeNode | undefined): string => {
    if (!tree || path === '') return '';
    const node = findNode(tree, path);
    if (!node) return '';
    if (node.type === 'folder') return node.path;
    const lastSlash = node.path.lastIndexOf('/');
    return lastSlash === -1 ? '' : node.path.slice(0, lastSlash);
  }, []);

  const createNote = useCallback(
    (targetPath: string) => {
      setPrompt({
        kind: 'createNote',
        targetPath,
        title: 'New note',
        label: 'Name (without .md)',
      });
    },
    [],
  );

  const createFolder = useCallback(
    (targetPath: string) => {
      setPrompt({
        kind: 'createFolder',
        targetPath,
        title: 'New folder',
        label: 'Folder name',
      });
    },
    [],
  );

  const renamePath = useCallback((from: string) => {
    if (from === '') return;
    const basename = from.split('/').pop() ?? from;
    setPrompt({
      kind: 'rename',
      targetPath: from,
      title: `Rename ${basename}`,
      label: 'New name',
      defaultValue: basename,
    });
  }, []);

  const deletePath = useCallback((target: string) => {
    if (target === '') return;
    setConfirmDelete(target);
  }, []);

  const runPrompt = useCallback(
    async (value: string) => {
      if (!prompt) return;
      const { kind, targetPath } = prompt;
      setPrompt(null);
      const name = value.trim();
      if (!name) return;

      if (kind === 'createNote') {
        const folder = folderForPath(targetPath, treeQ.data);
        const path = folder === '' ? `${name}.md` : `${folder}/${name}.md`;
        try {
          const result = await createM.mutateAsync({
            path,
            content: `# ${name}\n`,
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
      } else if (kind === 'createFolder') {
        const folder = folderForPath(targetPath, treeQ.data);
        const path = folder === '' ? name : `${folder}/${name}`;
        try {
          await createFolderM.mutateAsync({ path });
          setExpanded((prev) => new Set(prev).add(path));
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
          const result = await moveM.mutateAsync({ from, to });
          await refresh();
          pushToast('info', `renamed to ${result.path}`);
        } catch (err) {
          pushToast('error', (err as Error).message);
        }
      }
    },
    [prompt, folderForPath, treeQ.data, createM, createFolderM, moveM, refresh, pushToast],
  );

  const runDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    markBusy(target, true);
    try {
      const result = await removeM.mutateAsync({ path: target, recursive: true });
      await refresh();
      pushToast('info', `deleted ${result.deleted.length} item(s)`);
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
    <div
      className="relative flex h-full flex-col"
      onDragOver={onNativeDragOver}
      onDrop={onNativeDrop}
      onContextMenu={onRootContextMenu}
    >
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
                onClick={() => createNote('')}
                title="New note in root"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <FilePlus size={12} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => createFolder('')}
                title="New folder in root"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <FolderPlus size={12} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={onHeaderUploadClick}
                title="Upload attachment(s) to Attachments/"
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
              >
                <Paperclip size={12} strokeWidth={1.75} />
              </button>
              <input
                ref={headerUploadInputRef}
                type="file"
                multiple
                hidden
                onChange={onHeaderUploadChange}
              />
              <input
                ref={folderUploadInputRef}
                type="file"
                multiple
                hidden
                onChange={onFolderUploadChange}
              />
            </div>
          </div>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="flex-1 overflow-y-auto py-1" onContextMenu={onRootContextMenu}>
              <NodeRow
                node={root}
                depth={-1}
                expanded={expanded}
                toggle={toggle}
                menuFor={menu?.path ?? null}
                openMenu={openMenu}
                onDeleteClick={deletePath}
                onPrefetch={prefetchNote}
                busy={busy}
              />
              {root.children && root.children.length === 0 && (
                <div className="px-4 py-6 text-center font-mono text-[11px] text-fg-muted">
                  empty vault — use + above or right-click to add a note or folder
                </div>
              )}
            </div>
          </DndContext>
          <SharedWithMeSection />
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
          <MenuItem
            onClick={() => {
              const p = menu.path;
              setMenu(null);
              createNote(p);
            }}
          >
            New note
          </MenuItem>
          <MenuItem
            onClick={() => {
              const p = menu.path;
              setMenu(null);
              createFolder(p);
            }}
          >
            New folder
          </MenuItem>
          {!/\.[a-z0-9]+$/i.test(menu.path) && (
            <MenuItem
              onClick={() => {
                const p = folderForPath(menu.path, treeQ.data);
                setMenu(null);
                onFolderUploadClick(p);
              }}
            >
              Upload…
            </MenuItem>
          )}
          {menu.path !== '' && (
            <MenuItem
              onClick={() => {
                const p = menu.path;
                setMenu(null);
                renamePath(p);
              }}
            >
              Rename
            </MenuItem>
          )}
          {sharingEnabled && menu.path !== '' && !/\.[a-z0-9]+$/i.test(menu.path) && (
            <MenuItem
              onClick={() => {
                const p = menu.path;
                setMenu(null);
                setShareFolderPath(p);
              }}
            >
              Share…
            </MenuItem>
          )}
          {menu.path !== '' && (
            <MenuItem
              danger
              onClick={() => {
                const p = menu.path;
                setMenu(null);
                deletePath(p);
              }}
            >
              Delete
            </MenuItem>
          )}
          </div>
        </>
      )}

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

function findNode(tree: TreeNode, path: string): TreeNode | null {
  if (tree.path === path) return tree;
  if (!tree.children) return null;
  for (const child of tree.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}
