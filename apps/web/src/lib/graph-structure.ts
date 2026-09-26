// Pure helpers that tell structure from content in the graph — which folder a
// note belongs to, which notes are MOC indexes, which colour a folder wears.
// No rendering here, so it is testable in Node like ecosystem.ts.
//
// Why this exists: a vault's MOCs (`_<Folder>.md`) link to every note in their
// folder, so in a links-only graph the index notes become the hubs. Those
// edges say where a note is filed, not what it is about, and drawn at full
// strength they were the whole picture.

/** How many folders get a colour of their own. The rest share "otras". */
export const GROUP_SLOTS = 3;

/** First path segment, or `''` for a note at the vault root. */
export function topFolderOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A MOC index note: its filename starts with `_`, e.g. `Pablo/ideas/_ideas.md`. */
export function isIndexNote(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.startsWith('_') && name.toLowerCase().endsWith('.md');
}

/** An edge that exists because a note is filed under an index, not because of what it says. */
export function isStructureEdge(sourcePath: string, targetPath: string): boolean {
  return isIndexNote(sourcePath) || isIndexNote(targetPath);
}

export interface GroupedNode {
  path: string;
  /** True for a note in somebody else's vault; those never take a folder colour. */
  foreign: boolean;
}

export interface FolderGroup {
  folder: string;
  count: number;
  /** Colour slot, `0 … GROUP_SLOTS - 1`, or `null` for "otras". */
  slot: number | null;
}

/**
 * Give the largest top-level folders a colour slot each, the rest none.
 *
 * Largest first, ties by name, so the same vault always paints the same way.
 * Computed from every node, never from the filtered view — filtering must not
 * repaint the survivors. The vault root is never given a slot: a note there
 * belongs to no project, which is what grey says.
 */
export function assignFolderGroups(
  nodes: readonly GroupedNode[],
  slots: number = GROUP_SLOTS,
): FolderGroup[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.foreign) continue;
    const folder = topFolderOf(node.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  const ordered = [...counts.entries()].sort(
    ([a, ca], [b, cb]) => cb - ca || a.localeCompare(b),
  );

  let next = 0;
  return ordered.map(([folder, count]) => {
    const slot = folder !== '' && next < slots ? next++ : null;
    return { folder, count, slot };
  });
}
