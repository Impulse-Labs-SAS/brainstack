// Droppable ids for folders inside "shared with me".
//
// The sidebar mixes two kinds of drop target in one DndContext: folders in your
// own tree, whose id is simply their path, and folders inside a folder somebody
// shared, which need to name an owner as well.
//
// The owner is carried as an index into the shared-roots array rather than
// spelled into the id. A folder name may contain anything — including whatever
// separator we might pick — so a composite id has no safe delimiter. An index
// does: it is digits, and the parse splits on the first colon after it, leaving
// the rest of the string to be the path, colons and all.
//
// Even so the parse can only *propose* a target. A folder in your own tree
// literally named `shared:0:x` would produce this shape by accident, so the
// caller checks the proposal against the share it names before acting on it.

export interface SharedDropTarget {
  /** Position in the shared-roots array the caller passed to the section. */
  index: number;
  /** Folder path, relative to the owner's root. */
  folderPath: string;
}

const PREFIX = 'shared:';

export function sharedDropId(index: number, folderPath: string): string {
  return `${PREFIX}${index}:${folderPath}`;
}

/** Null when the id is not of this shape at all. */
export function parseSharedDropId(id: string): SharedDropTarget | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon === -1) return null;

  const digits = rest.slice(0, colon);
  // `Number('')` is 0 and `Number(' 1')` is 1, so the digits are checked as
  // text before being trusted as a position in an array.
  if (!/^\d+$/.test(digits)) return null;

  const folderPath = rest.slice(colon + 1);
  if (folderPath === '') return null;

  return { index: Number(digits), folderPath };
}

/** True when `folderPath` is the shared root itself, or sits inside it. */
export function fallsUnderRoot(folderPath: string, rootPath: string): boolean {
  return folderPath === rootPath || folderPath.startsWith(`${rootPath}/`);
}
