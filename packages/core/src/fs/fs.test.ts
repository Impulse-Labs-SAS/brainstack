import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NoteAlreadyExistsError,
  NoteNotFoundError,
  deleteNote,
  listNoteFiles,
  moveNote,
  readNote,
  writeNote,
} from './notes.js';
import { PathTraversalError, safeResolve, toPosixPath } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'brain-fs-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('safeResolve', () => {
  it('resolves a normal path inside root', () => {
    const abs = safeResolve(root, 'Zuno/note.md');
    expect(abs).toContain('Zuno');
  });

  it('rejects parent traversal', () => {
    expect(() => safeResolve(root, '../escape.md')).toThrow(PathTraversalError);
  });

  it('rejects null bytes', () => {
    expect(() => safeResolve(root, 'ok\0.md')).toThrow(PathTraversalError);
  });

  it('rejects an absolute path outside root', () => {
    expect(() => safeResolve(root, '/tmp/foo.md')).toThrow(PathTraversalError);
  });
});

describe('atomic writeNote', () => {
  it('writes a new file and reads it back', async () => {
    await writeNote(root, 'a/b.md', 'hello');
    const result = await readNote(root, 'a/b.md');
    expect(result.content).toBe('hello');
    expect(result.path).toBe('a/b.md');
  });

  it('overwrites by default and fails if requested', async () => {
    await writeNote(root, 'x.md', 'one');
    await writeNote(root, 'x.md', 'two');
    expect((await readNote(root, 'x.md')).content).toBe('two');
    await expect(writeNote(root, 'x.md', 'three', { failIfExists: true })).rejects.toBeInstanceOf(
      NoteAlreadyExistsError,
    );
  });

  it('leaves no stray .tmp files after a successful write', async () => {
    await writeNote(root, 'clean.md', 'body');
    const files = await fsp.readdir(root);
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });
});

describe('deleteNote / moveNote', () => {
  it('deletes a note', async () => {
    await writeNote(root, 'gone.md', 'bye');
    await deleteNote(root, 'gone.md');
    await expect(readNote(root, 'gone.md')).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it('moves and creates target directories', async () => {
    await writeNote(root, 'src.md', 'body');
    await moveNote(root, 'src.md', 'deep/folder/dst.md');
    const result = await readNote(root, 'deep/folder/dst.md');
    expect(result.content).toBe('body');
  });
});

describe('listNoteFiles', () => {
  it('returns posix paths sorted, skipping hidden dirs and Attachments/', async () => {
    await writeNote(root, 'Zuno/a.md', '');
    await writeNote(root, 'BRUTUS/b.md', '');
    await fsp.mkdir(join(root, 'Attachments'), { recursive: true });
    await fsp.writeFile(join(root, 'Attachments', 'should-skip.md'), '');
    const files = await listNoteFiles(root);
    expect(files).toEqual(['BRUTUS/b.md', 'Zuno/a.md']);
  });
});

describe('toPosixPath', () => {
  it('normalises Windows separators and collapses slashes', () => {
    expect(toPosixPath('a\\b\\\\c')).toBe('a/b/c');
  });
});
