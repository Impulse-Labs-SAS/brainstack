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
  escapeLike,
  PgNoteAlreadyExistsError,
  PgNoteNotFoundError,
  PgNoteStore,
  pgSchema,
  toMarkdown,
  type Backlink,
  type Facet,
  type NoteSummary,
  type PgDb,
  type StoredNote,
} from '@brainstack/core/pg';
import {
  findMentions,
  linkMentions,
  mentionSnippet,
  mentionTerms,
  rewriteLinkTargets,
  type Frontmatter,
  type Mention,
  type MentionTerm,
  type NoteBodySource,
} from '@brainstack/core';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import matter from 'gray-matter';

import { AppError } from '../lib/errors.js';
import { toLogical, toPhysical } from '../lib/vault.js';

import {
  affinityEdges,
  buildTopics,
  type AffinityEdge,
  type Topic,
  type TopicRow,
} from './affinity.js';
import { resolveProjects, type ProjectRef } from './projects.js';
import {
  facetSignal,
  rankRelated,
  signalReason,
  type RelatedReason,
  RELATED_IGNORED_FACET_KEYS,
  tagSignal,
  type RankedNote,
} from './relatedNotes.js';

const { facets, folders, links, notes, tags } = pgSchema;

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

/**
 * What a move between two vaults did, and what it cost.
 *
 * A wikilink has no way to name another person's vault, so a link that crossed
 * the boundary cannot be rewritten — only reported. Both lists are the honest
 * accounting of that, in the logical terms of the vault each note now sits in.
 */
export interface CrossVaultMoveResult {
  path: string;
  movedNotes: number;
  /** Links inside what moved, now pointing at notes that stayed behind. */
  linksLeftDangling: Array<{ note: string; target: string }>;
  /** Notes that stayed behind, now pointing at what moved away. */
  linksNowBroken: Array<{ note: string; target: string }>;
}

/** A folder someone shared with the viewer, addressed in its owner's vault. */
export interface SharedScope {
  ownerId: string;
  folderPath: string;
}

export interface ListFilter {
  folder?: string;
  tag?: string;
  facet?: { key: string; value: string };
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

/** One note on the other side of an unlinked mention. */
export interface UnlinkedMention {
  path: string;
  title: string;
  /** The first mention, as the text wrote it. */
  text: string;
  count: number;
  /** Context around the first mention. */
  snippet: string;
}

function mentionCandidate(row: { path: string; title: string; frontmatter: unknown }) {
  const fm = (row.frontmatter ?? {}) as Frontmatter;
  return {
    target: row.path,
    title: row.title,
    aliases: Array.isArray(fm.aliases) ? fm.aliases : [],
  };
}

export interface NoteServiceOptions {
  db: PgDb;
  store?: PgNoteStore;
  /**
   * Called with a folder that has just stopped existing in `ownerId`'s vault,
   * deleted or moved into somebody else's.
   *
   * A callback rather than a `SharingService`, so this service keeps knowing
   * nothing about permission: it reports what happened to the vault, and the
   * wiring decides that what happens next is revoking the grants on it.
   */
  onFolderGone?: (ownerId: string, folderPath: string) => Promise<void>;
  /**
   * Called with a folder that has just been renamed or moved somewhere else in
   * `ownerId`'s own vault. Same reasoning as `onFolderGone`, opposite outcome:
   * the folder is still theirs, so what is shared on it should follow it.
   */
  onFolderMoved?: (ownerId: string, fromPath: string, toPath: string) => Promise<void>;
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

  private toPhysical(ownerId: string, logical: string): string {
    return toPhysical(ownerId, this.normalizeLogical(logical));
  }

  private toLogical(ownerId: string, physical: string): string {
    return toLogical(ownerId, physical);
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
    if (!ownerId) return physical;
    const prefix = `${ownerId}/`;
    return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
  }

  private normalizeLogical(path: string): string {
    return path.replace(/^[\\/]+/, '').replace(/\/+$/, '');
  }

  /** Matches every note owned by this user, by its path prefix. */
  private ownedBy(ownerId: string) {
    return like(notes.path, `${escapeLike(ownerId)}/%`);
  }

  /** The same, for the folders table. */
  private foldersOwnedBy(ownerId: string) {
    return like(folders.path, `${escapeLike(ownerId)}/%`);
  }

  /**
   * The viewer's own notes plus the folders shared with them, as SQL. It only
   * narrows what Postgres returns; `inScope` is what decides what is shown.
   */
  private scopeWhere(ownerId: string, sharedScopes: SharedScope[] = []) {
    const scopes = [this.ownedBy(ownerId)];
    for (const s of sharedScopes) {
      scopes.push(like(notes.path, `${escapeLike(`${s.ownerId}/${s.folderPath}`)}/%`));
    }
    return scopes.length === 1 ? scopes[0] : or(...scopes);
  }

