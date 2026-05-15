// Path traversal protection.
// Every user/agent-supplied path is funneled through `safeResolve` to guarantee
// it stays inside the configured root directory.

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

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
 * Resolve `userPath` under `root`. Throws `PathTraversalError` if the result
 * would escape the root (via `..`, an absolute path pointing elsewhere, or
 * platform-specific tricks).
 *
 * Returns the absolute resolved filesystem path. Use `toPosixPath` if you need
 * to canonicalise the relative-to-root path for storage.
 */
export function safeResolve(root: string, userPath: string): string {
  if (userPath == null) {
    throw new PathTraversalError('path is empty', String(userPath), root);
  }
  const trimmed = userPath.trim();
  if (trimmed === '') {
    throw new PathTraversalError('path is empty', userPath, root);
  }

  if (trimmed.includes('\0')) {
    throw new PathTraversalError('path contains a null byte', userPath, root);
  }

  const rootAbs = resolve(root);
  const candidate = isAbsolute(trimmed) ? normalize(trimmed) : resolve(rootAbs, trimmed);
  const rel = relative(rootAbs, candidate);

  if (rel === '') return candidate;
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PathTraversalError(
      `path escapes root: ${userPath}`,
      userPath,
      root,
    );
  }
  return candidate;
}

/**
 * Convert an absolute path back to a posix-style path relative to `root`.
 * Throws if `absPath` is not under `root` (defensive).
 */
export function relativeToRoot(root: string, absPath: string): string {
  const rootAbs = resolve(root);
  const rel = relative(rootAbs, resolve(absPath));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathTraversalError('path outside root', absPath, root);
  }
  return toPosixPath(rel);
}
