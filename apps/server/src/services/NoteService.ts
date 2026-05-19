// CRUD over notes, folders and attachments. Each write goes through
// @brainstack/core (atomic filesystem) and then triggers an immediate reindex
// so the sqlite cache stays in sync without waiting for the chokidar event
// (the watcher will dedupe the event by checksum).

import { promises as fsp, type Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  FolderNotEmptyError,
  NoteAlreadyExistsError,
  NoteNotFoundError,
  PathTraversalError,
  createFolder,
  deletePath,
  listFolders,
  movePath,
  readAttachment,
  readNote,
  relativeToRoot,
  rewriteLinkTargets,
  safeResolve,
  toPosixPath,
  writeAttachment,
  writeNote,
  type BrainStackDatabase,
  type Frontmatter,
  type LinkRewriteMapping,
} from '@brainstack/core';
import matter from 'gray-matter';

import { AppError } from '../lib/errors.js';

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
  root: string;
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
  // Notes — CRUD
  // ---------------------------------------------------------------------------

  async get(path: string): Promise<NoteRowDto> {
    const row = this.opts.db.sqlite
      .prepare<[string], { path: string; title: string; frontmatter: string; body: string; mtime: number; checksum: string }>(
        'SELECT path, title, frontmatter, body, mtime, checksum FROM notes WHERE path = ?',
      )
      .get(path);
    if (!row) {
      try {
        const file = await readNote(this.opts.root, path);
        await this.opts.index.reindex(file.path);
        return this.get(file.path);
      } catch (err) {
        if (err instanceof NoteNotFoundError) {
          throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
        }
        throw err;
      }
    }
    return {
      path: row.path,
      title: row.title,
      frontmatter: JSON.parse(row.frontmatter) as Frontmatter,
      body: row.body,
      mtime: row.mtime,
      checksum: row.checksum,
    };
  }

  async create(
    path: string,
    content: string,
    frontmatter?: Frontmatter,
  ): Promise<MutationResult> {
    const merged = frontmatter ? buildContent(content, frontmatter) : content;
    try {
      const finalPath = await writeNote(this.opts.root, path, merged, { failIfExists: true });
      await this.opts.index.reindex(finalPath);
      const affectedMocs = await this.candidateMocs([parentOf(finalPath)]);
      return { path: finalPath, affectedMocs };
    } catch (err) {
      if (err instanceof NoteAlreadyExistsError) {
        throw new AppError(`note already exists: ${path}`, 'ALREADY_EXISTS', 409);
      }
      throw mapPathError(err);
    }
  }

  async update(path: string, content: string): Promise<string> {
    try {
      await readNote(this.opts.root, path);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw mapPathError(err);
    }
    const finalPath = await writeNote(this.opts.root, path, content);
    await this.opts.index.reindex(finalPath);
    return finalPath;
  }

  // ---------------------------------------------------------------------------
  // Filesystem operations on notes / folders / attachments
  // ---------------------------------------------------------------------------

  /**
   * Delete a note, attachment, or folder. Folders require `recursive: true`
   * unless they are empty. If the path turns out to be a single file, the
   * `recursive` flag is harmless — it permits descending, not requires it.
   *
   * Returns the explicit list of paths that were deleted. Callers (CLI/UX,
   * MCP) get the blast radius for free without having to diff the tree
   * before/after, and the agent sees exactly what its delete touched.
   */
  async remove(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<{ deleted: string[] }> {
    const norm = this.normalize(path);

    // Enumerate before the FS mutation so the response is accurate even if a
    // descendant disappears mid-operation. For files this is trivially the
    // path itself; for folders we walk disk (same authoritative source as
    // `move`).
    const kind = await this.classify(norm);
    if (kind === 'missing') {
      throw new AppError(`path not found: ${norm}`, 'NOT_FOUND', 404);
    }
    const targets: string[] =
      kind === 'folder' ? (await this.walkFolder(norm)).map((c) => c.path) : [norm];

    try {
      await deletePath(this.opts.root, norm, { recursive: options.recursive });
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`path not found: ${norm}`, 'NOT_FOUND', 404);
      }
      if (err instanceof FolderNotEmptyError) {
        throw new AppError(
          `folder not empty: ${norm} (pass recursive=true to delete contents)`,
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
    // Attachment removals are handled by the watcher's periodic rescan; the
    // explicit `deleted` list still reports them so the caller has the full
    // picture.

    return { deleted: targets.sort() };
  }

  /**
   * Move/rename a note, attachment, or folder. Wikilinks targeting the moved
   * path(s) get rewritten across the vault.
   *
   * Order matters: filesystem rename first, then rewrite wikilinks. If the
   * process dies between these two steps, the worst-case is dangling
   * wikilinks the indexer will flag as unresolved — not links pointing at a
   * vanished intermediate path.
   */
  async move(fromPath: string, toPath: string): Promise<MutationResult> {
    const fromNorm = this.normalize(fromPath);
    const toNorm = this.normalize(toPath);

    // Enumerate everything that's about to move from disk — not from the DB.
    // The index can be a step behind (e.g. a freshly written attachment whose
    // bulk-rescan hasn't fired yet); if its mapping isn't in the rewrite list,
    // wikilinks pointing at it stay broken forever, since rewriteLinkTargets
    // runs exactly once per move. Disk is the only authoritative source.
    const movedTopLevelKind = await this.classify(fromNorm);
    const movingChildren: ChildEntry[] =
      movedTopLevelKind === 'folder' ? await this.walkFolder(fromNorm) : [];

    let finalPath: string;
    try {
      finalPath = await movePath(this.opts.root, fromNorm, toNorm);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`path not found: ${fromNorm}`, 'NOT_FOUND', 404);
      }
      if (err instanceof NoteAlreadyExistsError) {
        throw new AppError(`destination already exists: ${toNorm}`, 'ALREADY_EXISTS', 409);
      }
      throw mapPathError(err);
    }

    // Build the rewrite mappings. For a single file we map the file itself.
    // For a folder, we map every classified child the disk walk found —
    // notes go through note-matching rules, binaries through exact-path
    // matching. The classification follows the same rule the resolver uses:
    // `.md` (case-insensitive) → note; anything else → attachment.
    const mappings: LinkRewriteMapping[] = [];
    const movedNotePaths: string[] = []; // old paths, for index.remove
    const newNotePaths: string[] = []; // new paths, for index.reindex

    if (movedTopLevelKind === 'file') {
      mappings.push({ from: fromNorm, to: finalPath });
      if (fromNorm.toLowerCase().endsWith('.md')) {
        movedNotePaths.push(fromNorm);
        newNotePaths.push(finalPath);
      }
    } else if (movedTopLevelKind === 'folder') {
      for (const child of movingChildren) {
        const rel = child.path.slice(fromNorm.length + 1);
        const newPath = `${finalPath}/${rel}`;
        mappings.push({ from: child.path, to: newPath });
        if (child.type === 'note') {
          movedNotePaths.push(child.path);
          newNotePaths.push(newPath);
        }
      }
    }

    const { filesChanged } = await rewriteLinkTargets(this.opts.root, mappings);

    // Bring the index in sync with disk: drop the old note paths, reindex
    // the new ones, then reindex every file whose body the rewriter touched.
    for (const oldPath of movedNotePaths) this.opts.index.remove(oldPath);
    for (const newPath of newNotePaths) await this.opts.index.reindex(newPath);
    for (const changed of filesChanged) {
      await this.opts.index.reindex(changed);
    }

    const affectedMocs = await this.candidateMocs([
      parentOf(fromNorm),
      parentOf(finalPath),
    ]);
    return { path: finalPath, affectedMocs };
  }

  async createFolder(path: string): Promise<string> {
    const norm = this.normalize(path);
    try {
      return await createFolder(this.opts.root, norm);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  async uploadAttachment(input: UploadAttachmentInput): Promise<string> {
    const norm = this.normalize(input.path);
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
      const finalPath = await writeAttachment(this.opts.root, norm, bytes);
      // Attachment indexing is handled by the watcher rescan; the table is
      // rebuilt in bulk rather than per-row.
      return finalPath;
    } catch (err) {
      throw mapPathError(err);
    }
  }

  async getAttachment(path: string): Promise<AttachmentPayload> {
    const norm = this.normalize(path);
    try {
      const result = await readAttachment(this.opts.root, norm);
      return {
        path: result.path,
        sizeBytes: result.sizeBytes,
        mtime: result.mtime,
        dataBase64: result.bytes.toString('base64'),
      };
    } catch (err) {
      if (err instanceof PathTraversalError) throw mapPathError(err);
      if (err instanceof Error && err.message.startsWith('attachment not found')) {
        throw new AppError(`attachment not found: ${norm}`, 'NOT_FOUND', 404);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(filter: ListFilter = {}): Array<{ path: string; title: string; mtime: number }> {
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
      params.push(`${filter.folder.replace(/\/+$/, '')}/%`);
    }
    if (filter.status) {
      where.push("json_extract(n.frontmatter, '$.status') = ?");
      params.push(filter.status);
    }

    if (where.length > 0) parts.push('WHERE ' + where.join(' AND '));
    parts.push('ORDER BY n.mtime DESC LIMIT ?');
    params.push(limit);

    return this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; mtime: number }>(parts.join(' '))
      .all(...params);
  }

  listLinks(path: string): Array<{
    sourcePath: string;
    targetPath: string;
    targetType: string;
    linkKind: string;
    alias: string | null;
    section: string | null;
  }> {
    return this.opts.db.sqlite
      .prepare<
        [string],
        {
          source_path: string;
          target_path: string;
          target_type: string;
          link_kind: string;
          alias: string | null;
          section: string | null;
        }
      >(
        `SELECT source_path, target_path, target_type, link_kind, alias, section
         FROM links WHERE target_path = ?
         ORDER BY source_path, position`,
      )
      .all(path)
      .map((row) => ({
        sourcePath: row.source_path,
        targetPath: row.target_path,
        targetType: row.target_type,
        linkKind: row.link_kind,
        alias: row.alias,
        section: row.section,
      }));
  }

  /**
   * Whole-vault graph for the Obsidian-style visualisation. Nodes are notes
   * (path + title); edges are resolved note-to-note wikilinks/embeds. Unresolved
   * links and attachment links are dropped — they have no node to anchor to.
   * Duplicate edges (multiple links between the same pair) are collapsed and
   * counted via `weight` so the renderer can thicken heavy connections.
   */
  graph(): {
    nodes: Array<{ path: string; title: string }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  } {
    const nodes = this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string }>('SELECT path, title FROM notes')
      .all();
    const nodeSet = new Set(nodes.map((n) => n.path));

    const raw = this.opts.db.sqlite
      .prepare<unknown[], { source_path: string; target_path: string }>(
        `SELECT source_path, target_path FROM links
         WHERE target_type = 'note' AND source_path <> target_path`,
      )
      .all();

    const counts = new Map<string, number>();
    for (const link of raw) {
      if (!nodeSet.has(link.source_path) || !nodeSet.has(link.target_path)) continue;
      const key = `${link.source_path} ${link.target_path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const edges = Array.from(counts.entries()).map(([key, weight]) => {
      const [source, target] = key.split(' ');
      return { source: source ?? '', target: target ?? '', weight };
    });
    return { nodes, edges };
  }

  /**
   * Hierarchical view of the vault. Builds a tree from the indexed notes +
   * attachments. `path` scopes the root of the tree (omit for the whole
   * vault). `depth` caps how many levels deep we descend (1 = immediate
   * children only).
   */
  async listTree(path?: string, depth?: number): Promise<TreeNode> {
    const scope = path ? this.normalize(path) : '';
    const maxDepth = depth ?? DEFAULT_TREE_DEPTH;

    const notePaths = this.opts.db.sqlite
      .prepare<unknown[], { path: string }>('SELECT path FROM notes')
      .all()
      .map((r) => r.path);
    const attachmentPaths = this.opts.db.sqlite
      .prepare<unknown[], { path: string }>('SELECT path FROM attachments')
      .all()
      .map((r) => r.path);

    const all: Array<{ path: string; type: 'note' | 'attachment' }> = [
      ...notePaths.map((p) => ({ path: p, type: 'note' as const })),
      ...attachmentPaths.map((p) => ({ path: p, type: 'attachment' as const })),
    ];

    const inScope = scope
      ? all.filter((e) => e.path === scope || e.path.startsWith(`${scope}/`))
      : all;

    const rootNode: TreeNode = {
      path: scope,
      name: scope === '' ? '' : (scope.split('/').pop() ?? scope),
      type: 'folder',
      children: [],
    };

    const folderIndex = new Map<string, TreeNode>();
    folderIndex.set(scope, rootNode);

    // Seed the index with real filesystem folders so empty ones still show up.
    // The notes/attachments loop below only materialises folders that contain
    // indexed files, so without this pass `createFolder` would be invisible.
    const allFolders = await listFolders(this.opts.root);
    for (const folderPath of allFolders) {
      const inFolderScope = scope
        ? folderPath === scope || folderPath.startsWith(`${scope}/`)
        : true;
      if (!inFolderScope) continue;
      const relative = scope ? folderPath.slice(scope.length + 1) : folderPath;
      if (relative === '') continue;
      const segments = relative.split('/');
      if (segments.length > maxDepth) continue;
      let parentPath = scope;
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
      const relative = scope ? entry.path.slice(scope.length + 1) : entry.path;
      if (relative === '') continue;
      const segments = relative.split('/');
      if (segments.length > maxDepth) continue;

      let parentPath = scope;
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

  /**
   * Notes the user has marked as decisions. V1 heuristic: tagged `decisión`
   * (or `decision`) OR `frontmatter.status === 'decidido'`. Lives in a single
   * SQL pass with a UNION to dedupe.
   */
  listDecisions(filter: { folder?: string; limit?: number } = {}): Array<{
    path: string;
    title: string;
    mtime: number;
  }> {
    const limit = filter.limit ?? 100;
    const folderPattern = filter.folder
      ? `${filter.folder.replace(/\/+$/, '')}/%`
      : null;

    const sql = `
      SELECT DISTINCT n.path, n.title, n.mtime
      FROM notes n
      LEFT JOIN tags t ON t.note_path = n.path
      WHERE (
        t.tag IN ('decisión', 'decision')
        OR json_extract(n.frontmatter, '$.status') = 'decidido'
      )
      ${folderPattern ? 'AND n.path LIKE ?' : ''}
      ORDER BY n.mtime DESC
      LIMIT ?
    `;

    const params: unknown[] = [];
    if (folderPattern) params.push(folderPattern);
    params.push(limit);

    return this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; mtime: number }>(sql)
      .all(...params);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Apply path normalisation + traversal guard once at the service boundary. */
  private normalize(path: string): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('path is required', 'INVALID_INPUT', 400);
    }
    const norm = toPosixPath(path);
    try {
      const abs = safeResolve(this.opts.root, norm);
      return relativeToRoot(this.opts.root, abs);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  private async classify(path: string): Promise<'file' | 'folder' | 'missing'> {
    const abs = safeResolve(this.opts.root, path);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return 'missing';
    return stat.isDirectory() ? 'folder' : 'file';
  }

  /**
   * Resolve `_<Folder>.md` MOC candidates for the given folder paths and keep
   * only the ones that already exist. Used by `create` and `move` to give the
   * caller a follow-up list without forcing them to recompute or stat paths.
   * Deduplicates, drops the vault root (no obvious MOC name), and ignores
   * folders that have no MOC yet — convention isn't enforced server-side.
   */
  private async candidateMocs(folderPaths: readonly string[]): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const folder of folderPaths) {
      if (folder === '') continue;
      const moc = mocPathFor(folder);
      if (seen.has(moc)) continue;
      seen.add(moc);
      try {
        await readNote(this.opts.root, moc);
        out.push(moc);
      } catch {
        // MOC doesn't exist — skip silently. The agent will see the empty
        // slot and either create one or move on.
      }
    }
    return out;
  }

  /**
   * Recursively enumerate every file under `folderPath` from disk, classified
   * by extension. Used by `move` to build a complete mapping list independent
   * of the index — see the comment in `move` for why disk is authoritative
   * here. Supports mixed folders (notes + binaries) regardless of location.
   */
  private async walkFolder(folderPath: string): Promise<ChildEntry[]> {
    const baseAbs = safeResolve(this.opts.root, folderPath);
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
          const relative = relativeToRoot(this.opts.root, childAbs);
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

