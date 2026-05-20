// Chokidar-based filesystem watcher.
// Reacts to `.md` additions/changes/removals under NOTES_DIR and to attachment
// changes. Each event funnels through `reindexFile` / `removeFromIndex`, both
// of which already dedupe by checksum, so the watcher itself is idempotent.

import chokidar, { type FSWatcher } from 'chokidar';
import { relative } from 'node:path';

import type { BrainStackDatabase } from '../db/client.js';

import { reindexFile, removeFromIndex } from './bootstrap.js';
import { listAttachments } from '../fs/attachments.js';
import { safeResolve, toPosixPath } from '../fs/paths.js';

export interface WatcherHandle {
  /** Underlying chokidar instance, useful for tests. */
  readonly watcher: FSWatcher;
  /** Stop watching and release resources. */
  close(): Promise<void>;
}

export interface WatcherOptions {
  /** Override the underlying chokidar options. */
  chokidar?: Parameters<typeof chokidar.watch>[1];
  /** Called on every applied change (after dedupe). Useful for tests. */
  onChange?: (event: WatcherEvent) => void;
  /** Called on errors so the host can log via pino instead of swallowing. */
  onError?: (err: unknown) => void;
  /**
   * Devuelve el owner_id para un path físico absoluto. Si no se pasa,
   * los inserts dejan owner_id NULL (self-host). En hosted se cablea a
   * `ownerIdFromPhysicalPath(abs, cfg)` para derivar dueño del subdir.
   */
  deriveOwnerId?: (absolutePath: string) => string | null;
}

export type WatcherEvent =
  | { kind: 'note-upserted'; path: string }
  | { kind: 'note-removed'; path: string }
  | { kind: 'attachments-rescanned' };

/** Start watching NOTES_DIR for markdown and attachment changes. */
export function startWatcher(
  root: string,
  bs: BrainStackDatabase,
  options: WatcherOptions = {},
): WatcherHandle {
  const rootAbs = safeResolve(root, '.');

  const watcher = chokidar.watch(rootAbs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    ignored: (path: string) => {
      const base = path.split(/[\\/]/).pop() ?? '';
      // Skip dotfiles, our own atomic-write temp files, and the sqlite WAL/journal.
      return (
        base.startsWith('.') ||
        base.includes('.tmp-') ||
        base.endsWith('.db-journal') ||
        base.endsWith('.db-wal') ||
        base.endsWith('.db-shm')
      );
    },
    ...options.chokidar,
  });

  function isMarkdown(absPath: string): boolean {
    return absPath.toLowerCase().endsWith('.md');
  }

  function isAttachment(absPath: string): boolean {
    const rel = relative(rootAbs, absPath);
    if (rel.startsWith('..')) return false;
    // Cualquier archivo no-.md en el vault cuenta como attachment.
    return !absPath.toLowerCase().endsWith('.md');
  }

  function relPosix(absPath: string): string {
    return toPosixPath(relative(rootAbs, absPath));
  }

  async function rescanAttachments(): Promise<void> {
    const attachments = await listAttachments(root);
    const tx = bs.sqlite.transaction(() => {
      bs.sqlite.exec('DELETE FROM attachments');
      const insert = bs.sqlite.prepare(`
        INSERT INTO attachments (path, filename, mime_type, size_bytes, width, height, duration_s, created_at, owner_id)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `);
      for (const a of attachments) {
        const ownerId = options.deriveOwnerId
          ? options.deriveOwnerId(safeResolve(root, a.path))
          : null;
        insert.run(a.path, a.filename, guessMimeType(a.filename), a.sizeBytes, a.mtime, ownerId);
      }
    });
    tx();
    options.onChange?.({ kind: 'attachments-rescanned' });
  }

  function handleError(err: unknown): void {
    if (options.onError) options.onError(err);
  }

  watcher
    .on('add', (path: string) => {
      if (isMarkdown(path)) {
        reindexFile(root, bs, relPosix(path), { deriveOwnerId: options.deriveOwnerId })
          .then(() => options.onChange?.({ kind: 'note-upserted', path: relPosix(path) }))
          .catch(handleError);
      } else if (isAttachment(path)) {
        rescanAttachments().catch(handleError);
      }
    })
    .on('change', (path: string) => {
      if (isMarkdown(path)) {
        reindexFile(root, bs, relPosix(path), { deriveOwnerId: options.deriveOwnerId })
          .then((res) => {
            if (!res.skipped) {
              options.onChange?.({ kind: 'note-upserted', path: relPosix(path) });
            }
          })
          .catch(handleError);
      } else if (isAttachment(path)) {
        rescanAttachments().catch(handleError);
      }
    })
    .on('unlink', (path: string) => {
      if (isMarkdown(path)) {
        try {
          removeFromIndex(bs, relPosix(path));
          options.onChange?.({ kind: 'note-removed', path: relPosix(path) });
        } catch (err) {
          handleError(err);
        }
      } else if (isAttachment(path)) {
        rescanAttachments().catch(handleError);
      }
    })
    .on('error', handleError);

  return {
    watcher,
    async close(): Promise<void> {
      await watcher.close();
    },
  };
}

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
