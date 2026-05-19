import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FolderNotEmptyError,
  NoteAlreadyExistsError,
  NoteNotFoundError,
  createFolder,
  deleteNote,
  deletePath,
  listNoteFiles,
  moveNote,
  movePath,
  readNote,
  writeNote,
} from './notes.js';
import { listAttachments, writeAttachment } from './attachments.js';
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

describe('createFolder', () => {
  it('creates nested folders idempotently', async () => {
    const p = await createFolder(root, 'Zuno/decisiones');
    expect(p).toBe('Zuno/decisiones');
    const stat = await fsp.stat(join(root, 'Zuno', 'decisiones'));
    expect(stat.isDirectory()).toBe(true);
    // second call should not throw
    await createFolder(root, 'Zuno/decisiones');
  });

  it('rejects path traversal', async () => {
    await expect(createFolder(root, '../escape')).rejects.toBeInstanceOf(PathTraversalError);
  });
});

describe('deletePath', () => {
  it('deletes a file', async () => {
    await writeNote(root, 'a.md', 'x');
    await deletePath(root, 'a.md');
    await expect(readNote(root, 'a.md')).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it('deletes an empty folder', async () => {
    await createFolder(root, 'empty');
    await deletePath(root, 'empty');
    await expect(fsp.stat(join(root, 'empty'))).rejects.toThrow();
  });

  it('refuses a non-empty folder without recursive', async () => {
    await writeNote(root, 'd/inside.md', 'hi');
    await expect(deletePath(root, 'd')).rejects.toBeInstanceOf(FolderNotEmptyError);
    // file still there
    expect((await readNote(root, 'd/inside.md')).content).toBe('hi');
  });

  it('deletes a non-empty folder recursively', async () => {
    await writeNote(root, 'd/inside.md', 'hi');
    await writeNote(root, 'd/sub/more.md', 'hi2');
    await deletePath(root, 'd', { recursive: true });
    await expect(fsp.stat(join(root, 'd'))).rejects.toThrow();
  });

  it('throws NoteNotFoundError on missing path', async () => {
    await expect(deletePath(root, 'nope')).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});

describe('movePath', () => {
  it('renames a file without forcing .md', async () => {
    await writeAttachment(root, 'Attachments/2026/05/a.pdf', new Uint8Array([1, 2, 3]));
    await movePath(root, 'Attachments/2026/05/a.pdf', 'Attachments/2026/05/b.pdf');
    const list = await listAttachments(root);
    expect(list.map((a) => a.path)).toEqual(['Attachments/2026/05/b.pdf']);
  });

  it('moves a folder with its contents', async () => {
    await writeNote(root, 'Zuno/decisiones/x.md', 'body');
    await writeNote(root, 'Zuno/decisiones/y.md', 'body2');
    await movePath(root, 'Zuno/decisiones', 'Zuno/decisiones-v2');
    expect((await readNote(root, 'Zuno/decisiones-v2/x.md')).content).toBe('body');
    expect((await readNote(root, 'Zuno/decisiones-v2/y.md')).content).toBe('body2');
  });

  it('refuses to overwrite by default', async () => {
    await writeNote(root, 'src.md', 'one');
    await writeNote(root, 'dst.md', 'two');
    await expect(movePath(root, 'src.md', 'dst.md')).rejects.toBeInstanceOf(
      NoteAlreadyExistsError,
    );
  });
});

describe('writeAttachment', () => {
  it('writes atomically under Attachments/ and is listable', async () => {
    const p = await writeAttachment(root, 'Attachments/2026/05/img.png', new Uint8Array([7, 7]));
    expect(p).toBe('Attachments/2026/05/img.png');
    const list = await listAttachments(root);
    expect(list.map((a) => a.path)).toEqual(['Attachments/2026/05/img.png']);
    // no stray tmp
    const files = await fsp.readdir(join(root, 'Attachments', '2026', '05'));
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('rejects paths outside Attachments/', async () => {
    await expect(
      writeAttachment(root, 'NotAttachments/x.png', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('rejects path traversal', async () => {
    await expect(
      writeAttachment(root, 'Attachments/../escape.png', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });
});

describe('toPosixPath', () => {
  it('normalises Windows separators and collapses slashes', () => {
    expect(toPosixPath('a\\b\\\\c')).toBe('a/b/c');
  });
});
