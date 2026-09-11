import { describe, expect, it } from 'vitest';

import { layoutEgoGraph, type EgoNeighbor } from './ego-graph-layout';

describe('layoutEgoGraph', () => {
  it('centers on the middle of the given size', () => {
    const { center } = layoutEgoGraph([], { width: 200, height: 100 });
    expect(center).toEqual({ x: 100, y: 50 });
  });

  it('places one node directly above the center', () => {
    const neighbors: EgoNeighbor[] = [{ path: 'a.md', label: 'A', relation: 'backlink' }];
    const { center, nodes } = layoutEgoGraph(neighbors, { width: 200, height: 200 });
    const [node] = nodes;
    expect(node!.x).toBeCloseTo(center.x, 5);
    expect(node!.y).toBeLessThan(center.y);
  });

  it('spaces nodes evenly around the ring', () => {
    const neighbors: EgoNeighbor[] = [
      { path: 'a.md', label: 'A', relation: 'backlink' },
      { path: 'b.md', label: 'B', relation: 'outbound' },
      { path: 'c.md', label: 'C', relation: 'related' },
    ];
    const { center, nodes, radius } = layoutEgoGraph(neighbors, { width: 200, height: 200 });
    for (const node of nodes) {
      const dist = Math.hypot(node.x - center.x, node.y - center.y);
      expect(dist).toBeCloseTo(radius, 5);
    }
  });

  it('deduplicates by path, keeping the first relation seen', () => {
    const neighbors: EgoNeighbor[] = [
      { path: 'a.md', label: 'A', relation: 'backlink' },
      { path: 'a.md', label: 'A', relation: 'outbound' },
    ];
    const { nodes } = layoutEgoGraph(neighbors);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.relation).toBe('backlink');
  });

  it('caps the number of nodes at maxNodes', () => {
    const neighbors: EgoNeighbor[] = Array.from({ length: 40 }, (_, i) => ({
      path: `n${i}.md`,
      label: `N${i}`,
      relation: 'related' as const,
    }));
    const { nodes } = layoutEgoGraph(neighbors, { width: 200, height: 200, maxNodes: 10 });
    expect(nodes).toHaveLength(10);
  });
});
