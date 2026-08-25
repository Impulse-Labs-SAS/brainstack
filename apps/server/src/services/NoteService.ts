// NoteService: everything the API, the MCP tools and the web app do to notes.
//
// Every method takes the user it acts for, and every path crossing this
// boundary is logical — the owner prefix is applied on the way in and stripped
// on the way out, so nothing above this layer can accidentally address another
// user's note. See lib/vault.ts.
//
// Folders are not stored. A folder exists because notes live under it, which is
// what lets the tree be derived from paths alone rather than kept in sync with
// a second table.

import {
  PgNoteAlreadyExistsError,
  PgNoteNotFoundError,
  PgNoteStore,
  pgSchema,
  toMarkdown,
  type Backlink,
  type NoteSummary,
  type PgDb,
  type StoredNote,
} from '@brainstack/core/pg';
import { rewriteLinkTargets, type Frontmatter, type NoteBodySource } from '@brainstack/core';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import matter from 'gray-matter';

import { AppError } from '../lib/errors.js';
import { toLogical, toPhysical, type VaultConfig } from '../lib/vault.js';

const { folders, links, notes, tags } = pgSchema;

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
 * notes that probably need a follow-up edit. The server does not touch them —
 * MOCs are a convention with per-vault style, not a structure to enforce — it
 * just saves the caller from recomputing the paths.
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
  /** Logical posix path. */
  path: string;
  /** Basename. */
  name: string;
  type: 'folder' | 'note';
  /** Sorted children: folders first, then notes, both alphabetical. */
  children?: TreeNode[];
}

export interface NoteServiceOptions {
  db: PgDb;
  cfg: VaultConfig;
  store?: PgNoteStore;
}

const DEFAULT_TREE_DEPTH = 4;

/**
 * Hard ceiling on tree depth a caller can ask for. Lives here so the tRPC and
 * MCP schemas, the web client and this service share one number.
 */
export const MAX_TREE_DEPTH = 20;

/**
 * One person's vault, and nothing about who is allowed to touch it.
 *
 * Every method here takes the id of the vault's **owner**, not of whoever is
 * asking: `ownerId` decides the physical path prefix, the `owner_id` stamped on
 * new rows, and which rows a listing may see. So `create(bob, 'nota.md')`
 * writes into Bob's vault whoever called it, and a note somebody else adds to a
 * folder Bob shared belongs to Bob — which is what keeps the share covering it.
 *
 * Authorisation is deliberately not here. `SharingService` answers who may read
 * or write a path, and the tRPC and MCP layers ask it before calling in. This
 * split is why writing to a shared folder needed no new write path: it needed
 * callers to stop passing the caller where the owner belongs.
 *
 * `graph` is the exception and says so: it spans vaults, so it takes the viewer
 * plus the folders shared with them.
 */
export class NoteService {
  private readonly store: PgNoteStore;

  constructor(private readonly opts: NoteServiceOptions) {
    this.store = opts.store ?? new PgNoteStore(opts.db);
  }

  private get hosted(): boolean {
    return this.opts.cfg.deployment === 'hosted';
  }

  private toPhysical(ownerId: string, logical: string): string {
    return toPhysical(ownerId, this.normalizeLogical(logical), this.opts.cfg);
  }

  private toLogical(ownerId: string, physical: string): string {
    return toLogical(ownerId, physical, this.opts.cfg);
  }

  /**
   * The logical path when the prefix is this user's, and the value untouched
   * when it is not.
   *
   * Unlike `toLogical`, this never throws. It is for values that are only
   * sometimes prefixed — an unresolved link target names a note that does not
   * exist, so it carries no owner and must survive the trip unchanged.
   */
  private toLogicalIfMine(ownerId: string, value: string): string {
    if (!this.hosted) return value;
    const prefix = `${ownerId}/`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }

