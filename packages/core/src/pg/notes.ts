// Note store backed by Postgres. This is the source of truth.
//
// `notes.body` holds the markdown exactly as written, minus the frontmatter
// block, which lives in its own jsonb column. Callers still get real markdown
// back — `toMarkdown` reserialises both halves so an MCP client sees the same
// `.md` it would have read off disk.
//
// Every write also rebuilds that note's rows in `links` and `tags`. That work
// used to belong to the indexer and the watcher; with no filesystem to watch,
// deriving it inline is both simpler and impossible to get out of sync.

import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import matter from 'gray-matter';

import { parseNote } from '../parser/index.js';
import { normalizeNoteKey, normalizeRelativePath } from '../paths.js';
import { resolveLinks } from '../resolver/wikilinks.js';
import type { Frontmatter, ParsedLink, ResolvedLink } from '../types.js';

import { links, notes, tags } from './schema.js';
import type { PgDb } from './client.js';

export class NoteNotFoundError extends Error {
  override readonly name = 'NoteNotFoundError';
  constructor(public readonly path: string) {
    super(`note not found: ${path}`);
  }
}

export class NoteAlreadyExistsError extends Error {
  override readonly name = 'NoteAlreadyExistsError';
  constructor(public readonly path: string) {
    super(`note already exists: ${path}`);
  }
}

export interface StoredNote {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  updatedAt: number;
  createdAt: number;
  checksum: string;
}

export interface NoteSummary {
  path: string;
  title: string;
  updatedAt: number;
}

export interface ListFilter {
  /** Restrict to notes under this folder prefix. */
  folder?: string;
  /** Restrict to notes carrying this tag. */
  tag?: string;
  /** Restrict by `frontmatter.status`. */
  status?: string;
  limit?: number;
}

export interface Backlink {
  sourcePath: string;
  targetPath: string;
  targetType: string;
  linkKind: string;
  alias: string | null;
  section: string | null;
}

/** Reserialise a stored note into the markdown a client expects to read. */
export function toMarkdown(note: Pick<StoredNote, 'frontmatter' | 'body'>): string {
  const hasFrontmatter = Object.keys(note.frontmatter ?? {}).length > 0;
  return hasFrontmatter ? matter.stringify(note.body, note.frontmatter) : note.body;
}

/**
 * Every column of `notes` except the generated search vector, which is large,
 * is never read by name, and would otherwise ride along on every read now that
 * the schema declares it.
 */
const NOTE_COLUMNS = {
  path: notes.path,
  title: notes.title,
  frontmatter: notes.frontmatter,
  body: notes.body,
  updatedAt: notes.updatedAt,
  createdAt: notes.createdAt,
  checksum: notes.checksum,
  ownerId: notes.ownerId,
} as const;

export class PgNoteStore {
  constructor(private readonly db: PgDb) {}

  async get(path: string): Promise<StoredNote> {
    const key = normalizeNoteKey(path);
    const [row] = await this.db
      .select(NOTE_COLUMNS)
      .from(notes)
      .where(eq(notes.path, key))
      .limit(1);
    if (!row) throw new NoteNotFoundError(key);
    return row as StoredNote;
  }

