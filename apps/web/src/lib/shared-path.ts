// What a /notes/shared/<ownerId>/<...path> URL points at.
//
// The path is the note's place in its owner's vault, with the `.md` dropped the
// way every link to a note drops it. The one exception is a share's own folder,
// which is where an accepted invite lands.

import type { SharedRoot } from './shared-owners';

export interface SharedLocation<R extends SharedRoot> {
  /** The URL names a share's own folder, not a note inside it. */
  isFolder: boolean;
  /** The path as the server knows it: `.md` put back on a note. */
  path: string;
  /** The deepest grant covering the path, or null when none does. */
  shareRoot: R | null;
  /**
   * Folders above the note, starting at the shared folder: whatever sits above
   * it is not the reader's to see. Each carries its full path in the vault.
   */
  crumbs: Array<{ label: string; path: string }>;
}

export function resolveSharedPath<R extends SharedRoot>(
  urlPath: string,
  roots: readonly R[],
): SharedLocation<R> {
  const isFolder = roots.some((r) => r.folderPath === urlPath);
  const path = isFolder || /\.md$/i.test(urlPath) ? urlPath : `${urlPath}.md`;
  // The deepest, when the owner shared a folder and also one inside it.
  const shareRoot =
    roots
      .filter((r) => path === r.folderPath || path.startsWith(r.folderPath + '/'))
      .sort((a, b) => b.folderPath.length - a.folderPath.length)[0] ?? null;

  const folder = isFolder || !path.includes('/') ? '' : path.slice(0, path.lastIndexOf('/'));
  const rootAt = shareRoot ? shareRoot.folderPath.lastIndexOf('/') + 1 : 0;
  const crumbs =
    folder && shareRoot
      ? folder
          .slice(rootAt)
          .split('/')
          .map((label, i, all) => ({
            label,
            path: folder.slice(0, rootAt) + all.slice(0, i + 1).join('/'),
          }))
      : [];

  return { isFolder, path, shareRoot, crumbs };
}
