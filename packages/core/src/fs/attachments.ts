// Filesystem helpers for the Attachments/ tree.
// V1 only needs to enumerate existing attachments so the resolver can decide
// whether `![[img.png]]` resolves to a real file.

import { promises as fsp, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PathTraversalError, relativeToRoot, safeResolve, toPosixPath } from './paths.js';

export const ATTACHMENTS_DIR = 'Attachments';

export interface AttachmentInfo {
  /** Posix path relative to NOTES_DIR (always starts with `Attachments/`). */
  path: string;
  filename: string;
  sizeBytes: number;
  mtime: number;
}

/** Enumerate every file under `Attachments/` as posix paths relative to root. */
export async function listAttachments(root: string): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  const attachmentsAbs = safeResolve(root, ATTACHMENTS_DIR);

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = join(dirAbs, entry.name);
      const childRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const stats = await fsp.stat(childAbs).catch(() => null);
        if (!stats) continue;
        out.push({
          path: toPosixPath(`${ATTACHMENTS_DIR}/${childRel}`),
          filename: entry.name,
          sizeBytes: stats.size,
          mtime: stats.mtimeMs,
        });
      }
    }
  }

  await walk(attachmentsAbs, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Resolve a path that must live under `Attachments/`. Returns `{ abs, canonical }`
 * where `canonical` is the posix path relative to root. Throws
 * `PathTraversalError` if the path tries to escape `Attachments/` (either via
 * traversal or by being elsewhere in the tree entirely).
 */
function resolveAttachmentPath(root: string, path: string): { abs: string; canonical: string } {
  const norm = toPosixPath(path);
  const abs = safeResolve(root, norm);
  const canonical = relativeToRoot(root, abs);
  if (!canonical.startsWith(`${ATTACHMENTS_DIR}/`)) {
    throw new PathTraversalError(
      `attachment path must be under ${ATTACHMENTS_DIR}/`,
      path,
      root,
    );
  }
  return { abs, canonical };
}

/** Read an attachment's bytes + metadata. Throws if missing or outside `Attachments/`. */
export async function readAttachment(
  root: string,
  path: string,
): Promise<{ path: string; bytes: Buffer; sizeBytes: number; mtime: number }> {
  const { abs, canonical } = resolveAttachmentPath(root, path);
  const stats = await fsp.stat(abs).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`attachment not found: ${canonical}`);
  }
  const bytes = await fsp.readFile(abs);
  return { path: canonical, bytes, sizeBytes: stats.size, mtime: stats.mtimeMs };
}

/**
 * Atomically write an attachment under `Attachments/`. Refuses paths outside
 * that subtree (the resolver also blocks traversal, but this is the explicit
 * contract). Returns the canonical posix path relative to root.
 */
export async function writeAttachment(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<string> {
  const { abs } = resolveAttachmentPath(root, path);
  await fsp.mkdir(dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(bytes);
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = null;
    await fsp.rename(tmp, abs);
    // fsync the parent directory so the rename is durable on filesystems
    // (ext4 with data=ordered, etc.) where the inode update isn't otherwise
    // forced to disk by the rename alone. Best-effort on platforms (e.g. some
    // Windows configs) that don't allow opening a directory for fsync.
    const parent = await fsp.open(dirname(abs), 'r').catch(() => null);
    if (parent) {
      await parent.sync().catch(() => undefined);
      await parent.close().catch(() => undefined);
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }

  return relativeToRoot(root, abs);
}
