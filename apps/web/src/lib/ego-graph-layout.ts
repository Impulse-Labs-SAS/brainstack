// Layout math for the mini ego-graph — pure, tested in Node. Unlike the
// full-page graph (components/graph/graph-view.tsx), this only ever draws
// the current note's direct neighbors (a handful, up to a few dozen), so a
// fixed radial layout is simpler and more predictable than running a force
// simulation for that few nodes.

export type EgoRelation = 'backlink' | 'outbound' | 'related';

export interface EgoNeighbor {
  /** Unique per neighbor — a note path, deduplicated across relations. */
  path: string;
  label: string;
  relation: EgoRelation;
}

export interface LaidOutNode {
  path: string;
  label: string;
  relation: EgoRelation;
  x: number;
  y: number;
}

export interface EgoLayout {
  center: { x: number; y: number };
  nodes: LaidOutNode[];
  radius: number;
}

/**
 * Places the current note at the center and its neighbors on a ring around
 * it, evenly spaced by angle. Neighbors sharing a `path` (a note that is
 * both a backlink and outbound, say) are deduplicated, keeping the first
 * relation seen — the order the caller passes them decides precedence.
 */
export function layoutEgoGraph(
  neighbors: readonly EgoNeighbor[],
  opts: { width: number; height: number; maxNodes?: number } = { width: 240, height: 240 },
): EgoLayout {
  const width = opts.width ?? 240;
  const height = opts.height ?? 240;
  const maxNodes = opts.maxNodes ?? 24;

  const seen = new Set<string>();
  const deduped: EgoNeighbor[] = [];
  for (const n of neighbors) {
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    deduped.push(n);
  }
  const limited = deduped.slice(0, maxNodes);

  const center = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) / 2 - 24;

  const nodes: LaidOutNode[] = limited.map((n, i) => {
    // Starts at the top (-90°) and goes clockwise, purely cosmetic but
    // deterministic — same input always lays out the same way.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, limited.length);
    return {
      path: n.path,
      label: n.label,
      relation: n.relation,
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });

  return { center, nodes, radius };
}
