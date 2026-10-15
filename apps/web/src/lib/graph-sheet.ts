// What the graph's preview sheet shows of a note beyond its title: where it is filed, as steps up
// to its vault, and everything it connects to, in groups. Pure, so it is testable in Node like
// graph-structure.ts; the sheet only renders it.

import { fold, type GraphModel, type GraphNode, type Neighbour } from './graph-model';

/** A step up from a note: a folder it is filed in, its project or its vault, and the notes under it. */
export interface Crumb {
  kind: 'vault' | 'project' | 'folder';
  label: string;
  notes: GraphNode[];
}

const folderParts = (path: string) => path.split('/').slice(0, -1);
const within = (parts: readonly string[], prefix: readonly string[]) =>
  prefix.length <= parts.length && prefix.every((p, i) => parts[i] === p);

/**
 * From the vault down to the folder the note is in. Below its project, only the folders under
 * the project's own: that one is what all the project's notes share, and is the project.
 */
export function crumbsOf(
  model: Pick<GraphModel, 'vaults' | 'projects' | 'nodes'>,
  node: GraphNode,
): Crumb[] {
  const crumbs: Crumb[] = [];
  const vault = model.vaults.find((v) => v.id === node.vault);
  if (vault)
    crumbs.push({
      kind: 'vault',
      label: vault.label,
      notes: model.nodes.filter((n) => n.vault === node.vault && n.kind === 'note'),
    });
  const project = node.project && model.projects.find((p) => p.id === node.project!.id);
  if (!project?.nodes.length) return crumbs;
  crumbs.push({ kind: 'project', label: project.label, notes: project.nodes });
  let root = folderParts(project.nodes[0]!.path);
  for (const n of project.nodes) {
    const parts = folderParts(n.path);
    let k = 0;
    while (k < root.length && k < parts.length && root[k] === parts[k]) k++;
    root = root.slice(0, k);
  }
  const parts = folderParts(node.path);
  for (let depth = root.length + 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth);
    crumbs.push({
      kind: 'folder',
      label: prefix[depth - 1]!,
      notes: project.nodes.filter((n) => within(folderParts(n.path), prefix)),
    });
  }
  return crumbs;
}

/** One kind of connection, as the sheet lists it under a heading. */
export interface ConnectionGroup {
  key: 'out' | 'in' | 'indexes' | 'listed' | 'topic' | 'affinity';
  label: string;
  items: Neighbour[];
}

const ORDER: ConnectionGroup['key'][] = ['out', 'in', 'indexes', 'listed', 'topic', 'affinity'];

/**
 * Every connection of `node` whose note matches `query` (accents and case aside), grouped: the
 * links it makes, the links to it, the indexes that list it and what it lists if it is one,
 * its topics (a topic's own notes) and the notes it shares topics with. Biggest first in each.
 */
export function connectionGroups(
  model: Pick<GraphModel, 'adjacency'>,
  node: GraphNode,
  query = '',
): ConnectionGroup[] {
  const q = fold(query.trim());
  const groups = new Map<ConnectionGroup['key'], Neighbour[]>();
  for (const nb of model.adjacency.get(node) ?? []) {
    if (q && !fold(nb.node.label).includes(q)) continue;
    const { kind, source } = nb.edge;
    const key: ConnectionGroup['key'] =
      kind === 'link'
        ? source === node
          ? 'out'
          : 'in'
        : kind === 'structure'
          ? nb.node.isIndex
            ? 'indexes'
            : 'listed'
          : kind;
    const list = groups.get(key) ?? [];
    list.push(nb);
    groups.set(key, list);
  }
  const label: Record<ConnectionGroup['key'], string> = {
    out: 'Links to',
    in: 'Linked from',
    indexes: 'Indexes',
    listed: 'Listed here',
    topic: node.kind === 'topic' ? 'Notes' : 'Topics',
    affinity: 'Shared topics',
  };
  return ORDER.filter((key) => groups.has(key)).map((key) => ({
    key,
    label: label[key],
    items: groups
      .get(key)!
      .sort((a, b) => b.node.size - a.node.size || a.node.label.localeCompare(b.node.label)),
  }));
}
