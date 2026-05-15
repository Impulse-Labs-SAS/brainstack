// Filesystem CRUD for note (.md) files under NOTES_DIR.
// All writes go through a tmp-file + rename to remain atomic across crashes.
// Every user-supplied path is funneled through `safeResolve`.

import {
  constants as fsConstants,
  promises as fsp,
  type Dirent,
  type Stats,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  PathTraversalError,
  relativeToRoot,
  safeResolve,
  toPosixPath,
} from './paths.js';

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

export interface ReadNoteResult {
  /** Posix path relative to root. */
  path: string;
  /** Raw file content (including frontmatter). */
  content: string;
  /** mtime in ms since epoch. */
  mtime: number;
}

export interface NoteRoot {
  readonly root: string;
}

function ensureMdSuffix(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(absPath: string): Promise<Stats | null> {
  try {
    return await fsp.stat(absPath);
  } catch {
    return null;
  }
}

/** Read a note file. Throws `NoteNotFoundError` if missing. */
export async function readNote(root: string, path: string): Promise<ReadNoteResult> {
  const normalised = ensureMdSuffix(toPosixPath(path));
  const abs = safeResolve(root, normalised);
  const stats = await statSafe(abs);
  if (!stats || !stats.isFile()) {
    throw new NoteNotFoundError(normalised);
  }
  const content = await fsp.readFile(abs, 'utf8');
  return { path: relativeToRoot(root, abs), content, mtime: stats.mtimeMs };
}

export interface WriteNoteOptions {
  /** Fail if the note already exists (default: false — write/replace). */
  failIfExists?: boolean;
}

/**
 * Write a note atomically: write to a sibling `.tmp-<rand>` file, fsync, then
 * rename over the destination. Returns the canonical posix path.
 */
export async function writeNote(
  root: string,
  path: string,
  content: string,
  options: WriteNoteOptions = {},
): Promise<string> {
  const normalised = ensureMdSuffix(toPosixPath(path));
  const abs = safeResolve(root, normalised);

  if (options.failIfExists && (await exists(abs))) {
    throw new NoteAlreadyExistsError(normalised);
  }

  await fsp.mkdir(dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = null;
    await fsp.rename(tmp, abs);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }

  return relativeToRoot(root, abs);
}

/** Delete a note file. Throws `NoteNotFoundError` if missing. */
export async function deleteNote(root: string, path: string): Promise<void> {
  const normalised = ensureMdSuffix(toPosixPath(path));
  const abs = safeResolve(root, normalised);
  try {
    await fsp.unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NoteNotFoundError(normalised);
    }
    throw err;
  }
}

/**
 * Move/rename a note. Creates destination directories as needed. Refuses to
 * overwrite an existing destination unless `overwrite` is true.
 */
export async function moveNote(
  root: string,
  fromPath: string,
  toPath: string,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const fromNorm = ensureMdSuffix(toPosixPath(fromPath));
  const toNorm = ensureMdSuffix(toPosixPath(toPath));
  const fromAbs = safeResolve(root, fromNorm);
  const toAbs = safeResolve(root, toNorm);

  const fromStats = await statSafe(fromAbs);
  if (!fromStats || !fromStats.isFile()) {
    throw new NoteNotFoundError(fromNorm);
  }
  if (!options.overwrite && (await exists(toAbs))) {
    throw new NoteAlreadyExistsError(toNorm);
  }

  await fsp.mkdir(dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return relativeToRoot(root, toAbs);
}

/** Walk NOTES_DIR and yield every `.md` file as a posix-style relative path. */
export async function listNoteFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden dirs/files
      const childAbs = join(dirAbs, entry.name);
      const childRel = dirRel === '' ? entry.name : `${dirRel}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'Attachments') continue;
        await walk(childAbs, childRel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(toPosixPath(childRel));
      }
    }
  }

  await walk(safeResolve(root, '.'), '');
  return out.sort();
}

export { PathTraversalError };
