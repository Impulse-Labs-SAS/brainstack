// Filesystem helpers for the Attachments/ tree.
// V1 only needs to enumerate existing attachments so the resolver can decide
// whether `![[img.png]]` resolves to a real file.

import { promises as fsp, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { safeResolve, toPosixPath } from './paths.js';

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