  async exists(path: string): Promise<boolean> {
    const key = normalizeNoteKey(path);
    const [row] = await this.db
      .select({ path: notes.path })
      .from(notes)
      .where(eq(notes.path, key))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Create a note. Fails if the path is taken — callers meaning "create or
   * replace" should use `upsert`.
   */
  async create(path: string, rawMarkdown: string, ownerId?: string): Promise<StoredNote> {
    const key = normalizeNoteKey(path);
    if (await this.exists(key)) throw new NoteAlreadyExistsError(key);
    return this.upsert(key, rawMarkdown, ownerId);
  }

  /**
   * Insert or replace a note, then rebuild its links and tags.
   *
   * Idempotent by checksum: rewriting identical content leaves `updated_at`
   * untouched, which preserves the property the old watcher gave us for free.
   */
  async upsert(path: string, rawMarkdown: string, ownerId?: string): Promise<StoredNote> {
    const key = normalizeNoteKey(path);
    const parsed = parseNote(rawMarkdown, { path: key });
    const now = Date.now();

    const [row] = await this.db
      .insert(notes)
      .values({
        path: key,
        title: parsed.title,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        checksum: parsed.checksum,
        createdAt: now,
        updatedAt: now,
        ownerId: ownerId ?? null,
      })
      .onConflictDoUpdate({
        target: notes.path,
        set: {
          title: sql`excluded.title`,
          frontmatter: sql`excluded.frontmatter`,
          body: sql`excluded.body`,
          checksum: sql`excluded.checksum`,
          // Only bump the timestamp when the content actually changed.
          updatedAt: sql`CASE WHEN ${notes.checksum} = excluded.checksum
                              THEN ${notes.updatedAt} ELSE excluded.updated_at END`,
          // An update never reassigns ownership; it only fills it in when the
          // row predates owners and the caller knows who it belongs to.
          ownerId: sql`COALESCE(${notes.ownerId}, excluded.owner_id)`,
        },
      })
      /*
       * `xmax = 0` is true only on the row this statement inserted. ON CONFLICT
       * gives no other way to tell an insert from an update, and the difference
       * matters below: only a note that did not exist a moment ago can settle
       * links that were waiting for it.
       */
      .returning({ ...NOTE_COLUMNS, inserted: sql<boolean>`(xmax = 0)` });

    await this.rebuildGraph(key, parsed.links, parsed.tags, ownerId);
    if (row?.inserted) await this.resolvePendingLinksTo(key);

    const { inserted: _inserted, ...stored } = row!;
    return stored as StoredNote;
  }

  /**
   * Reconnect the links that were pointing at this note before it existed.
   *
   * Links are resolved when the note holding them is written, and a target that
   * is not there yet is recorded as `unresolved` — then nothing looks at it
   * again. That is backwards for the way anyone actually writes: you type
   * `[[ideas]]` first and create `ideas.md` afterwards, and the backlink never
   * appears. Found by hand: two notes, one link, an empty panel.
   *
   * Only the notes that could plausibly match are re-resolved, not the whole
   * vault. A pending target is stored either as the full path the author wrote
   * (`proyectos/ideas.md`) or as a bare filename (`ideas.md`) — those are the
   * only two shapes `resolveNote` leaves behind, so those are the two to look
   * for. Whether a candidate really resolves now is decided by rebuilding it,
   * which runs the same ladder as an ordinary write.
   *
   * The reverse case — a new note making an already-resolved link ambiguous —
   * is left alone: rewriting a link that currently works is worse than leaving
   * it pointing where its author last saw it go.
   */
  private async resolvePendingLinksTo(path: string): Promise<void> {
    const [target] = await this.db
      .select({ ownerId: notes.ownerId })
      .from(notes)
      .where(eq(notes.path, path))
      .limit(1);
    if (!target) return;

    const prefix = target.ownerId ? `${target.ownerId}/` : '';
    const logical = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const filename = logical.slice(logical.lastIndexOf('/') + 1);

    // Scoped to the same owner: a pending link in someone else's vault is not
    // waiting for this note, and rebuilding it would resolve nothing.
    const candidates = await this.db
      .selectDistinct({ sourcePath: links.sourcePath })
      .from(links)
      .innerJoin(notes, eq(notes.path, links.sourcePath))
      .where(
        and(
          eq(links.targetType, 'unresolved'),
          or(eq(links.targetPath, logical), eq(links.targetPath, filename)),
          sql`${notes.ownerId} IS NOT DISTINCT FROM ${target.ownerId}`,
        ),
      );

    for (const { sourcePath } of candidates) {
      if (sourcePath === path) continue;
      const [source] = await this.db
        .select({ body: notes.body, frontmatter: notes.frontmatter })
        .from(notes)
        .where(eq(notes.path, sourcePath))
        .limit(1);
      if (!source) continue;
      const parsed = parseNote(toMarkdown(source as Pick<StoredNote, 'frontmatter' | 'body'>), {
        path: sourcePath,
      });
      await this.rebuildGraph(sourcePath, parsed.links, parsed.tags, target.ownerId ?? undefined);
    }
  }

  async remove(path: string): Promise<void> {
    const key = normalizeNoteKey(path);
    // links/tags cascade on the foreign key — that clears this note's own
    // outgoing rows. It says nothing about everybody else's: `target_path` is
    // plain text, not a foreign key (a target may not exist yet), so a note
    // that pointed at this one keeps a `links` row claiming `targetType:
    // 'note'` until it is next resaved. Flip those first, while the row we are
    // about to delete can still tell us which links pointed at it — a broken
    // link should show as broken the moment the note it named is gone, not
    // whenever its author happens to rewrite something else.
    await this.db
      .update(links)
      .set({ targetType: 'unresolved' })
      .where(and(eq(links.targetPath, key), sql`${links.targetType} != 'unresolved'`));

    const deleted = await this.db
      .delete(notes)
      .where(eq(notes.path, key))
      .returning({ path: notes.path });
    if (deleted.length === 0) throw new NoteNotFoundError(key);
  }

  /** Move a note, rewriting its derived rows under the new path. */
  async move(fromPath: string, toPath: string): Promise<StoredNote> {
    const from = normalizeNoteKey(fromPath);
    const to = normalizeNoteKey(toPath);
    if (from === to) return this.get(from);
    if (await this.exists(to)) throw new NoteAlreadyExistsError(to);

    const existing = await this.get(from);
    const saved = await this.upsert(to, toMarkdown(existing));
    await this.remove(from);
    return saved;
  }

  async list(filter: ListFilter = {}): Promise<NoteSummary[]> {
    const limit = Math.min(filter.limit ?? 200, 500);
    const conditions = [];

    if (filter.folder) {
      const prefix = normalizeRelativePath(filter.folder).replace(/\/+$/, '');
      conditions.push(like(notes.path, `${escapeLike(prefix)}/%`));
    }
    if (filter.status) {
      conditions.push(sql`${notes.frontmatter}->>'status' = ${filter.status}`);
    }
    if (filter.tag) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${tags} WHERE ${tags.notePath} = ${notes.path}
                    AND ${tags.tag} = ${filter.tag})`,
      );
    }

    return this.db
      .select({ path: notes.path, title: notes.title, updatedAt: notes.updatedAt })
      .from(notes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notes.updatedAt))
      .limit(limit);
  }

  /** Every link pointing at `path` — the backlinks panel and `list_links`. */
  async listBacklinks(path: string): Promise<Backlink[]> {
    const key = normalizeRelativePath(path);
    return this.db
      .select({
        sourcePath: links.sourcePath,
        targetPath: links.targetPath,
        targetType: links.targetType,
        linkKind: links.linkKind,
        alias: links.alias,
        section: links.section,
      })
      .from(links)
      .where(eq(links.targetPath, key))
      .orderBy(links.sourcePath, links.position);
  }

  /** Distinct tags in use, for autocomplete and "what tags exist?" questions. */
  async listTags(): Promise<{ tag: string; count: number }[]> {
    const rows = await this.db
      .select({ tag: tags.tag, count: sql<number>`count(*)::int` })
      .from(tags)
      .groupBy(tags.tag)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  /** Delete several notes at once. Used by the importer when pruning. */
  async removeMany(paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const keys = paths.map((p) => normalizeNoteKey(p));
    const deleted = await this.db
      .delete(notes)
      .where(inArray(notes.path, keys))
      .returning({ path: notes.path });
    return deleted.length;
  }

  /** Every note path in the brain. Used to resolve wikilinks. */
  private async allNotePaths(): Promise<Set<string>> {
    const rows = await this.db.select({ path: notes.path }).from(notes);
    return new Set(rows.map((r) => r.path));
  }

  /**
   * Replace the derived rows for one note.
   *
   * Wikilink resolution needs the full set of note paths, so this reads every
   * path on each write. Fine at personal-brain scale; if the brain ever grows
   * past that, resolve lazily at read time instead.
   */
  private async rebuildGraph(
    path: string,
    parsedLinks: readonly ParsedLink[],
    noteTags: readonly string[],
    ownerId?: string,
  ): Promise<void> {
    // A wikilink is written the way its author sees the path, which in a
    // multi-user database is not the way it is stored: `[[proyectos/b]]` in a
    // note kept at `alice/proyectos/a.md` means `alice/proyectos/b.md`. So the
    // resolving happens inside the owner's slice — index and source stripped of
    // the prefix on the way in, targets given it back on the way out.
    //
    // Without this, no link in a hosted database would ever resolve, and every
    // backlink panel would sit empty for reasons nothing would report.
    const prefix = ownerId && path.startsWith(`${ownerId}/`) ? `${ownerId}/` : '';
    const stored = await this.allNotePaths();
    const noteIndex = prefix
      ? new Set(
          [...stored].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)),
        )
      : stored;

    const { resolved } = resolveLinks(parsedLinks, {
      sourcePath: prefix ? path.slice(prefix.length) : path,
      noteIndex,
      // Attachments are not stored yet, so every non-note target stays
      // unresolved rather than being silently mislabelled.
      attachmentIndex: new Set<string>(),
    });

    const scoped = prefix
      ? resolved.map((link) => ({
          ...link,
          sourcePath: path,
          // An unresolved target names nothing that exists, so prefixing it
          // would invent a path.
          targetPath:
            link.targetType === 'unresolved' ? link.targetPath : `${prefix}${link.targetPath}`,
        }))
      : resolved;

    await this.db.delete(links).where(eq(links.sourcePath, path));
    if (scoped.length > 0) {
      await this.db.insert(links).values(dedupeLinks(scoped)).onConflictDoNothing();
    }

    await this.db.delete(tags).where(eq(tags.notePath, path));
    if (noteTags.length > 0) {
      await this.db
        .insert(tags)
        .values(noteTags.map((tag) => ({ notePath: path, tag })))
        .onConflictDoNothing();
    }
  }
}

/**
 * The links primary key is (source, target, position), but a malformed body can
 * yield two links at the same offset. Drop the duplicates rather than letting
 * the insert fail the whole write.
 */
function dedupeLinks(resolved: readonly ResolvedLink[]): ResolvedLink[] {
  const seen = new Set<string>();
  const out: ResolvedLink[] = [];
  for (const link of resolved) {
    const key = `${link.sourcePath} ${link.targetPath} ${link.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** Escape LIKE wildcards so a path containing `%` or `_` stays literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
