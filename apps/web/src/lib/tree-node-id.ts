// Who a tree node belongs to, and where it sits in that person's vault.
//
// The tree used to be one person's, so a path was identity enough. Now folders
// other people shared appear in the same tree as your own, and two of them can
// carry the same path — an `impulse-labs` of yours and an `impulse-labs` of
// theirs are different nodes with the same name. Every id therefore carries the
// owner, and every operation reads it back rather than assuming the caller.
//
// The separator is NUL because a folder name can contain anything a filesystem
// allows, colons and slashes included, and this has to survive all of it.

export interface NodeRef {
  ownerId: string;
  path: string;
}

const SEP = '\u0000';

export function nodeId(ref: NodeRef): string {
  return `${ref.ownerId}${SEP}${ref.path}`;
}

export function parseNodeId(id: string): NodeRef | null {
  const i = id.indexOf(SEP);
  if (i === -1) return null;
  return { ownerId: id.slice(0, i), path: id.slice(i + 1) };
}

export function sameNode(a: NodeRef, b: NodeRef): boolean {
  return a.ownerId === b.ownerId && a.path === b.path;
}

/** True when `candidate` is `ancestor` or sits inside it, in the same vault. */
export function isInside(candidate: NodeRef, ancestor: NodeRef): boolean {
  if (candidate.ownerId !== ancestor.ownerId) return false;
  if (ancestor.path === '') return true;
  return candidate.path === ancestor.path || candidate.path.startsWith(`${ancestor.path}/`);
}
