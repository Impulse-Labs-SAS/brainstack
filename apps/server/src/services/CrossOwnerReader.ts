// Reader read-only de notas/carpetas que pertenecen a OTRO user.
// Sólo aplica en hosted; en self-host no hay multi-tenant y todo método
// tira NOT_FOUND. Bypasa la sqlite (que no separa por owner_id de manera
// confiable en V1) y va directo al disco vía resolveVaultRoot(ownerId).
//
// Cada método consulta SharingService.assertCanRead antes de leer.

import {
  NoteNotFoundError,
  PathTraversalError,
  listFolders,
  listNoteFiles,
  parseNote,
  readAttachment,
  readNote,
  type Frontmatter,
} from '@brainstack/core';

import { AppError } from '../lib/errors.js';
import { resolveVaultRoot, type VaultRootResolverConfig } from '../lib/vault.js';

import type { SharingService } from './SharingService.js';
import type { AttachmentPayload, NoteRowDto, TreeNode } from './NoteService.js';

export interface CrossOwnerReaderOptions {
  sharing: SharingService;
  vaultCfg: VaultRootResolverConfig;
}

const DEFAULT_TREE_DEPTH = 4;

export class CrossOwnerReader {
  constructor(private readonly opts: CrossOwnerReaderOptions) {}

  /** True si el deployment soporta esto. En self-host es false. */
  get enabled(): boolean {
    return this.opts.vaultCfg.deployment === 'hosted';
  }

  async getNote(viewerId: string, ownerId: string, path: string): Promise<NoteRowDto> {
    this.requireEnabled();
    this.opts.sharing.assertCanRead(viewerId, ownerId, path);
    const root = resolveVaultRoot(ownerId, this.opts.vaultCfg);
    try {
      const file = await readNote(root, path);
      const parsed = parseNote(file.content, { path: file.path });
      return {
        path: parsed.path,
        title: parsed.title,
        frontmatter: parsed.frontmatter as Frontmatter,
        body: parsed.body,
        mtime: file.mtime,
        checksum: parsed.checksum,
      };
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
      }
      if (err instanceof PathTraversalError) {
        throw new AppError(err.message, 'INVALID_INPUT', 400);
      }
      throw err;
    }
  }

  async getAttachment(
    viewerId: string,
    ownerId: string,
    path: string,
  ): Promise<AttachmentPayload> {
    this.requireEnabled();
    this.opts.sharing.assertCanRead(viewerId, ownerId, path);
    const root = resolveVaultRoot(ownerId, this.opts.vaultCfg);
    try {
      const result = await readAttachment(root, path);
      return {
        path: result.path,
        sizeBytes: result.sizeBytes,
        mtime: result.mtime,
        dataBase64: result.bytes.toString('base64'),
      };
    } catch (err) {
      if (err instanceof PathTraversalError) {
        throw new AppError(err.message, 'INVALID_INPUT', 400);
      }
      if (err instanceof Error && err.message.startsWith('attachment not found')) {
        throw new AppError(`attachment not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw err;
    }
  }

  /**
   * Tree de la carpeta `scopePath` dentro del vault de `ownerId`. El path
   * scope DEBE caer dentro de algún grant activo — si no, FORBIDDEN. Esto
   * impide listar el root del vault ajeno.
   */
  async listTree(
    viewerId: string,
    ownerId: string,
    scopePath: string,
    depth?: number,
  ): Promise<TreeNode> {
    this.requireEnabled();
    if (!scopePath || scopePath.trim() === '') {
      throw new AppError('scopePath requerido', 'INVALID_INPUT', 400);
    }
    this.opts.sharing.assertCanRead(viewerId, ownerId, scopePath);
    const maxDepth = depth ?? DEFAULT_TREE_DEPTH;
    const root = resolveVaultRoot(ownerId, this.opts.vaultCfg);

    const [notePaths, allFolders] = await Promise.all([
      listNoteFiles(root),
      listFolders(root),
    ]);

    const scope = scopePath.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    const scopePrefix = scope + '/';

    const rootNode: TreeNode = {
      path: scope,
      name: scope.split('/').pop() ?? scope,
      type: 'folder',
      children: [],
    };
    const folderIndex = new Map<string, TreeNode>();
    folderIndex.set(scope, rootNode);

    for (const folderPath of allFolders) {
      const inScope = folderPath === scope || folderPath.startsWith(scopePrefix);
      if (!inScope) continue;
      const rel = folderPath === scope ? '' : folderPath.slice(scope.length + 1);
      if (rel === '') continue;
      const segments = rel.split('/');
      if (segments.length > maxDepth) continue;
      let parentPath = scope;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i] ?? '';
        const fp = `${parentPath}/${segment}`;
        if (!folderIndex.has(fp)) {
          const node: TreeNode = {
            path: fp,
            name: segment,
            type: 'folder',
            children: [],
          };
          folderIndex.set(fp, node);
          folderIndex.get(parentPath)?.children?.push(node);
        }
        parentPath = fp;
      }
    }

    for (const notePath of notePaths) {
      if (!notePath.startsWith(scopePrefix) && notePath !== scope) continue;
      const rel = notePath.slice(scope.length + 1);
      if (rel === '') continue;
      const segments = rel.split('/');
      if (segments.length > maxDepth) continue;
      let parentPath = scope;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i] ?? '';
        const fp = `${parentPath}/${segment}`;
        let folderNode = folderIndex.get(fp);
        if (!folderNode) {
          folderNode = { path: fp, name: segment, type: 'folder', children: [] };
          folderIndex.set(fp, folderNode);
          folderIndex.get(parentPath)?.children?.push(folderNode);
        }
        parentPath = fp;
      }
      const leaf: TreeNode = {
        path: notePath,
        name: segments[segments.length - 1] ?? notePath,
        type: 'note',
      };
      folderIndex.get(parentPath)?.children?.push(leaf);
    }

    sortTree(rootNode);
    return rootNode;
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new AppError('cross-owner reads no disponibles en self-host', 'NOT_FOUND', 404);
    }
  }
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}