  /**
   * A stored path without its owner segment.
   *
   * Unlike `toLogicalIfMine` the owner is given rather than assumed, which is
   * what a listing spanning several owners needs.
   */
  /**
   * Runs a store call and, if it fails naming a path, names the one the caller
   * used instead.
   *
   * The store only knows stored paths, so "note not found: u_42/nota.md" was
   * reaching the user with somebody's id in it — theirs, but still an internal
   * detail they never typed and cannot act on.
   */
  private async asCaller<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PgNoteNotFoundError) {
        throw new PgNoteNotFoundError(this.toLogicalIfMine(ownerId, err.path));
      }
      if (err instanceof PgNoteAlreadyExistsError) {
        throw new PgNoteAlreadyExistsError(this.toLogicalIfMine(ownerId, err.path));
      }
      throw err;
    }
  }

  private stripOwner(physical: string, ownerId: string | null): string {
    if (!this.hosted || !ownerId) return physical;
    const prefix = `${ownerId}/`;
    return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
  }

  private normalizeLogical(path: string): string {
    return path.replace(/^[\\/]+/, '').replace(/\/+$/, '');
  }

  /** Matches every note owned by this user, prefix or column depending on mode. */
  private ownedBy(ownerId: string) {
    return this.hosted ? like(notes.path, `${ownerId}/%`) : sql`true`;
  }

  /** The same, for the folders table. */
  private foldersOwnedBy(ownerId: string) {
    return this.hosted ? like(folders.path, `${ownerId}/%`) : sql`true`;
  }

  // -- Reads -----------------------------------------------------------------

  async get(ownerId: string, path: string): Promise<NoteRowDto> {
    const row = await this.asCaller(ownerId, () => this.store.get(this.toPhysical(ownerId, path)));
    return this.toDto(ownerId, row);
  }

  async getMarkdown(ownerId: string, path: string): Promise<string> {
    return toMarkdown(
      await this.asCaller(ownerId, () => this.store.get(this.toPhysical(ownerId, path))),
    );
  }

  async list(ownerId: string, filter: ListFilter = {}): Promise<NoteSummary[]> {
    const folder = filter.folder
      ? this.toPhysical(ownerId, filter.folder)
      : this.scopeRoot(ownerId);
    const rows = await this.store.list({
      ...(folder ? { folder } : {}),
      ...(filter.tag ? { tag: filter.tag } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.limit ? { limit: filter.limit } : {}),
    });
    return rows.map((r) => ({ ...r, path: this.toLogical(ownerId, r.path) }));
  }

  async listLinks(ownerId: string, path: string): Promise<Backlink[]> {
    const rows = await this.store.listBacklinks(this.toPhysical(ownerId, path));
    // `targetPath` used to go out prefixed while `sourcePath` went out clean,
    // so the backlinks panel showed the caller their own user id.
    return rows.map((r) => ({
      ...r,
      sourcePath: this.toLogical(ownerId, r.sourcePath),
      targetPath: this.toLogicalIfMine(ownerId, r.targetPath),
    }));
  }

  async listTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
    const rows = await this.opts.db
      .select({ tag: tags.tag, count: sql<number>`count(*)::int` })
      .from(tags)
      .innerJoin(notes, eq(notes.path, tags.notePath))
      .where(this.ownedBy(ownerId))
      .groupBy(tags.tag)
      .orderBy(sql`count(*) desc`);
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  // -- Writes ----------------------------------------------------------------

  async create(
    ownerId: string,
    path: string,
    content: string,
    frontmatter?: Frontmatter,
  ): Promise<MutationResult> {
    const physical = this.toPhysical(ownerId, path);
    const raw = frontmatter ? matter.stringify(content, frontmatter) : content;
    const saved = await this.asCaller(ownerId, () => this.store.create(physical, raw, ownerId));
    const logical = this.toLogical(ownerId, saved.path);

    // A note can be created straight into a folder nobody made, so the folders
    // it lands in are registered here rather than left implied by its path.
    const parent = logical.split('/').slice(0, -1).join('/');
    if (parent) await this.ensureFolders(ownerId, parent);
    return { path: logical, affectedMocs: await this.mocsFor(ownerId, logical) };
  }

  async update(ownerId: string, path: string, content: string): Promise<string> {
    const physical = this.toPhysical(ownerId, path);
    // Preserve existing frontmatter unless the incoming content carries its own.
    const existing = await this.asCaller(ownerId, () => this.store.get(physical));
    const incoming = matter(content);
    const raw =
      Object.keys(incoming.data).length > 0
        ? content
        : matter.stringify(content, existing.frontmatter);

    const saved = await this.store.upsert(physical, raw, ownerId);
    return this.toLogical(ownerId, saved.path);
  }

  /**
   * Delete a note, or a folder and everything under it.
   *
   * A folder has no row of its own, so a recursive delete on one removes its
   * descendants and finds nothing at the path itself. That is a success, not a
   * miss — which is what makes "delete this folder" work from the tree.
   */
  async remove(ownerId: string, path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const physical = this.toPhysical(ownerId, path);

    if (!opts.recursive) {
      await this.store.remove(physical);
      return;
    }

    const under = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(and(this.ownedBy(ownerId), like(notes.path, `${physical}/%`)));

    if (under.length > 0) {
      await this.store.removeMany(under.map((r) => r.path));
    }

    // The folder rows go with it: the folder itself and everything nested.
    const removedFolders = await this.opts.db
      .delete(folders)
      .where(
        and(
          this.foldersOwnedBy(ownerId),
          or(eq(folders.path, physical), like(folders.path, `${physical}/%`)),
        ),
      )
      .returning({ path: folders.path });

    const [self] = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(eq(notes.path, physical))
      .limit(1);

    if (self) {
      await this.store.remove(physical);
    } else if (under.length === 0 && removedFolders.length === 0) {
      // Neither a note nor a folder with anything in it.
      throw new AppError(`not found: ${path}`, 'NOT_FOUND', 404);
    }
  }

  async move(ownerId: string, fromPath: string, toPath: string): Promise<MutationResult> {
    const from = this.toPhysical(ownerId, fromPath);
    const to = this.toPhysical(ownerId, toPath);
    const saved = await this.asCaller(ownerId, () => this.store.move(from, to));

    // Keep every wikilink that pointed at the old path pointing at the new one.
    await rewriteLinkTargets(this.bodySource(ownerId), [{ from, to }]);

    const logical = this.toLogical(ownerId, saved.path);
    return { path: logical, affectedMocs: await this.mocsFor(ownerId, logical) };
  }

  /**
   * Create an empty folder.
   *
   * Every folder above it is created too, so a nested path leaves no gaps —
   * what `mkdir -p` does, for the same reason.
   */
  async createFolder(ownerId: string, path: string): Promise<string> {
    const logical = this.normalizeLogical(path);
    if (!logical) throw new AppError('folder path is required', 'INVALID_INPUT', 400);
    await this.ensureFolders(ownerId, logical);
    return logical;
  }

  /** Register a folder and its ancestors. Idempotent. */
  private async ensureFolders(ownerId: string, logicalFolder: string): Promise<void> {
    const segments = logicalFolder.split('/').filter(Boolean);
    if (segments.length === 0) return;

    const now = Date.now();
    await this.opts.db
      .insert(folders)
      .values(
        segments.map((_, i) => ({
          path: this.toPhysical(ownerId, segments.slice(0, i + 1).join('/')),
          ownerId: this.hosted ? ownerId : null,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  async addToInbox(ownerId: string, content: string, title?: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = (title ?? 'capture')
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    const path = `Inbox/${stamp}-${slug || 'capture'}.md`;
    const body = title ? `# ${title}\n\n${content}` : content;
    const { path: saved } = await this.create(ownerId, path, body);
    return saved;
  }

  // -- Tree ------------------------------------------------------------------

  async listTree(ownerId: string, path?: string, depth?: number): Promise<TreeNode> {
    const scope = path ? this.normalizeLogical(path) : '';
    const maxDepth = Math.min(depth ?? DEFAULT_TREE_DEPTH, MAX_TREE_DEPTH);

    const [noteRows, folderRows] = await Promise.all([
      this.opts.db.select({ path: notes.path }).from(notes).where(this.ownedBy(ownerId)),
      this.opts.db.select({ path: folders.path }).from(folders).where(this.foldersOwnedBy(ownerId)),
    ]);

    const inScope = (p: string): boolean =>
      scope ? p === scope || p.startsWith(`${scope}/`) : true;

    const notePaths = noteRows.map((r) => this.toLogical(ownerId, r.path)).filter(inScope);
    // Folders with notes under them are already implied by those paths; these
    // are the empty ones, which nothing else would reveal.
    const folderPaths = folderRows.map((r) => this.toLogical(ownerId, r.path)).filter(inScope);

    return buildTree(scope, notePaths, maxDepth, folderPaths);
  }

  // -- Graph -----------------------------------------------------------------

  /**
   * Nodes and weighted edges for the graph view. `sharedScopes` widens it to
   * folders other people shared, which is why nodes carry their owner.
   */
  /**
   * Nodes and edges across every vault the viewer can see.
   *
   * The one method whose first argument is the viewer rather than a vault
   * owner: a graph that stopped at your own notes would not show the shared
   * folders it exists to connect.
   */
  async graph(
    viewerId: string,
    opts: { sharedScopes?: Array<{ ownerId: string; folderPath: string }> } = {},
  ): Promise<{
    nodes: Array<{ id: string; path: string; title: string; ownerId: string | null }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  }> {
    const scopes = [this.ownedBy(viewerId)];
    for (const s of opts.sharedScopes ?? []) {
      scopes.push(like(notes.path, `${s.ownerId}/${s.folderPath}/%`));
    }
    const where = scopes.length === 1 ? scopes[0] : or(...scopes);

    const nodeRows = await this.opts.db
      .select({ path: notes.path, title: notes.title, ownerId: notes.ownerId })
      .from(notes)
      .where(where);

    const visible = new Set(nodeRows.map((r) => r.path));
    const edgeRows = await this.opts.db
      .select({
        source: links.sourcePath,
        target: links.targetPath,
        weight: sql<number>`count(*)::int`,
      })
      .from(links)
      .where(inArray(links.sourcePath, [...visible]))
      .groupBy(links.sourcePath, links.targetPath);

    return {
      /*
       * Two identifiers, because one cannot do both jobs here. A graph that
       * includes shared folders can hold two notes whose logical path is the
       * same "proyectos/nota.md" under different owners, so the stored path is
       * what keeps nodes and edges apart — but showing it puts a user id on
       * screen and in the URL. `id` joins, `path` is read.
       */
      nodes: nodeRows.map((r) => ({
        id: r.path,
        path: this.stripOwner(r.path, r.ownerId),
        title: r.title,
        ownerId: r.ownerId ?? null,
      })),
      // An edge to a note nobody can see would draw a line into nothing.
      edges: edgeRows
        .filter((e) => visible.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, weight: Number(e.weight) })),
    };
  }

  // -- Decisions -------------------------------------------------------------

  /** Notes tagged as decisions, newest first. Feeds the decisions view. */
  async listDecisions(
    ownerId: string,
    filter: { folder?: string; limit?: number } = {},
  ): Promise<Array<{ path: string; title: string; mtime: number }>> {
    const limit = filter.limit ?? 100;
    const scope = filter.folder ? this.toPhysical(ownerId, filter.folder) : null;

    const rows = await this.opts.db
      .selectDistinct({
        path: notes.path,
        title: notes.title,
        mtime: notes.updatedAt,
      })
      .from(notes)
      .innerJoin(tags, eq(tags.notePath, notes.path))
      .where(
        and(
          this.ownedBy(ownerId),
          inArray(tags.tag, ['decisión', 'decision']),
          ...(scope ? [like(notes.path, `${scope}/%`)] : []),
        ),
      )
      .orderBy(sql`${notes.updatedAt} desc`)
      .limit(limit);

    return rows.map((r) => ({
      path: this.toLogical(ownerId, r.path),
      title: r.title,
      mtime: Number(r.mtime),
    }));
  }

  // -- Internals -------------------------------------------------------------

  /** Where this user's notes start, as a stored-path prefix. */
  private scopeRoot(ownerId: string): string {
    return this.hosted ? ownerId : '';
  }

  private toDto(ownerId: string, row: StoredNote): NoteRowDto {
    return {
      path: this.toLogical(ownerId, row.path),
      title: row.title,
      frontmatter: row.frontmatter,
      body: row.body,
      mtime: Number(row.updatedAt),
      checksum: row.checksum,
    };
  }

  /** The `_<Folder>.md` notes sitting above a path, innermost first. */
  private async mocsFor(ownerId: string, logicalPath: string): Promise<string[]> {
    const segments = logicalPath.split('/').slice(0, -1);
    if (segments.length === 0) return [];

    const candidates: string[] = [];
    for (let i = segments.length; i > 0; i--) {
      const folder = segments.slice(0, i).join('/');
      const name = segments[i - 1] ?? '';
      candidates.push(this.toPhysical(ownerId, `${folder}/_${name}.md`));
    }

    const found = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(inArray(notes.path, candidates));

    return found.map((r) => this.toLogical(ownerId, r.path));
  }

  /** Feeds `rewriteLinkTargets` from the store, in stored-path terms. */
  private bodySource(ownerId: string): NoteBodySource {
    return {
      list: async () => {
        const rows = await this.opts.db
          .select({ path: notes.path })
          .from(notes)
          .where(this.ownedBy(ownerId));
        return rows.map((r) => r.path);
      },
      read: async (path) => (await this.store.get(path)).body,
      write: async (path, body) => {
        const existing = await this.store.get(path);
        await this.store.upsert(path, matter.stringify(body, existing.frontmatter), ownerId);
      },
    };
  }
}

/**
 * Build the tree from the notes, plus any folder that holds nothing yet.
 *
 * Note paths imply every folder along them, so `emptyFolders` only has to carry
 * the ones no note would reveal.
 */
export function buildTree(
  scope: string,
  logicalPaths: readonly string[],
  maxDepth: number,
  emptyFolders: readonly string[] = [],
): TreeNode {
  const root: TreeNode = {
    path: scope,
    name: scope === '' ? '' : (scope.split('/').pop() ?? scope),
    type: 'folder',
    children: [],
  };

  const seen = new Map<string, TreeNode>([[scope, root]]);

  /** Walk a folder path into existence, returning the deepest node. */
  const ensureBranch = (relative: string): string => {
    let parent = scope;
    for (const segment of relative.split('/')) {
      if (!segment) continue;
      const folderPath = parent === '' ? segment : `${parent}/${segment}`;
      if (!seen.has(folderPath)) {
        const node: TreeNode = { path: folderPath, name: segment, type: 'folder', children: [] };
        seen.set(folderPath, node);
        seen.get(parent)?.children?.push(node);
      }
      parent = folderPath;
    }
    return parent;
  };

  for (const folder of emptyFolders) {
    const relative = scope ? folder.slice(scope.length + 1) : folder;
    if (!relative) continue;
    if (relative.split('/').length > maxDepth) continue;
    ensureBranch(relative);
  }

  for (const full of logicalPaths) {
    const relative = scope ? full.slice(scope.length + 1) : full;
    if (!relative) continue;
    const segments = relative.split('/');
    if (segments.length > maxDepth) continue;

    // Every segment but the last is a folder that has to exist first.
    const parent = ensureBranch(segments.slice(0, -1).join('/'));
    const name = segments[segments.length - 1] ?? '';
    seen.get(parent)?.children?.push({ path: full, name, type: 'note' });
  }

  sortTree(root);
  return root;
}

/** Folders before notes, alphabetical within each. */
function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}
