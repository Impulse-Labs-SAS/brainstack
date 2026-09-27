// Reading somebody else's notes, through a folder they shared.
//
// Separate from NoteService on purpose: NoteService acts for one user over
// their own vault and never needs to think about permission, while everything
// here crosses an ownership boundary and checks SharingService first.
//
// Paths in and out are relative to the owner's root, not the viewer's, because
// that is how a shared folder is addressed: "this path, in that person's brain".

import { escapeLike, pgSchema, type PgDb } from '@brainstack/core/pg';
import { asc, eq, like, or } from 'drizzle-orm';

import { AppError } from '../lib/errors.js';
import { toPhysical, type VaultConfig } from '../lib/vault.js';

import { buildTree, type NoteRowDto, type TreeNode } from './NoteService.js';
import type { SharingService } from './SharingService.js';

const { folders, links, notes } = pgSchema;

export interface CrossOwnerLink {
  sourcePath: string;
  targetPath: string;
  targetType: 'note' | 'attachment' | 'unresolved';
  linkKind: string;
  alias: string | null;
  section: string | null;
}

export interface CrossOwnerReaderOptions {
  sharing: SharingService;
  vaultCfg: VaultConfig;
  db: PgDb;
}

const DEFAULT_TREE_DEPTH = 4;

export class CrossOwnerReader {
  constructor(private readonly opts: CrossOwnerReaderOptions) {}

  /** False in self-host, where there is nobody to read across from. */
  get enabled(): boolean {
    return this.opts.vaultCfg.deployment === 'hosted';
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new AppError('reading another vault is not available in a self-hosted instance', 'FORBIDDEN', 403);
    }
  }

  async getNote(viewerId: string, ownerId: string, path: string): Promise<NoteRowDto> {
    this.requireEnabled();
    await this.opts.sharing.assertCanRead(viewerId, ownerId, path);

    const physical = toPhysical(ownerId, path, this.opts.vaultCfg);
    const [row] = await this.opts.db.select().from(notes).where(eq(notes.path, physical)).limit(1);

    if (!row) throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);

    return {
      path,
      title: row.title,
      frontmatter: row.frontmatter,
      body: row.body,
      mtime: Number(row.updatedAt),
      checksum: row.checksum,
    };
  }

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
    await this.opts.sharing.assertCanRead(viewerId, ownerId, scopePath);

    const scope = scopePath.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    const prefix = toPhysical(ownerId, scope, this.opts.vaultCfg);

    // Only inside the shared folder: a grant on one folder must not reveal the
    // shape of the rest of the owner's brain.
    //
    // Both tables, like the owner's own tree does. A folder with notes under it
    // is implied by their paths, but an empty one is implied by nothing — and
    // reading only `notes` here meant a folder created inside a shared folder
    // was reported as created and then never appeared. That was invisible while
    // shared folders were read-only; making them writable is what surfaced it.
    const [noteRows, folderRows] = await Promise.all([
      this.opts.db
        .select({ path: notes.path })
        .from(notes)
        .where(like(notes.path, `${escapeLike(prefix)}/%`)),
      this.opts.db
        .select({ path: folders.path })
        .from(folders)
        .where(or(eq(folders.path, prefix), like(folders.path, `${escapeLike(prefix)}/%`))),
    ]);

    const ownerPrefix = `${ownerId}/`;
    const strip = (p: string): string =>
      p.startsWith(ownerPrefix) ? p.slice(ownerPrefix.length) : p;

    return buildTree(
      scope,
      noteRows.map((r) => strip(r.path)),
      depth ?? DEFAULT_TREE_DEPTH,
      folderRows.map((r) => strip(r.path)),
    );
  }

  /**
   * Outgoing links of a shared note, with targets the viewer cannot reach
   * reported as unresolved.
   *
   * That masking is the point: the link is real, but naming what it points at
   * would leak a path out of a folder nobody shared.
   */
  async linksForOwner(viewerId: string, ownerId: string, path: string): Promise<CrossOwnerLink[]> {
    this.requireEnabled();
    await this.opts.sharing.assertCanRead(viewerId, ownerId, path);

    const sourcePhysical = toPhysical(ownerId, path, this.opts.vaultCfg);
    const rows = await this.opts.db
      .select({
        sourcePath: links.sourcePath,
        targetPath: links.targetPath,
        targetType: links.targetType,
        linkKind: links.linkKind,
        alias: links.alias,
        section: links.section,
      })
      .from(links)
      .where(eq(links.sourcePath, sourcePhysical))
      .orderBy(asc(links.position));

    const out: CrossOwnerLink[] = [];
    for (const r of rows) {
      const targetOwner = r.targetPath.split('/')[0] ?? null;
      const unresolved = r.targetType === 'unresolved';

      const readable =
        !unresolved &&
        targetOwner !== null &&
        (await this.opts.sharing.canRead(
          viewerId,
          targetOwner,
          stripOwnerPrefix(r.targetPath, targetOwner),
        ));

      out.push({
        sourcePath: path,
        targetPath: readable ? stripOwnerPrefix(r.targetPath, targetOwner ?? '') : '',
        targetType: readable ? (r.targetType as CrossOwnerLink['targetType']) : 'unresolved',
        linkKind: r.linkKind,
        alias: r.alias,
        section: r.section,
      });
    }
    return out;
  }

  /**
   * Who links to a shared note, with sources the viewer cannot reach dropped
   * entirely rather than masked.
   *
   * `linksForOwner` masks a target with a placeholder because the link is
   * real and its author — the note's own owner — already sees it in their
   * editor; naming what it points at is what would leak. A backlink is the
   * opposite shape: it is *about* a note the viewer may have no relationship
   * to at all, so even reporting "a hidden note links here" discloses an
   * existence they had no reason to know about. Omission is the only masking
   * that does not leak here.
   *
   * Also covers the same-owner case: a folder can be partially shared (this
   * path's folder granted, a sibling not), so a source inside the ungranted
   * sibling is checked exactly like a source in somebody else's vault.
   */
  async backlinksForOwner(
    viewerId: string,
    ownerId: string,
    path: string,
  ): Promise<CrossOwnerLink[]> {
    this.requireEnabled();
    await this.opts.sharing.assertCanRead(viewerId, ownerId, path);

    const targetPhysical = toPhysical(ownerId, path, this.opts.vaultCfg);
    const rows = await this.opts.db
      .select({
        sourcePath: links.sourcePath,
        targetPath: links.targetPath,
        targetType: links.targetType,
        linkKind: links.linkKind,
        alias: links.alias,
        section: links.section,
      })
      .from(links)
      .where(eq(links.targetPath, targetPhysical))
      .orderBy(asc(links.sourcePath), asc(links.position));

    const out: CrossOwnerLink[] = [];
    for (const r of rows) {
      const sourceOwner = r.sourcePath.split('/')[0] ?? '';
      const sourceLogical = stripOwnerPrefix(r.sourcePath, sourceOwner);
      if (!(await this.opts.sharing.canRead(viewerId, sourceOwner, sourceLogical))) continue;

      out.push({
        sourcePath: sourceLogical,
        targetPath: path,
        targetType: r.targetType as CrossOwnerLink['targetType'],
        linkKind: r.linkKind,
        alias: r.alias,
        section: r.section,
      });
    }
    return out;
  }
}

function stripOwnerPrefix(physicalPath: string, ownerId: string): string {
  const prefix = `${ownerId}/`;
  return physicalPath.startsWith(prefix) ? physicalPath.slice(prefix.length) : physicalPath;
}
