// CRUD over notes, folders and attachments. Each write goes through
// @brainstack/core (atomic filesystem) and then triggers an immediate reindex
// so the sqlite cache stays in sync without waiting for the chokidar event
// (the watcher will dedupe the event by checksum).
//
// Owner-aware: en hosted, cada método recibe el userId del caller. Internamente
// traduce paths lógicos (lo que ve el frontend / MCP, sin prefix) a paths
// físicos (lo que vive en DB/FS: `<userId>/...`) via toPhysical/toLogical.
// En self-host esos helpers son identity, los filtros owner_id quedan
// desactivados y el comportamiento es el de single-tenant previo.

import { promises as fsp, type Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  BLOCKED_UPLOAD_MESSAGE,
  FolderNotEmptyError,
  NoteAlreadyExistsError,
  NoteNotFoundError,
  PathTraversalError,
  createFolder,
  deletePath,
  isBlockedUpload,
  listFolders,
  movePath,
  readBinaryFile,
  readNote,
  relativeToRoot,
  rewriteLinkTargets,
  safeResolve,
  toPosixPath,
  writeBinaryFile,
  writeNote,
  type BrainStackDatabase,
  type Frontmatter,
  type LinkRewriteMapping,
} from '@brainstack/core';
import matter from 'gray-matter';

import { AppError } from '../lib/errors.js';
import {
  resolveVaultRoot,
  toLogical,
  toPhysical,
  type VaultRootResolverConfig,
} from '../lib/vault.js';

import type { IndexService } from './IndexService.js';

export interface NoteRowDto {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  mtime: number;
  checksum: string;
}

/**
 * Response shape for create/move. `affectedMocs` lists existing `_<Folder>.md`
 * MOC notes that are likely to need a follow-up update by the caller (the
 * agent or the human). The server doesn't touch MOCs — that's by design, since
 * they're a convention with per-vault style, not a forced structure — but it
 * surfaces the candidates so the caller doesn't have to recompute paths or
 * stat them. Empty array means there's nothing to update.
 */
export interface MutationResult {
  path: string;
  affectedMocs: string[];
}

export interface ListFilter {
  folder?: string;
  tag?: string;
  status?: string;
  limit?: number;
}

export interface TreeNode {
  /** Posix path relative to root. */
  path: string;
  /** Basename. */
  name: string;
  type: 'folder' | 'note' | 'attachment';
  /** Sorted children: folders first, then files, both alphabetical. */
  children?: TreeNode[];
}

export interface UploadAttachmentInput {
  /** Posix path under `Attachments/`. */
  path: string;
  /** Base64-encoded file bytes. */
  dataBase64: string;
  /** Optional informational mime type. */
  mime?: string;
}

export interface AttachmentPayload {
  path: string;
  sizeBytes: number;
  mtime: number;
  /** Base64-encoded bytes. */
  dataBase64: string;
}

export interface NoteServiceOptions {
  cfg: VaultRootResolverConfig;
  db: BrainStackDatabase;
  index: IndexService;
}

const DEFAULT_TREE_DEPTH = 4;

/**
 * Hard ceiling on tree depth that callers can request. Lives here so the
 * tRPC + MCP zod schemas, the web client, and the service all share the
 * same number — bumping the cap is a single-file change.
 */
export const MAX_TREE_DEPTH = 20;

export class NoteService {
  constructor(private readonly opts: NoteServiceOptions) {}

  // ---------------------------------------------------------------------------
  // Helpers de owner-awareness
  // ---------------------------------------------------------------------------

  /** Path físico (lo que vive en DB/FS). En self-host es identity. */
  private toPhysical(userId: string, logical: string): string {
    return toPhysical(userId, logical, this.opts.cfg);
  }

  /** Path lógico que devolvemos al caller. En self-host es identity. */
  private toLogical(userId: string, physical: string): string {
    return toLogical(userId, physical, this.opts.cfg);
  }

  /** Root absoluto para FS scans del user (hosted: per-user subdir). */
  private rootFor(userId: string): string {
    return resolveVaultRoot(userId, this.opts.cfg);
  }

  /** Filtro WHERE owner_id; en self-host no filtra. */
  private ownerWhere(userId: string): { sql: string; params: unknown[] } {
    if (this.opts.cfg.deployment === 'self-host') return { sql: '', params: [] };
    return { sql: ' AND owner_id = ?', params: [userId] };
  }

  private get hosted(): boolean {
    return this.opts.cfg.deployment === 'hosted';
  }

