// Bootstrap and incremental indexer.
// Reads markdown from disk, parses, resolves links against the current index,
// and upserts everything in sqlite. Every upsert is wrapped in a transaction so
// the index never reaches an inconsistent state mid-update.

import { promises as fsp } from 'node:fs';

import type { BrainStackDatabase } from '../db/client.js';
import type { Frontmatter, ParsedNote, ResolvedLink } from '../types.js';

import { listAttachments } from '../fs/attachments.js';
import { listNoteFiles, readNote } from '../fs/notes.js';
import { parseNote } from '../parser/index.js';
import { resolveLinks, type ResolutionInputs } from '../resolver/wikilinks.js';
import { safeResolve } from '../fs/paths.js';

export interface BootstrapResult {
  notesScanned: number;
  notesIndexed: number;
  attachmentsIndexed: number;
  unresolvedLinks: number;
  ambiguousLinks: number;
}

export interface ReindexResult {
  /** True if the on-disk content matched the stored checksum and we skipped work. */
  skipped: boolean;
  unresolvedLinks: number;
  ambiguousLinks: number;
}

export interface IndexerOptions {
  /**
   * Devuelve el owner_id para un path físico absoluto. Si no se pasa,
   * todos los inserts dejan owner_id NULL (self-host). En hosted se
   * pasa `(abs) => ownerIdFromPhysicalPath(abs, cfg)`.
   */
  deriveOwnerId?: (absolutePath: string) => string | null;
}

