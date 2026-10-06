// Which project a note belongs to — pure and DB-free, like affinity.ts.
// NoteService.graph hands it every visible note with its tags.
//
// "Top-level folder" was the first answer and it was wrong for real vaults: a
// personal `Frodo/` holds `proyectos/there-and-back-again`, `ideas/palantir`
// and `life`, and all of it read as one project. So, in order:
//
//  1. A `proyecto/<name>` tag — the most explicit signal, and the one the
//     skill asks every note to carry. Only when the note has exactly one: a
//     profile tagged with three projects belongs to none of them in particular.
//  2. The nearest MOC above the note (`_<Folder>.md`). If that MOC carries a
//     project tag itself, the folder is that project, so an untagged note in
//     `there-and-back-again/` lands with its tagged siblings instead of beside them.
//  3. The top-level folder, or the vault root.
//
// Projects never cross owners: two vaults with an `Erebor/` are two projects.

export interface ProjectNote {
  /** Stored path, the node id. */
  id: string;
  /** Path as its owner writes it. */
  path: string;
  ownerId: string | null;
  title: string;
  tags: readonly string[];
}

export interface ProjectRef {
  /** Join key; unique across owners. */
  id: string;
  /** What to print. */
  label: string;
}

const PROJECT_TAG = 'proyecto/';

/** The note's project tag, when it has exactly one. */
export function projectTagOf(tags: readonly string[]): string | null {
  const found = [...new Set(tags.filter((t) => t.toLowerCase().startsWith(PROJECT_TAG)))];
  return found.length === 1 ? found[0]! : null;
}

function isIndexPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.startsWith('_') && name.toLowerCase().endsWith('.md');
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function resolveProjects(notesIn: readonly ProjectNote[]): Map<string, ProjectRef> {
  const scope = (ownerId: string | null, key: string) => `${ownerId ?? ''}|${key}`;

  // Every MOC, by the folder it indexes, and the label a tagged project takes
  // from its MOC: "There & Back Again" reads better than "there-and-back-again".
  const mocs = new Map<string, { title: string; tag: string | null }>();
  const tagLabel = new Map<string, string>();
  for (const note of notesIn) {
    if (!isIndexPath(note.path)) continue;
    const tag = projectTagOf(note.tags);
    mocs.set(scope(note.ownerId, dirOf(note.path)), { title: note.title, tag });
    if (tag) tagLabel.set(scope(note.ownerId, tag), note.title);
  }

  const byTag = (ownerId: string | null, tag: string): ProjectRef => ({
    id: `tag:${scope(ownerId, tag)}`,
    label: tagLabel.get(scope(ownerId, tag)) ?? tag.slice(PROJECT_TAG.length),
  });

  const out = new Map<string, ProjectRef>();
  for (const note of notesIn) {
    const tag = projectTagOf(note.tags);
    if (tag) {
      out.set(note.id, byTag(note.ownerId, tag));
      continue;
    }

    let folder = dirOf(note.path);
    let resolved: ProjectRef | null = null;
    while (folder !== '') {
      const moc = mocs.get(scope(note.ownerId, folder));
      if (moc) {
        resolved = moc.tag
          ? byTag(note.ownerId, moc.tag)
          : { id: `folder:${scope(note.ownerId, folder)}`, label: moc.title };
        break;
      }
      folder = dirOf(folder);
    }

    if (!resolved) {
      const slash = note.path.indexOf('/');
      resolved =
        slash === -1
          ? { id: `root:${note.ownerId ?? ''}`, label: 'raíz' }
          : {
              id: `folder:${scope(note.ownerId, note.path.slice(0, slash))}`,
              label: note.path.slice(0, slash),
            };
    }
    out.set(note.id, resolved);
  }
  return out;
}
