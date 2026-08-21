// Path normalisation and traversal protection.
//
// Pure string logic with no `node:path` and no filesystem: it is imported by the
// Postgres store, which runs in serverless environments where there is no disk
// to resolve against. The filesystem store layers its own `safeResolve` on top.

export class PathTraversalError extends Error {
  override readonly name = 'PathTraversalError';
  constructor(
    message: string,
    public readonly attemptedPath: string,
    public readonly root: string,
  ) {
    super(message);
  }
}

const FORWARD_SLASH = '/';

/**
 * Normalise a path so it is always:
 * - forward-slash separated
 * - free of leading `./`
 * - without trailing slashes (except for the empty root)
 */
export function toPosixPath(p: string): string {
  const replaced = p.replace(/\\/g, FORWARD_SLASH);
  let normalised = replaced.replace(/\/+/g, FORWARD_SLASH);
  if (normalised.startsWith('./')) normalised = normalised.slice(2);
  if (normalised.length > 1 && normalised.endsWith(FORWARD_SLASH)) {
    normalised = normalised.slice(0, -1);
  }
  return normalised;
}

/**
 * Normalise and validate a note key (the `path` column, and the identity of a
 * note everywhere else).
 *
 * Guarantees the result is forward-slash separated, relative, free of `..`
 * segments and null bytes, and ends in `.md`. Throws `PathTraversalError`
 * otherwise, so callers can map it to a 400 uniformly.
 */
export function normalizeNoteKey(userPath: string): string {
  const posix = normalizeRelativePath(userPath);
  if (!posix.toLowerCase().endsWith('.md')) {
    throw new PathTraversalError(`path must end in .md: ${userPath}`, userPath, '');
  }
  return posix;
}

/**
 * The same checks minus the `.md` requirement, for folder prefixes and
 * attachment paths.
 */
export function normalizeRelativePath(userPath: string): string {
  if (userPath == null) {
    throw new PathTraversalError('path is empty', String(userPath), '');
  }
  const trimmed = userPath.trim();
  if (trimmed === '') {
    throw new PathTraversalError('path is empty', userPath, '');
  }
  if (trimmed.includes('\0')) {
    throw new PathTraversalError('path contains a null byte', userPath, '');
  }

  const posix = toPosixPath(trimmed);
  if (posix.startsWith('/')) {
    throw new PathTraversalError(`path must be relative: ${userPath}`, userPath, '');
  }
  if (posix.split('/').includes('..')) {
    throw new PathTraversalError(`path escapes root: ${userPath}`, userPath, '');
  }
  return posix;
}