/** Scan NOTES_DIR end-to-end and rebuild the sqlite cache. */
export async function bootstrapIndex(
  root: string,
  bs: BrainStackDatabase,
  opts: IndexerOptions = {},
): Promise<BootstrapResult> {
  const notePaths = await listNoteFiles(root);
  const attachments = await listAttachments(root);

  const noteIndex = new Set(notePaths);
  const attachmentIndex = new Set(attachments.map((a) => a.path));

  // Replace attachments table wholesale.
  const replaceAttachments = bs.sqlite.transaction(() => {
    bs.sqlite.exec('DELETE FROM attachments');
    const insert = bs.sqlite.prepare(`
      INSERT INTO attachments (path, filename, mime_type, size_bytes, width, height, duration_s, created_at, owner_id)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);
    for (const a of attachments) {
      const ownerId = opts.deriveOwnerId ? opts.deriveOwnerId(safeResolve(root, a.path)) : null;
      insert.run(a.path, a.filename, guessMimeType(a.filename), a.sizeBytes, a.mtime, ownerId);
    }
  });
  replaceAttachments();

  let unresolved = 0;
  let ambiguous = 0;
  let indexed = 0;

  for (const path of notePaths) {
    try {
      const { content, mtime } = await readNote(root, path);
      const parsed = parseNote(content, { path });
      const ownerId = opts.deriveOwnerId
        ? opts.deriveOwnerId(safeResolve(root, parsed.path))
        : null;
      const stats = upsertParsedNote(bs, parsed, mtime, ownerId, {
        noteIndex,
        attachmentIndex,
      });
      unresolved += stats.unresolved;
      ambiguous += stats.ambiguous;
      indexed++;
    } catch {
      // Skip unreadable file; bootstrap should never fail entirely.
    }
  }

  return {
    notesScanned: notePaths.length,
    notesIndexed: indexed,
    attachmentsIndexed: attachments.length,
    unresolvedLinks: unresolved,
    ambiguousLinks: ambiguous,
  };
}

/**
 * Reindex a single note. Skips work if the on-disk checksum matches what we
 * already have stored. Used by the watcher and by direct mutations.
 */
export async function reindexFile(
  root: string,
  bs: BrainStackDatabase,
  path: string,
  opts: IndexerOptions = {},
): Promise<ReindexResult> {
  const { content, mtime } = await readNote(root, path);
  const parsed = parseNote(content, { path });

  const existing = bs.sqlite
    .prepare<[string], { checksum: string }>('SELECT checksum FROM notes WHERE path = ?')
    .get(path);
  if (existing && existing.checksum === parsed.checksum) {
    return { skipped: true, unresolvedLinks: 0, ambiguousLinks: 0 };
  }

  const noteRows = bs.sqlite
    .prepare<unknown[], { path: string }>('SELECT path FROM notes')
    .all();
  const noteIndex = new Set(noteRows.map((r) => r.path));
  // Make sure the file we just parsed is part of the index for self-references.
  noteIndex.add(parsed.path);

  const attRows = bs.sqlite
    .prepare<unknown[], { path: string }>('SELECT path FROM attachments')
    .all();
  const attachmentIndex = new Set(attRows.map((r) => r.path));

  const ownerId = opts.deriveOwnerId
    ? opts.deriveOwnerId(safeResolve(root, parsed.path))
    : null;
  const stats = upsertParsedNote(bs, parsed, mtime, ownerId, {
    noteIndex,
    attachmentIndex,
  });
  return {
    skipped: false,
    unresolvedLinks: stats.unresolved,
    ambiguousLinks: stats.ambiguous,
  };
}

/** Remove a note (and its derived links/tags) from the index. */
export function removeFromIndex(bs: BrainStackDatabase, path: string): void {
  const tx = bs.sqlite.transaction(() => {
    bs.sqlite.prepare('DELETE FROM links WHERE source_path = ?').run(path);
    bs.sqlite.prepare('DELETE FROM tags WHERE note_path = ?').run(path);
    bs.sqlite.prepare('DELETE FROM notes WHERE path = ?').run(path);
  });
  tx();
}

interface UpsertStats {
  unresolved: number;
  ambiguous: number;
}

function upsertParsedNote(
  bs: BrainStackDatabase,
  parsed: ParsedNote,
  mtime: number,
  ownerId: string | null,
  ctx: Omit<ResolutionInputs, 'sourcePath'>,
): UpsertStats {
  const { resolved, ambiguous } = resolveLinks(parsed.links, {
    ...ctx,
    sourcePath: parsed.path,
  });

  const tx = bs.sqlite.transaction(() => {
    bs.sqlite
      .prepare(
        `INSERT INTO notes (path, title, frontmatter, body, mtime, checksum, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET
           title = excluded.title,
           frontmatter = excluded.frontmatter,
           body = excluded.body,
           mtime = excluded.mtime,
           checksum = excluded.checksum,
           owner_id = excluded.owner_id`,
      )
      .run(
        parsed.path,
        parsed.title,
        JSON.stringify(parsed.frontmatter as Frontmatter),
        parsed.body,
        mtime,
        parsed.checksum,
        ownerId,
      );

    bs.sqlite.prepare('DELETE FROM links WHERE source_path = ?').run(parsed.path);
    if (resolved.length > 0) {
      const stmt = bs.sqlite.prepare(
        `INSERT OR IGNORE INTO links
         (source_path, target_path, target_type, link_kind, alias, section, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const link of resolved) {
        stmt.run(
          link.sourcePath,
          link.targetPath,
          link.targetType,
          link.linkKind,
          link.alias,
          link.section,
          link.position,
        );
      }
    }

    bs.sqlite.prepare('DELETE FROM tags WHERE note_path = ?').run(parsed.path);
    if (parsed.tags.length > 0) {
      const tagStmt = bs.sqlite.prepare(
        'INSERT OR IGNORE INTO tags (note_path, tag) VALUES (?, ?)',
      );
      for (const tag of parsed.tags) tagStmt.run(parsed.path, tag);
    }
  });
  tx();

  return {
    unresolved: countUnresolved(resolved),
    ambiguous: ambiguous.length,
  };
}

function countUnresolved(links: readonly ResolvedLink[]): number {
  let n = 0;
  for (const link of links) if (link.targetType === 'unresolved') n++;
  return n;
}

// --- Helpers -----------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  md: 'text/markdown',
  txt: 'text/plain',
};

function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

// Re-export so callers don't have to chase imports for ergonomic checks.
export async function ensureRootExists(root: string): Promise<void> {
  await fsp.mkdir(safeResolve(root, '.'), { recursive: true });
}
