// Reading somebody else's notes, through a folder they shared.
//
// Separate from NoteService on purpose: NoteService acts for one user over
// their own vault and never needs to think about permission, while everything
// here crosses an ownership boundary and checks SharingService first.
//
// Paths in and out are relative to the owner's root, not the viewer's, because
// that is how a shared folder is addressed: "this path, in that person's brain".

import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { asc, eq, like } from 'drizzle-orm';

import { AppError } from '../lib/errors.js';
import { toPhysical, type VaultConfig } from '../lib/vault.js';

import { buildTree, type NoteRowDto, type TreeNode } from './NoteService.js';
import type { SharingService } from './SharingService.js';

const { links, notes } = pgSchema;

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
      throw new AppError('cross-owner reads no disponibles en self-host', 'FORBIDDEN', 403);
    }
  }

  async getNote(viewerId: string, ownerId: string, path: string): Promise<NoteRowDto> {
    this.requireEnabled();
    await this.opts.sharing.assertCanRead(viewerId, ownerId, path);

    const physical = toPhysical(ownerId, path, this.opts.vaultCfg);
    const [row] = await this.opts.db
      .select()
      .from(notes)
      .where(eq(notes.path, physical))
      .limit(1);

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
    const rows = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(like(notes.path, `${prefix}/%`));

    const ownerPrefix = `${ownerId}/`;
    const logical = rows.map((r) =>
      r.path.startsWith(ownerPrefix) ? r.path.slice(ownerPrefix.length) : r.path,
    );

    return buildTree(scope, logical, depth ?? DEFAULT_TREE_DEPTH);
  }

  /**
   * Outgoing links of a shared note, with targets the viewer cannot reach
   * reported as unresolved.
   *
   * That masking is the point: the link is real, but naming what it points at
   * would leak a path out of a folder nobody shared.
   */
  async linksForOwner(
    viewerId: string,
    ownerId: string,
    path: string,
  ): Promise<CrossOwnerLink[]> {
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
}

function stripOwnerPrefix(physicalPath: string, ownerId: string): string {
  const prefix = `${ownerId}/`;
  return physicalPath.startsWith(prefix) ? physicalPath.slice(prefix.length) : physicalPath;
}