  // ---------------------------------------------------------------------------
  // Notes — CRUD
  // ---------------------------------------------------------------------------

  async get(userId: string, path: string): Promise<NoteRowDto> {
    const physicalPath = this.toPhysical(userId, path);
    const { sql, params } = this.ownerWhere(userId);
    const row = this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; frontmatter: string; body: string; mtime: number; checksum: string }>(
        `SELECT path, title, frontmatter, body, mtime, checksum FROM notes WHERE path = ?${sql}`,
      )
      .get(physicalPath, ...params);
    if (!row) {
      try {
        const root = this.rootFor(userId);
        const file = await readNote(root, path);
        // file.path es el path lógico resuelto por readNote, ya con `.md`
        // ensured. Lo traducimos a físico para reindexar y reconsultar por
        // path exacto, evitando loop si el caller omitió el sufijo.
        const resolvedPhysical = this.toPhysical(userId, file.path);
        await this.opts.index.reindex(resolvedPhysical);
        const retried = this.opts.db.sqlite
          .prepare<unknown[], { path: string; title: string; frontmatter: string; body: string; mtime: number; checksum: string }>(
            `SELECT path, title, frontmatter, body, mtime, checksum FROM notes WHERE path = ?${sql}`,
          )
          .get(resolvedPhysical, ...params);
        if (!retried) {
          throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
        }
        return {
          path: this.toLogical(userId, retried.path),
          title: retried.title,
          frontmatter: JSON.parse(retried.frontmatter) as Frontmatter,
          body: retried.body,
          mtime: retried.mtime,
          checksum: retried.checksum,
        };
      } catch (err) {
        if (err instanceof NoteNotFoundError) {
          throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
        }
        throw err;
      }
    }
    return {
      path: this.toLogical(userId, row.path),
      title: row.title,
      frontmatter: JSON.parse(row.frontmatter) as Frontmatter,
      body: row.body,
      mtime: row.mtime,
      checksum: row.checksum,
    };
  }

  async create(
    userId: string,
    path: string,
    content: string,
    frontmatter?: Frontmatter,
  ): Promise<MutationResult> {
    const physicalPath = this.toPhysical(userId, path);
    const merged = frontmatter ? buildContent(content, frontmatter) : content;
    try {
      const finalPhysical = await writeNote(
        this.opts.cfg.notesDirAbs,
        physicalPath,
        merged,
        { failIfExists: true },
      );
      await this.opts.index.reindex(finalPhysical);
      const affectedMocs = await this.candidateMocs(userId, [parentOf(finalPhysical)]);
      return {
        path: this.toLogical(userId, finalPhysical),
        affectedMocs: affectedMocs.map((p) => this.toLogical(userId, p)),
      };
    } catch (err) {
      if (err instanceof NoteAlreadyExistsError) {
        throw new AppError(`note already exists: ${path}`, 'ALREADY_EXISTS', 409);
      }
      throw mapPathError(err);
    }
  }

  async update(userId: string, path: string, content: string): Promise<string> {
    const physicalPath = this.toPhysical(userId, path);
    try {
      await readNote(this.opts.cfg.notesDirAbs, physicalPath);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw mapPathError(err);
    }
    const finalPhysical = await writeNote(this.opts.cfg.notesDirAbs, physicalPath, content);
    await this.opts.index.reindex(finalPhysical);
    return this.toLogical(userId, finalPhysical);
  }

  // ---------------------------------------------------------------------------
  // Filesystem operations on notes / folders / attachments
  // ---------------------------------------------------------------------------

  /**
   * Delete a note, attachment, or folder. Folders require `recursive: true`
   * unless they are empty.
   */
  async remove(
    userId: string,
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<{ deleted: string[] }> {
    const norm = this.normalize(userId, path);

    const kind = await this.classify(norm);
    if (kind === 'missing') {
      throw new AppError(`path not found: ${path}`, 'NOT_FOUND', 404);
    }
    const targets: string[] =
      kind === 'folder' ? (await this.walkFolder(norm)).map((c) => c.path) : [norm];

    try {
      await deletePath(this.opts.cfg.notesDirAbs, norm, { recursive: options.recursive });
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`path not found: ${path}`, 'NOT_FOUND', 404);
      }
      if (err instanceof FolderNotEmptyError) {
        throw new AppError(
          `folder not empty: ${path} (pass recursive=true to delete contents)`,
          'INVALID_INPUT',
          400,
        );
      }
      throw mapPathError(err);
    }

    for (const target of targets) {
      if (target.toLowerCase().endsWith('.md')) {
        this.opts.index.remove(target);
      }
    }

    return { deleted: targets.map((p) => this.toLogical(userId, p)).sort() };
  }

  /**
   * Move/rename. Wikilinks targeting the moved path(s) get rewritten across the
   * user's own vault. Cross-owner moves no están soportados (V1 read-only).
   */
  async move(userId: string, fromPath: string, toPath: string): Promise<MutationResult> {
    const fromNorm = this.normalize(userId, fromPath);
    const toNorm = this.normalize(userId, toPath);

    const movedTopLevelKind = await this.classify(fromNorm);
    const movingChildren: ChildEntry[] =
      movedTopLevelKind === 'folder' ? await this.walkFolder(fromNorm) : [];

    let finalPhysical: string;
    try {
      finalPhysical = await movePath(this.opts.cfg.notesDirAbs, fromNorm, toNorm);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`path not found: ${fromPath}`, 'NOT_FOUND', 404);
      }
      if (err instanceof NoteAlreadyExistsError) {
        throw new AppError(`destination already exists: ${toPath}`, 'ALREADY_EXISTS', 409);
      }
      throw mapPathError(err);
    }

    const mappings: LinkRewriteMapping[] = [];
    const movedNotePaths: string[] = [];
    const newNotePaths: string[] = [];

    if (movedTopLevelKind === 'file') {
      mappings.push({ from: fromNorm, to: finalPhysical });
      if (fromNorm.toLowerCase().endsWith('.md')) {
        movedNotePaths.push(fromNorm);
        newNotePaths.push(finalPhysical);
      }
    } else if (movedTopLevelKind === 'folder') {
      for (const child of movingChildren) {
        const rel = child.path.slice(fromNorm.length + 1);
        const newPath = `${finalPhysical}/${rel}`;
        mappings.push({ from: child.path, to: newPath });
        if (child.type === 'note') {
          movedNotePaths.push(child.path);
          newNotePaths.push(newPath);
        }
      }
    }

    // El rewriter walks el FS — en hosted, restringimos al vault del user
    // pasando su root específico. Self-host usa el global.
    const rewriteRoot = this.hosted ? this.rootFor(userId) : this.opts.cfg.notesDirAbs;
    // Las mappings están en physical paths; convertir a logical para el rewriter
    // si estamos en hosted (sus paths son relativos al root que recibe).
    const rewriteMappings = this.hosted
      ? mappings.map((m) => ({
          from: this.toLogical(userId, m.from),
          to: this.toLogical(userId, m.to),
        }))
      : mappings;
    const { filesChanged } = await rewriteLinkTargets(rewriteRoot, rewriteMappings);

    for (const oldPath of movedNotePaths) this.opts.index.remove(oldPath);
    for (const newPath of newNotePaths) await this.opts.index.reindex(newPath);
    // filesChanged está en paths relativos al rewriteRoot; reindex necesita
    // physical (con prefix). En self-host coinciden; en hosted re-prefijar.
    for (const changed of filesChanged) {
      const physical = this.hosted ? this.toPhysical(userId, changed) : changed;
      await this.opts.index.reindex(physical);
    }

    const affectedMocs = await this.candidateMocs(userId, [
      parentOf(fromNorm),
      parentOf(finalPhysical),
    ]);
    return {
      path: this.toLogical(userId, finalPhysical),
      affectedMocs: affectedMocs.map((p) => this.toLogical(userId, p)),
    };
  }

  async createFolder(userId: string, path: string): Promise<string> {
    const norm = this.normalize(userId, path);
    try {
      const finalPhysical = await createFolder(this.opts.cfg.notesDirAbs, norm);
      return this.toLogical(userId, finalPhysical);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  async uploadAttachment(userId: string, input: UploadAttachmentInput): Promise<string> {
    if (isBlockedUpload({ mime: input.mime, filename: input.path })) {
      throw new AppError(BLOCKED_UPLOAD_MESSAGE, 'INVALID_INPUT', 400);
    }
    const norm = this.normalize(userId, input.path);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.dataBase64, 'base64');
    } catch {
      throw new AppError('invalid base64 payload', 'INVALID_INPUT', 400);
    }
    if (bytes.length === 0) {
      throw new AppError('empty attachment payload', 'INVALID_INPUT', 400);
    }
    try {
      const finalPhysical = await writeBinaryFile(this.opts.cfg.notesDirAbs, norm, bytes);
      return this.toLogical(userId, finalPhysical);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  async getAttachment(userId: string, path: string): Promise<AttachmentPayload> {
    const norm = this.normalize(userId, path);
    try {
      const result = await readBinaryFile(this.opts.cfg.notesDirAbs, norm);
      return {
        path: this.toLogical(userId, result.path),
        sizeBytes: result.sizeBytes,
        mtime: result.mtime,
        dataBase64: result.bytes.toString('base64'),
      };
    } catch (err) {
      if (err instanceof PathTraversalError) throw mapPathError(err);
      if (err instanceof Error && err.message.startsWith('file not found')) {
        throw new AppError(`attachment not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    userId: string,
    filter: ListFilter = {},
  ): Array<{ path: string; title: string; mtime: number }> {
    const limit = filter.limit ?? 200;
    const parts: string[] = ['SELECT n.path, n.title, n.mtime FROM notes n'];
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.tag) {
      parts.push('JOIN tags t ON t.note_path = n.path');
      where.push('t.tag = ?');
      params.push(filter.tag);
    }
    if (filter.folder) {
      where.push('n.path LIKE ?');
      const folderPhysical = this.toPhysical(userId, filter.folder.replace(/\/+$/, ''));
      params.push(`${folderPhysical}/%`);
    }
    if (filter.status) {
      where.push("json_extract(n.frontmatter, '$.status') = ?");
      params.push(filter.status);
    }
    if (this.hosted) {
      where.push('n.owner_id = ?');
      params.push(userId);
    }

    if (where.length > 0) parts.push('WHERE ' + where.join(' AND '));
    parts.push('ORDER BY n.mtime DESC LIMIT ?');
    params.push(limit);

    const rows = this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; mtime: number }>(parts.join(' '))
      .all(...params);
    return rows.map((r) => ({
      path: this.toLogical(userId, r.path),
      title: r.title,
      mtime: r.mtime,
    }));
  }

  listLinks(
    userId: string,
    path: string,
  ): Array<{
    sourcePath: string;
    targetPath: string;
    targetType: string;
    linkKind: string;
    alias: string | null;
    section: string | null;
  }> {
    const physicalPath = this.toPhysical(userId, path);
    // En hosted: solo backlinks desde notas del propio user (links cross-owner
    // se exponen por separado vía notes.linksForOwner).
    const ownerJoin = this.hosted
      ? 'JOIN notes n ON n.path = l.source_path WHERE l.target_path = ? AND n.owner_id = ?'
      : 'WHERE l.target_path = ?';
    const params: unknown[] = this.hosted ? [physicalPath, userId] : [physicalPath];

    return this.opts.db.sqlite
      .prepare<
        unknown[],
        {
          source_path: string;
          target_path: string;
          target_type: string;
          link_kind: string;
          alias: string | null;
          section: string | null;
        }
      >(
        `SELECT l.source_path, l.target_path, l.target_type, l.link_kind, l.alias, l.section
         FROM links l
         ${ownerJoin}
         ORDER BY l.source_path, l.position`,
      )
      .all(...params)
      .map((row) => ({
        sourcePath: this.toLogical(userId, row.source_path),
        targetPath: this.toLogical(userId, row.target_path),
        targetType: row.target_type,
        linkKind: row.link_kind,
        alias: row.alias,
        section: row.section,
      }));
  }

  /**
   * Graph del vault. Por defecto solo el propio del user. Pasando
   * `sharedScopes` se incluyen nodos+edges de carpetas compartidas al user.
   */
  graph(
    userId: string,
    opts: { sharedScopes?: Array<{ ownerId: string; folderPath: string }> } = {},
  ): {
    nodes: Array<{ path: string; title: string; ownerId: string | null }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  } {
    const sharedScopes = opts.sharedScopes ?? [];

    const blocks: string[] = [];
    const params: unknown[] = [];
    if (this.hosted) {
      blocks.push('owner_id = ?');
      params.push(userId);
      for (const s of sharedScopes) {
        blocks.push('(owner_id = ? AND path LIKE ?)');
        params.push(s.ownerId, `${s.ownerId}/${s.folderPath}/%`);
      }
    }
    const where = this.hosted ? `WHERE ${blocks.join(' OR ')}` : '';
    const nodesRaw = this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; owner_id: string | null }>(
        `SELECT path, title, owner_id FROM notes ${where}`,
      )
      .all(...params);
    const nodeSet = new Set(nodesRaw.map((n) => n.path));
    const ownerByPath = new Map(nodesRaw.map((n) => [n.path, n.owner_id]));

    const raw = this.opts.db.sqlite
      .prepare<unknown[], { source_path: string; target_path: string }>(
        `SELECT source_path, target_path FROM links
         WHERE target_type = 'note' AND source_path <> target_path`,
      )
      .all();

    const counts = new Map<string, number>();
    for (const link of raw) {
      if (!nodeSet.has(link.source_path) || !nodeSet.has(link.target_path)) continue;
      const key = `${link.source_path} ${link.target_path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const edgeKey = (physical: string): string => {
      const owner = ownerByPath.get(physical) ?? userId;
      return this.hosted ? toLogical(owner, physical, this.opts.cfg) : physical;
    };
    const edges = Array.from(counts.entries()).map(([key, weight]) => {
      const [source, target] = key.split(' ');
      return {
        source: edgeKey(source ?? ''),
        target: edgeKey(target ?? ''),
        weight,
      };
    });
    return {
      nodes: nodesRaw.map((n) => ({
        path: this.hosted
          ? toLogical(n.owner_id ?? userId, n.path, this.opts.cfg)
          : n.path,
        title: n.title,
        ownerId: n.owner_id,
      })),
      edges,
    };
  }

  /**
   * Tree del vault del user. Scope `path` opcional (lógico).
   */
  async listTree(userId: string, path?: string, depth?: number): Promise<TreeNode> {
    const scopeLogical = path ? this.normalizeLogical(path) : '';
    const maxDepth = depth ?? DEFAULT_TREE_DEPTH;

    const root = this.rootFor(userId);

    // Las tablas tienen physical paths; traducimos a lógico para construir el árbol.
    const ownerWhere = this.hosted ? 'WHERE owner_id = ?' : '';
    const ownerParams: unknown[] = this.hosted ? [userId] : [];
    const notePhysicals = this.opts.db.sqlite
      .prepare<unknown[], { path: string }>(`SELECT path FROM notes ${ownerWhere}`)
      .all(...ownerParams)
      .map((r) => this.toLogical(userId, r.path));
    const attachmentPhysicals = this.opts.db.sqlite
      .prepare<unknown[], { path: string }>(`SELECT path FROM attachments ${ownerWhere}`)
      .all(...ownerParams)
      .map((r) => this.toLogical(userId, r.path));

    const all: Array<{ path: string; type: 'note' | 'attachment' }> = [
      ...notePhysicals.map((p) => ({ path: p, type: 'note' as const })),
      ...attachmentPhysicals.map((p) => ({ path: p, type: 'attachment' as const })),
    ];

    const inScope = scopeLogical
      ? all.filter(
          (e) => e.path === scopeLogical || e.path.startsWith(`${scopeLogical}/`),
        )
      : all;

    const rootNode: TreeNode = {
      path: scopeLogical,
      name: scopeLogical === '' ? '' : (scopeLogical.split('/').pop() ?? scopeLogical),
      type: 'folder',
      children: [],
    };

    const folderIndex = new Map<string, TreeNode>();
    folderIndex.set(scopeLogical, rootNode);

    const allFolders = await listFolders(root);
    for (const folderPath of allFolders) {
      const inFolderScope = scopeLogical
        ? folderPath === scopeLogical || folderPath.startsWith(`${scopeLogical}/`)
        : true;
      if (!inFolderScope) continue;
      const relative = scopeLogical ? folderPath.slice(scopeLogical.length + 1) : folderPath;
      if (relative === '') continue;
      const segments = relative.split('/');
      if (segments.length > maxDepth) continue;
      let parentPath = scopeLogical;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i] ?? '';
        const fp = parentPath === '' ? segment : `${parentPath}/${segment}`;
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

    for (const entry of inScope) {
      const relative = scopeLogical ? entry.path.slice(scopeLogical.length + 1) : entry.path;
      if (relative === '') continue;
      const segments = relative.split('/');
      if (segments.length > maxDepth) continue;

      let parentPath = scopeLogical;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i] ?? '';
        const folderPath = parentPath === '' ? segment : `${parentPath}/${segment}`;
        let folderNode = folderIndex.get(folderPath);
        if (!folderNode) {
          folderNode = {
            path: folderPath,
            name: segment,
            type: 'folder',
            children: [],
          };
          folderIndex.set(folderPath, folderNode);
          folderIndex.get(parentPath)?.children?.push(folderNode);
        }
        parentPath = folderPath;
      }

      const leaf: TreeNode = {
        path: entry.path,
        name: segments[segments.length - 1] ?? entry.path,
        type: entry.type,
      };
      folderIndex.get(parentPath)?.children?.push(leaf);
    }

    sortTree(rootNode);
    return rootNode;
  }

  listDecisions(
    userId: string,
    filter: { folder?: string; limit?: number } = {},
  ): Array<{
    path: string;
    title: string;
    mtime: number;
  }> {
    const limit = filter.limit ?? 100;
    const folderPattern = filter.folder
      ? `${this.toPhysical(userId, filter.folder.replace(/\/+$/, ''))}/%`
      : null;

    const ownerClause = this.hosted ? 'AND n.owner_id = ?' : '';

    const sql = `
      SELECT DISTINCT n.path, n.title, n.mtime
      FROM notes n
      LEFT JOIN tags t ON t.note_path = n.path
      WHERE (
        t.tag IN ('decisión', 'decision')
        OR json_extract(n.frontmatter, '$.status') = 'decidido'
      )
      ${folderPattern ? 'AND n.path LIKE ?' : ''}
      ${ownerClause}
      ORDER BY n.mtime DESC
      LIMIT ?
    `;

    const params: unknown[] = [];
    if (folderPattern) params.push(folderPattern);
    if (this.hosted) params.push(userId);
    params.push(limit);

    return this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; mtime: number }>(sql)
      .all(...params)
      .map((r) => ({
        path: this.toLogical(userId, r.path),
        title: r.title,
        mtime: r.mtime,
      }));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Valida y devuelve el path lógico sin '/' al inicio/fin. */
  private normalizeLogical(path: string): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('path is required', 'INVALID_INPUT', 400);
    }
    return toPosixPath(path).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  }

  /**
   * Normaliza un path del caller a su forma **física**. Aplica path traversal
   * guard y prefix de owner. Único punto que aplica safeResolve para que
   * cualquier intento de `../` muera acá.
   */
  private normalize(userId: string, path: string): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('path is required', 'INVALID_INPUT', 400);
    }
    const logical = toPosixPath(path);
    const physical = this.toPhysical(userId, logical);
    try {
      const abs = safeResolve(this.opts.cfg.notesDirAbs, physical);
      return relativeToRoot(this.opts.cfg.notesDirAbs, abs);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  private async classify(physicalPath: string): Promise<'file' | 'folder' | 'missing'> {
    const abs = safeResolve(this.opts.cfg.notesDirAbs, physicalPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return 'missing';
    return stat.isDirectory() ? 'folder' : 'file';
  }

  private async candidateMocs(
    userId: string,
    folderPhysicals: readonly string[],
  ): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const folder of folderPhysicals) {
      if (folder === '' || folder === userId) continue;
      const moc = mocPathFor(folder);
      if (seen.has(moc)) continue;
      seen.add(moc);
      try {
        await readNote(this.opts.cfg.notesDirAbs, moc);
        out.push(moc);
      } catch {
        // MOC doesn't exist — skip silently.
      }
    }
    return out;
  }

  private async walkFolder(physicalPath: string): Promise<ChildEntry[]> {
    const baseAbs = safeResolve(this.opts.cfg.notesDirAbs, physicalPath);
    const out: ChildEntry[] = [];

    const walk = async (dirAbs: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const childAbs = join(dirAbs, entry.name);
        if (entry.isDirectory()) {
          await walk(childAbs);
        } else if (entry.isFile()) {
          const relative = relativeToRoot(this.opts.cfg.notesDirAbs, childAbs);
          out.push({
            path: relative,
            type: relative.toLowerCase().endsWith('.md') ? 'note' : 'attachment',
          });
        }
      }
    };

    await walk(baseAbs);
    return out;
  }
}

interface ChildEntry {
  path: string;
  type: 'note' | 'attachment';
}

function buildContent(body: string, frontmatter: Frontmatter): string {
  return matter.stringify(body, frontmatter);
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function mocPathFor(folderPath: string): string {
  const folder = folderPath.split('/').pop() ?? folderPath;
  return `${folderPath}/_${folder}.md`;
}

function mapPathError(err: unknown): unknown {
  if (err instanceof PathTraversalError) {
    return new AppError(err.message, 'INVALID_INPUT', 400);
  }
  return err;
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