  /**
   * The same scope, over stored paths in memory. Share paths are matched here
   * rather than trusted to a `LIKE`: a pattern that widens by accident is a
   * note shown to someone it was never shared with.
   */
  private inScope(
    ownerId: string,
    sharedScopes: SharedScope[] = [],
  ): (physical: string) => boolean {
    const prefixes = [ownerId, ...sharedScopes.map((s) => `${s.ownerId}/${s.folderPath}`)].map(
      (p) => `${p}/`,
    );
    return (physical) => prefixes.some((prefix) => physical.startsWith(prefix));
  }

  // -- Reads -----------------------------------------------------------------

  /**
   * Is there anything at this path in this vault — a note, or a folder?
   *
   * Asked before a read whose caller named no owner: a path that is not here
   * may well be one somebody shared, and the answer decides which vault the
   * read means. Matched in memory rather than with `LIKE`, for the same reason
   * share paths are: a folder name may contain `%` or `_`.
   */
  async exists(ownerId: string, path: string): Promise<boolean> {
    const target = this.normalizeLogical(path);
    if (!target) return true; // the root of your own vault is always yours

    const [noteRows, folderRows] = await Promise.all([
      this.opts.db.select({ path: notes.path }).from(notes).where(this.ownedBy(ownerId)),
      this.opts.db.select({ path: folders.path }).from(folders).where(this.foldersOwnedBy(ownerId)),
    ]);

    return (
      [...noteRows, ...folderRows]
        .map((r) => this.toLogical(ownerId, r.path))
        // A folder holding notes has no row of its own; the notes under it imply
        // it, exactly as they do for the tree.
        .some((p) => p === target || p.startsWith(`${target}/`))
    );
  }

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
    // Every stored path starts with its owner, so the owner's id is the root of
    // their vault.
    const folder = filter.folder ? this.toPhysical(ownerId, filter.folder) : ownerId;
    const rows = await this.store.list({
      folder,
      ...(filter.tag ? { tag: filter.tag } : {}),
      ...(filter.facet ? { facet: filter.facet } : {}),
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

  /** Every link `path` points at — the mirror of `listLinks`. */
  async listOutboundLinks(ownerId: string, path: string): Promise<Backlink[]> {
    const rows = await this.store.listOutboundLinks(this.toPhysical(ownerId, path));
    return rows.map((r) => ({
      ...r,
      sourcePath: this.toLogical(ownerId, r.sourcePath),
      targetPath: this.toLogicalIfMine(ownerId, r.targetPath),
    }));
  }

  async listFacetsForNote(ownerId: string, path: string): Promise<Facet[]> {
    return this.store.listFacetsForNote(this.toPhysical(ownerId, path));
  }

  async listFacets(
    ownerId: string,
    key?: string,
  ): Promise<{ key: string; value: string; count: number }[]> {
    const rows = await this.opts.db
      .select({ key: facets.key, value: facets.value, count: sql<number>`count(*)::int` })
      .from(facets)
      .innerJoin(notes, eq(notes.path, facets.notePath))
      .where(and(this.ownedBy(ownerId), key ? eq(facets.key, key) : undefined))
      .groupBy(facets.key, facets.value)
      .orderBy(sql`count(*) desc`);
    return rows.map((r) => ({ key: r.key, value: r.value, count: Number(r.count) }));
  }

  /**
   * Other notes sharing a tag or facet with `path`, ranked by how rare the
   * shared signal is — two notes sharing a tag only they use outrank two that
   * merely share a technology half the vault happens to use.
   *
   * Scoped like `graph()`: the caller's own notes plus whatever folders were
   * shared with them, since "related" only means something over notes the
   * viewer can actually open.
   */
  async listRelated(
    ownerId: string,
    path: string,
    opts: { sharedScopes?: SharedScope[]; limit?: number } = {},
  ): Promise<
    Array<{
      path: string;
      title: string;
      ownerId: string | null;
      score: number;
      /** What the two notes share, rarest first. */
      reasons: RelatedReason[];
    }>
  > {
    const physical = this.toPhysical(ownerId, path);
    const limit = opts.limit ?? 10;

    const [targetTags, allTargetFacets] = await Promise.all([
      this.opts.db.select({ tag: tags.tag }).from(tags).where(eq(tags.notePath, physical)),
      this.opts.db
        .select({ key: facets.key, value: facets.value })
        .from(facets)
        .where(eq(facets.notePath, physical)),
    ]);
    const targetFacets = allTargetFacets.filter((f) => !RELATED_IGNORED_FACET_KEYS.has(f.key));
    const tagSignals = targetTags.map((t) => tagSignal(t.tag));
    const facetSignals = targetFacets.map((f) => facetSignal(f.key, f.value));
    if (tagSignals.length === 0 && facetSignals.length === 0) return [];

    const scopeWhere = this.scopeWhere(ownerId, opts.sharedScopes);
    const inScope = this.inScope(ownerId, opts.sharedScopes);

    // Vault-wide rarity, independent of the viewer's scope: a signal's weight
    // is what it costs to share it with anyone, not just with what this
    // viewer happens to be allowed to see.
    const [tagCounts, facetCounts] = await Promise.all([
      tagSignals.length
        ? this.opts.db
            .select({ tag: tags.tag, count: sql<number>`count(*)::int` })
            .from(tags)
            .where(
              inArray(
                tags.tag,
                targetTags.map((t) => t.tag),
              ),
            )
            .groupBy(tags.tag)
        : [],
      facetSignals.length
        ? this.opts.db
            .select({ key: facets.key, value: facets.value, count: sql<number>`count(*)::int` })
            .from(facets)
            .where(
              or(...targetFacets.map((f) => and(eq(facets.key, f.key), eq(facets.value, f.value)))),
            )
            .groupBy(facets.key, facets.value)
        : [],
    ]);
    const counts = [
      ...tagCounts.map((c) => ({ signal: tagSignal(c.tag), count: Number(c.count) })),
      ...facetCounts.map((c) => ({
        signal: facetSignal(c.key, c.value),
        count: Number(c.count),
      })),
    ];

    const [tagHitRows, facetHitRows] = await Promise.all([
      tagSignals.length
        ? this.opts.db
            .select({ path: notes.path, tag: tags.tag })
            .from(tags)
            .innerJoin(notes, eq(notes.path, tags.notePath))
            .where(
              and(
                scopeWhere,
                inArray(
                  tags.tag,
                  targetTags.map((t) => t.tag),
                ),
                sql`${notes.path} != ${physical}`,
              ),
            )
        : [],
      facetSignals.length
        ? this.opts.db
            .select({ path: notes.path, key: facets.key, value: facets.value })
            .from(facets)
            .innerJoin(notes, eq(notes.path, facets.notePath))
            .where(
              and(
                scopeWhere,
                or(
                  ...targetFacets.map((f) => and(eq(facets.key, f.key), eq(facets.value, f.value))),
                ),
                sql`${notes.path} != ${physical}`,
              ),
            )
        : [],
    ]);
    const hits = [
      ...tagHitRows.map((r) => ({ path: r.path, signal: tagSignal(r.tag) })),
      ...facetHitRows.map((r) => ({ path: r.path, signal: facetSignal(r.key, r.value) })),
    ].filter((h) => inScope(h.path));

    const ranked: RankedNote[] = rankRelated(hits, counts, limit);
    if (ranked.length === 0) return [];

    const winners = await this.opts.db
      .select({ path: notes.path, title: notes.title, ownerId: notes.ownerId })
      .from(notes)
      .where(
        inArray(
          notes.path,
          ranked.map((r) => r.path),
        ),
      );
    const byPath = new Map(winners.map((w) => [w.path, w]));

    return ranked
      .map((r) => {
        const note = byPath.get(r.path);
        if (!note) return null;
        return {
          path: this.stripOwner(note.path, note.ownerId),
          title: note.title,
          ownerId: note.ownerId ?? null,
          score: r.score,
          reasons: r.signals
            .map(signalReason)
            .filter((reason): reason is RelatedReason => reason !== null),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
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
      .where(and(this.ownedBy(ownerId), like(notes.path, `${escapeLike(physical)}/%`)));

    if (under.length > 0) {
      await this.store.removeMany(under.map((r) => r.path));
    }

    // The folder rows go with it: the folder itself and everything nested.
    const removedFolders = await this.opts.db
      .delete(folders)
      .where(
        and(
          this.foldersOwnedBy(ownerId),
          or(eq(folders.path, physical), like(folders.path, `${escapeLike(physical)}/%`)),
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

    // A folder was here and is not any more, so nothing should still be shared
    // on it. Skipped when only a note went: a note is not a grant's subject.
    if (removedFolders.length > 0) {
      await this.opts.onFolderGone?.(ownerId, this.toLogical(ownerId, physical));
    }
  }

  /**
   * Move or rename a note, or a whole folder.
   *
   * The store moves one note — it reads, writes at the new key and deletes the
   * old — so a folder was reaching it as a path that does not end in `.md` and
   * failing on that, even though both the MCP tool and the drag-and-drop tree
   * offered folder moves. A folder here is expanded into the notes under it and
   * moved one by one.
   *
   * Every wikilink pointing at anything that moved is rewritten in a single
   * pass, with one mapping per note, rather than a pass per note.
   */
  async move(ownerId: string, fromPath: string, toPath: string): Promise<MutationResult> {
    const from = this.toPhysical(ownerId, fromPath);
    const to = this.toPhysical(ownerId, toPath);
    if (from === to) {
      return { path: this.toLogical(ownerId, to), affectedMocs: [] };
    }
    // A folder cannot be moved inside itself: the destination would be carried
    // along by the very move that is creating it.
    if (to.startsWith(`${from}/`)) {
      throw new AppError("can't move a folder inside itself", 'INVALID_INPUT', 400);
    }

    const [asNote] = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(eq(notes.path, from))
      .limit(1);

    if (asNote) {
      const saved = await this.asCaller(ownerId, () => this.store.move(from, to));
      // Logical, not physical: a wikilink says `[[Gondor/nota]]`, never
      // `[[u_42/Gondor/nota]]`. Passing the stored path meant only a changed
      // basename ever matched, and moving a note between folders left every
      // full-path link pointing at where it used to be.
      await rewriteLinkTargets(this.bodySource(ownerId), [
        { from: this.toLogical(ownerId, from), to: this.toLogical(ownerId, to) },
      ]);
      const logical = this.toLogical(ownerId, saved.path);
      return { path: logical, affectedMocs: await this.mocsFor(ownerId, logical) };
    }

    return this.moveFolder(ownerId, from, to);
  }

  /** The folder half of `move`. Assumes `from` is not a note. */
  private async moveFolder(ownerId: string, from: string, to: string): Promise<MutationResult> {
    const contents = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(and(this.ownedBy(ownerId), like(notes.path, `${escapeLike(from)}/%`)));

    const folderRows = await this.opts.db
      .select({ path: folders.path })
      .from(folders)
      .where(
        and(
          this.foldersOwnedBy(ownerId),
          or(eq(folders.path, from), like(folders.path, `${escapeLike(from)}/%`)),
        ),
      );

    if (contents.length === 0 && folderRows.length === 0) {
      throw new AppError(`not found: ${this.toLogical(ownerId, from)}`, 'NOT_FOUND', 404);
    }

    const mappings = contents.map((row) => ({
      from: row.path,
      to: `${to}${row.path.slice(from.length)}`,
    }));

    // Refuse before moving anything rather than halfway through: the store has
    // no transaction to roll back, so a collision found on note nine would
    // leave eight notes moved and the folder split across two places.
    const taken = mappings.length
      ? await this.opts.db
          .select({ path: notes.path })
          .from(notes)
          .where(
            inArray(
              notes.path,
              mappings.map((m) => m.to),
            ),
          )
      : [];
    if (taken.length > 0) {
      const names = taken.map((r) => this.toLogical(ownerId, r.path)).join(', ');
      throw new AppError(`already exists at the destination: ${names}`, 'ALREADY_EXISTS', 409);
    }

    for (const mapping of mappings) {
      await this.asCaller(ownerId, () => this.store.move(mapping.from, mapping.to));
    }

    // The folder rows follow their notes. Registered first so an empty folder
    // survives the move — it has no notes to imply it back into existence.
    const logicalTo = this.toLogical(ownerId, to);
    await this.ensureFolders(ownerId, logicalTo);
    for (const row of folderRows) {
      const moved = `${to}${row.path.slice(from.length)}`;
      await this.ensureFolders(ownerId, this.toLogical(ownerId, moved));
    }
    await this.opts.db
      .delete(folders)
      .where(
        and(
          this.foldersOwnedBy(ownerId),
          or(eq(folders.path, from), like(folders.path, `${escapeLike(from)}/%`)),
        ),
      );

    if (mappings.length > 0) {
      await rewriteLinkTargets(
        this.bodySource(ownerId),
        mappings.map((m) => ({
          from: this.toLogical(ownerId, m.from),
          to: this.toLogical(ownerId, m.to),
        })),
      );
    }

    // The folder is still this owner's, just somewhere else, so a grant on it
    // moves rather than dies. Without this a rename cut the recipient's access
    // without telling anybody and left the old name in their tree.
    await this.opts.onFolderMoved?.(
      ownerId,
      this.toLogical(ownerId, from),
      this.toLogical(ownerId, to),
    );

    return { path: logicalTo, affectedMocs: await this.mocsFor(ownerId, logicalTo) };
  }

  /**
   * Move a note or folder into somebody else's vault.
   *
   * The second method here that spans vaults, and it says so for the same
   * reason `graph` does: everything else on NoteService acts on exactly one.
   * Authorisation still belongs to the caller — this moves what it is told to.
   *
   * `move` cannot do this and should not: it resolves both ends against one
   * owner, which is what makes an ordinary move safe. Crossing is a different
   * operation with a cost `move` does not have, and the cost is links. A
   * wikilink says `[[Gondor/nota]]`; it has no way to say whose Gondor. So a
   * link that used to cross what is now a vault boundary cannot be rewritten
   * into something correct — it can only be reported. Both directions are:
   * links inside what moved that pointed at notes left behind, and notes left
   * behind that pointed at what moved.
   *
   * Nothing is silently repaired, and nothing is silently broken.
   */
  async moveAcrossVaults(params: {
    fromOwnerId: string;
    fromPath: string;
    toOwnerId: string;
    toPath: string;
  }): Promise<CrossVaultMoveResult> {
    const { fromOwnerId, toOwnerId } = params;
    if (fromOwnerId === toOwnerId) {
      throw new AppError('same owner: use move instead', 'INVALID_INPUT', 400);
    }

    const from = this.toPhysical(fromOwnerId, params.fromPath);
    const to = this.toPhysical(toOwnerId, params.toPath);

    // A note, or everything under a folder.
    const [asNote] = await this.opts.db
      .select({ path: notes.path })
      .from(notes)
      .where(eq(notes.path, from))
      .limit(1);

    const sources = asNote
      ? [from]
      : (
          await this.opts.db
            .select({ path: notes.path })
            .from(notes)
            .where(and(this.ownedBy(fromOwnerId), like(notes.path, `${escapeLike(from)}/%`)))
        ).map((r) => r.path);

    const folderRows = asNote
      ? []
      : await this.opts.db
          .select({ path: folders.path })
          .from(folders)
          .where(
            and(
              this.foldersOwnedBy(fromOwnerId),
              or(eq(folders.path, from), like(folders.path, `${escapeLike(from)}/%`)),
            ),
          );

    if (sources.length === 0 && folderRows.length === 0) {
      throw new AppError(`not found: ${this.toLogical(fromOwnerId, from)}`, 'NOT_FOUND', 404);
    }

    const destinationOf = (source: string): string =>
      asNote ? to : `${to}${source.slice(from.length)}`;

    const taken = sources.length
      ? await this.opts.db
          .select({ path: notes.path })
          .from(notes)
          .where(inArray(notes.path, sources.map(destinationOf)))
      : [];
    if (taken.length > 0) {
      const names = taken.map((r) => this.toLogical(toOwnerId, r.path)).join(', ');
      throw new AppError(`already exists at the destination: ${names}`, 'ALREADY_EXISTS', 409);
    }

    // Measured before the move, because afterwards the rows are gone: who was
    // pointing *into* what is about to leave.
    const movedSet = new Set(sources);
    const inbound = sources.length
      ? await this.opts.db
          .select({ sourcePath: links.sourcePath, targetPath: links.targetPath })
          .from(links)
          .where(inArray(links.targetPath, sources))
      : [];
    const linksNowBroken = inbound
      .filter((l) => !movedSet.has(l.sourcePath))
      .map((l) => ({
        note: this.toLogical(fromOwnerId, l.sourcePath),
        target: this.toLogical(fromOwnerId, l.targetPath),
      }));

    // Also before: links inside what moves that were already unresolved, so
    // the report blames the crossing for its own damage and nothing else.
    const alreadyDangling = new Set(
      sources.length
        ? (
            await this.opts.db
              .select({ sourcePath: links.sourcePath, targetPath: links.targetPath })
              .from(links)
              .where(and(inArray(links.sourcePath, sources), eq(links.targetType, 'unresolved')))
          ).map((l) => `${destinationOf(l.sourcePath)}\u0000${l.targetPath}`)
        : [],
    );

    // The crossing itself: written under the new owner, then dropped from the
    // old vault. Upsert rebuilds the link graph against the destination's
    // notes, which is what turns a link to something left behind into an
    // unresolved one.
    for (const source of sources) {
      const existing = await this.store.get(source);
      await this.store.upsert(destinationOf(source), toMarkdown(existing), toOwnerId);
      await this.store.remove(source);
    }

    const logicalTo = this.toLogical(toOwnerId, to);
    if (!asNote) {
      await this.ensureFolders(toOwnerId, logicalTo);
      for (const row of folderRows) {
        const moved = `${to}${row.path.slice(from.length)}`;
        await this.ensureFolders(toOwnerId, this.toLogical(toOwnerId, moved));
      }
      await this.opts.db
        .delete(folders)
        .where(
          and(
            this.foldersOwnedBy(fromOwnerId),
            or(eq(folders.path, from), like(folders.path, `${escapeLike(from)}/%`)),
          ),
        );

      // The folder is gone from the source vault, so the grants that pointed at
      // it go too. Without this the person it was shared with kept an empty
      // root in their tree that nothing could ever fill — which is exactly how
      // a share whose folder had been moved away looked.
      await this.opts.onFolderGone?.(fromOwnerId, this.toLogical(fromOwnerId, from));
    }

    const destinations = sources.map(destinationOf);
    const outbound = destinations.length
      ? await this.opts.db
          .select({ sourcePath: links.sourcePath, targetPath: links.targetPath })
          .from(links)
          .where(and(inArray(links.sourcePath, destinations), eq(links.targetType, 'unresolved')))
      : [];
    const linksLeftDangling = outbound
      .filter((l) => !alreadyDangling.has(`${l.sourcePath}\u0000${l.targetPath}`))
      .map((l) => ({
        note: this.toLogical(toOwnerId, l.sourcePath),
        target: l.targetPath,
      }));

    return {
      path: logicalTo,
      movedNotes: sources.length,
      linksLeftDangling,
      linksNowBroken,
    };
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
          ownerId,
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

  // -- Unlinked mentions -------------------------------------------------------

  /**
   * Where a note is named without being linked, both ways: other notes whose
   * text says its title or an alias (`incoming`), and titles of other notes
   * its own text says (`outgoing`). A pair already joined by a link is left
   * out — one link says the connection exists; the rest is prose.
   *
   * Own vault only, like `listRelated`. It reads every body in the vault, the
   * same "fine at personal-brain scale" trade the link resolver makes.
   */
  async unlinkedMentions(
    ownerId: string,
    path: string,
  ): Promise<{ incoming: UnlinkedMention[]; outgoing: UnlinkedMention[] }> {
    const physical = this.toPhysical(ownerId, path);
    const rows = await this.vaultForMentions(ownerId);
    const self = rows.find((r) => r.path === physical);
    if (!self) throw new PgNoteNotFoundError(this.toLogical(ownerId, physical));

    const linkRows = await this.opts.db
      .select({ source: links.sourcePath, target: links.targetPath })
      .from(links)
      .where(
        and(
          eq(links.targetType, 'note'),
          or(eq(links.sourcePath, physical), eq(links.targetPath, physical)),
        ),
      );
    const linked = new Set(linkRows.map((l) => `${l.source}\u0000${l.target}`));
    const isLinked = (from: string, to: string) => linked.has(`${from}\u0000${to}`);

    const terms = mentionTerms(rows.map(mentionCandidate));
    const titleOf = new Map(rows.map((r) => [r.path, r.title]));

    const summarise = (other: string, body: string, found: Mention[]): UnlinkedMention => ({
      path: this.toLogical(ownerId, other),
      title: titleOf.get(other) ?? other,
      text: found[0]!.text,
      count: found.length,
      snippet: mentionSnippet(body, found[0]!),
    });

    // Always matched against every term, then filtered: a shorter title inside
    // a longer one ("Atlas" in "Visión — Atlas") must lose that overlap, which
    // it cannot do if the longer term was never looked for.
    const byTarget = new Map<string, Mention[]>();
    for (const m of findMentions(self.body, terms)) {
      if (m.target === physical || isLinked(physical, m.target)) continue;
      const list = byTarget.get(m.target) ?? [];
      list.push(m);
      byTarget.set(m.target, list);
    }
    const outgoing = [...byTarget].map(([target, found]) => summarise(target, self.body, found));

    const incoming: UnlinkedMention[] = [];
    if (terms.some((t) => t.target === physical)) {
      for (const row of rows) {
        if (row.path === physical || isLinked(row.path, physical)) continue;
        const found = findMentions(row.body, terms).filter((m) => m.target === physical);
        if (found.length > 0) incoming.push(summarise(row.path, row.body, found));
      }
    }

    const byCount = (a: UnlinkedMention, b: UnlinkedMention) =>
      b.count - a.count || a.title.localeCompare(b.title);
    return { incoming: incoming.sort(byCount), outgoing: outgoing.sort(byCount) };
  }

  /**
   * Turn every unlinked mention of `targetPath` inside `sourcePath` into a
   * wikilink, keeping the text as written: `[[proyectos/atlas/_Atlas|Atlas]]`.
   * The link names the full path, so it resolves the same wherever it sits.
   * Returns how many were linked; zero leaves the note untouched.
   */
  async linkMentions(
    ownerId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<{ linked: number }> {
    const source = this.toPhysical(ownerId, sourcePath);
    const target = this.toPhysical(ownerId, targetPath);
    if (source === target) return { linked: 0 };

    const rows = await this.vaultForMentions(ownerId);
    const sourceRow = rows.find((r) => r.path === source);
    if (!sourceRow) throw new PgNoteNotFoundError(this.toLogical(ownerId, source));
    if (!rows.some((r) => r.path === target)) {
      throw new PgNoteNotFoundError(this.toLogical(ownerId, target));
    }

    // Every term in the vault, not the target's alone: a title another note
    // shares is ambiguous here exactly as it was when listed, and a longer
    // title containing this one keeps its text.
    const terms: MentionTerm[] = mentionTerms(rows.map(mentionCandidate));
    const linkTarget = this.toLogical(ownerId, target).replace(/\.md$/i, '');
    const result = linkMentions(sourceRow.body, target, linkTarget, terms);
    if (result.linked === 0) return { linked: 0 };

    await this.store.upsert(
      source,
      toMarkdown({ frontmatter: sourceRow.frontmatter, body: result.body }),
      ownerId,
    );
    return { linked: result.linked };
  }

  private async vaultForMentions(ownerId: string) {
    return this.opts.db
      .select({
        path: notes.path,
        title: notes.title,
        frontmatter: notes.frontmatter,
        body: notes.body,
      })
      .from(notes)
      .where(this.ownedBy(ownerId));
  }

  // -- Context crawl ---------------------------------------------------------
  //
  // The reads `gatherContext` is built from: the viewer's own vault and the
  // folders shared with them, which the caller gets from SharingService and
  // passes in. Paths go in and come out *stored* — owner-prefixed — because a
  // crawl reads several vaults at once and two of them may both hold
  // `plan.md`. Every row is re-checked in memory against those scopes before
  // it leaves: a crawl that followed a link out of a share would hand over a
  // body the grant was never checked against.

  /**
   * Every readable note's title and aliases, without the bodies — all a crawl
   * needs to find the notes a piece of text names, and cheap however large
   * notes get.
   */
  async mentionIndex(
    viewerId: string,
    sharedScopes: SharedScope[] = [],
  ): Promise<Array<{ path: string; title: string; aliases: unknown[] }>> {
    const inScope = this.inScope(viewerId, sharedScopes);
    const rows = await this.opts.db
      .select({ path: notes.path, title: notes.title, frontmatter: notes.frontmatter })
      .from(notes)
      .where(this.scopeWhere(viewerId, sharedScopes));
    return rows
      .filter((r) => inScope(r.path))
      .map((r) => {
        const c = mentionCandidate(r);
        return { path: c.target, title: c.title, aliases: c.aliases };
      });
  }

  /**
   * Every note-to-note link touching any of `paths`, in either direction,
   * with both ends readable: a link into a folder the viewer was not given
   * stays out, and a crawl must never be the thing that reveals one.
   */
  async linksTouching(
    viewerId: string,
    paths: readonly string[],
    sharedScopes: SharedScope[] = [],
  ): Promise<Array<{ source: string; target: string; position: number }>> {
    const inScope = this.inScope(viewerId, sharedScopes);
    const physical = paths.filter(inScope);
    if (physical.length === 0) return [];
    // One row per pair, at the first place the source writes the link: a note
    // that links twice to the same target means it from where it first did.
    const rows = await this.opts.db
      .select({
        source: links.sourcePath,
        target: links.targetPath,
        position: sql<number>`min(${links.position})`,
      })
      .from(links)
      .where(
        and(
          eq(links.targetType, 'note'),
          or(inArray(links.sourcePath, physical), inArray(links.targetPath, physical)),
        ),
      )
      .groupBy(links.sourcePath, links.targetPath);
    return rows
      .filter((r) => inScope(r.source) && inScope(r.target) && r.source !== r.target)
      .map((r) => ({ source: r.source, target: r.target, position: Number(r.position) }));
  }

  /**
   * Title, the first `bodyChars` of the body, and decision flag for each of
   * `paths` that exists and is readable — the same test `listDecisions`
   * applies: a `decisión`/`decision` tag or `status: decidido`.
   */
  async contextDigests(
    viewerId: string,
    paths: readonly string[],
    bodyChars: number,
    sharedScopes: SharedScope[] = [],
  ): Promise<Array<{ path: string; title: string; body: string; isDecision: boolean }>> {
    const inScope = this.inScope(viewerId, sharedScopes);
    const physical = paths.filter(inScope);
    if (physical.length === 0) return [];
    const [rows, decisionRows] = await Promise.all([
      this.opts.db
        .select({
          path: notes.path,
          title: notes.title,
          // Only the start: an excerpt never needs more.
          body: sql<string>`substring(${notes.body} from 1 for ${bodyChars})`,
        })
        .from(notes)
        .where(inArray(notes.path, physical)),
      this.opts.db
        .selectDistinct({ path: notes.path })
        .from(notes)
        .leftJoin(tags, eq(tags.notePath, notes.path))
        .leftJoin(
          facets,
          and(
            eq(facets.notePath, notes.path),
            eq(facets.key, 'status'),
            eq(facets.value, 'decidido'),
          ),
        )
        .where(
          and(
            inArray(notes.path, physical),
            or(inArray(tags.tag, ['decisión', 'decision']), sql`${facets.value} IS NOT NULL`),
          ),
        ),
    ]);
    const decisions = new Set(decisionRows.map((r) => r.path));
    return rows
      .filter((r) => inScope(r.path))
      .map((r) => ({
        path: r.path,
        title: r.title,
        body: r.body,
        isDecision: decisions.has(r.path),
      }));
  }

  // -- Graph -----------------------------------------------------------------

  /**
   * Topics shared across the owner's notes, and the note-to-note edges they
   * imply — what the graph draws when it shows affinity rather than links.
   *
   * Own vault only, like `listRelated`: reaching into shared folders needs the
   * same masking backlinks got, and has not had it. Paths come back stored,
   * matching the ids `graph` gives its nodes.
   */
  async affinity(ownerId: string): Promise<{ topics: Topic[]; edges: AffinityEdge[] }> {
    const owned = this.ownedBy(ownerId);
    const [tagRows, facetRows, [total]] = await Promise.all([
      this.opts.db
        .select({ path: tags.notePath, value: tags.tag })
        .from(tags)
        .innerJoin(notes, eq(notes.path, tags.notePath))
        .where(owned),
      this.opts.db
        .select({ path: facets.notePath, key: facets.key, value: facets.value })
        .from(facets)
        .innerJoin(notes, eq(notes.path, facets.notePath))
        .where(owned),
      this.opts.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(owned),
    ]);

    const rows: TopicRow[] = [
      ...tagRows.map((r) => ({ path: r.path, kind: 'tag' as const, value: r.value })),
      ...facetRows.map((r) => ({
        path: r.path,
        kind: 'facet' as const,
        key: r.key,
        value: r.value,
      })),
    ];
    const topics = buildTopics(rows, Number(total?.count ?? 0));
    return { topics, edges: affinityEdges(topics) };
  }

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
    opts: { sharedScopes?: SharedScope[] } = {},
  ): Promise<{
    nodes: Array<{
      id: string;
      path: string;
      title: string;
      ownerId: string | null;
      project: ProjectRef;
      /** Epoch ms. The graph replays growth by the first and lights up activity by the second. */
      createdAt: number;
      updatedAt: number;
    }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  }> {
    const where = this.scopeWhere(viewerId, opts.sharedScopes);
    const inScope = this.inScope(viewerId, opts.sharedScopes);

    const [scopedNodeRows, scopedTagRows] = await Promise.all([
      this.opts.db
        .select({
          path: notes.path,
          title: notes.title,
          ownerId: notes.ownerId,
          createdAt: notes.createdAt,
          updatedAt: notes.updatedAt,
        })
        .from(notes)
        .where(where),
      // Only what decides a project: the rest of the tags are affinity's job.
      this.opts.db
        .select({ path: tags.notePath, tag: tags.tag })
        .from(tags)
        .innerJoin(notes, eq(notes.path, tags.notePath))
        .where(and(where, like(tags.tag, 'proyecto/%'))),
    ]);
    const nodeRows = scopedNodeRows.filter((r) => inScope(r.path));
    const tagRows = scopedTagRows.filter((r) => inScope(r.path));
    const tagsByPath = new Map<string, string[]>();
    for (const row of tagRows) {
      const list = tagsByPath.get(row.path) ?? [];
      list.push(row.tag);
      tagsByPath.set(row.path, list);
    }
    const projects = resolveProjects(
      nodeRows.map((r) => ({
        id: r.path,
        path: this.stripOwner(r.path, r.ownerId),
        ownerId: r.ownerId ?? null,
        title: r.title,
        tags: tagsByPath.get(r.path) ?? [],
      })),
    );

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
        project: projects.get(r.path)!,
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
      })),
      // An edge to a note nobody can see would draw a line into nothing.
      edges: edgeRows
        .filter((e) => visible.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, weight: Number(e.weight) })),
    };
  }

  // -- Decisions -------------------------------------------------------------

  /**
   * Notes flagged as decisions, newest first. Feeds the decisions view.
   *
   * Matches either signal a note can carry: the `decisión`/`decision` tag, or
   * a `status: decidido` frontmatter facet — the tool description has always
   * promised both, but until facets existed only the tag was actually
   * checked.
   */
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
      .leftJoin(tags, eq(tags.notePath, notes.path))
      .leftJoin(
        facets,
        and(
          eq(facets.notePath, notes.path),
          eq(facets.key, 'status'),
          eq(facets.value, 'decidido'),
        ),
      )
      .where(
        and(
          this.ownedBy(ownerId),
          or(inArray(tags.tag, ['decisión', 'decision']), sql`${facets.value} IS NOT NULL`),
          ...(scope ? [like(notes.path, `${escapeLike(scope)}/%`)] : []),
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

    // A MOC is not its own index: `_ideas.md` created inside `ideas/` used to
    // come back listing itself, inviting a link from the note to the note.
    return found.map((r) => this.toLogical(ownerId, r.path)).filter((moc) => moc !== logicalPath);
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
