// Pure helpers that tell structure from content in the graph — which notes are
// MOC indexes, and which edges exist only because a note is filed under one.
// No rendering here, so it is testable in Node like ecosystem.ts.
//
// Why this exists: a vault's MOCs (`_<Folder>.md`) link to every note in their
// folder, so in a links-only graph the index notes become the hubs. Those
// edges say where a note is filed, not what it is about, and drawn at full
// strength they were the whole picture.

/** A MOC index note: its filename starts with `_`, e.g. `Frodo/ideas/_ideas.md`. */
export function isIndexNote(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.startsWith('_') && name.toLowerCase().endsWith('.md');
}

/** An edge that exists because a note is filed under an index, not because of what it says. */
export function isStructureEdge(sourcePath: string, targetPath: string): boolean {
  return isIndexNote(sourcePath) || isIndexNote(targetPath);
}
