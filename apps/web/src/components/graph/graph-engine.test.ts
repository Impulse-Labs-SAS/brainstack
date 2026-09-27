import { describe, expect, it } from 'vitest';

import { brainSDF } from '@/lib/graph-brain';
import { DEFAULT_LAYERS, buildGraphModel, type GraphNode, type InputEdge, type InputNode } from '@/lib/graph-model';

import { GraphEngine } from './graph-engine';

const MINUTE = 60_000;

/** A vault imported in one sitting: every note created within minutes, plus one dated 1970. */
function importedVault(count: number) {
  const nodes: InputNode[] = Array.from({ length: count }, (_, i) => ({
    id: `me/p${i % 4}/${i}.md`,
    path: `p${i % 4}/${i}.md`,
    title: `Note ${i}`,
    ownerId: 'me',
    project: { id: `p${i % 4}`, label: `P${i % 4}` },
    createdAt: i === 0 ? 0 : 1_750_000_000_000 + i * MINUTE,
    updatedAt: 1_750_000_000_000,
  }));
  const edges: InputEdge[] = nodes.slice(1).map((n, i) => ({ source: n.id, target: nodes[i]!.id, weight: 1 }));
  return buildGraphModel({ nodes, edges, affinity: null, layers: DEFAULT_LAYERS, viewerId: 'me', ownerNames: new Map(), cache: new Map() });
}

function engineWith(model: ReturnType<typeof importedVault>, view: 'brain' | 'network' = 'network') {
  const engine = new GraphEngine(true);
  engine.view = view;
  engine.setModel(model, 'init', 0);
  return engine;
}

describe('growth replay', () => {
  it('reveals notes at an even pace, however their creation dates cluster', () => {
    const model = importedVault(40);
    const engine = engineWith(model);
    engine.startGrowth(0);
    const seen: number[] = [];
    // The replay lasts 7 s for 40 notes; look in on it every second.
    for (let t = 1000; t <= 7000; t += 1000) {
      engine.advance(t);
      seen.push(engine.nodeCount);
    }
    expect(seen.slice(0, -1).every((c, i) => c < seen[i + 1]!)).toBe(true);
    expect(seen[0]).toBeGreaterThan(3);
    expect(seen[0]).toBeLessThan(10);
    expect(engine.growth).toBeNull();
    expect(engine.nodeCount).toBe(40);
  });

  it('reports the creation date of the newest note so far', () => {
    const engine = engineWith(importedVault(20));
    engine.startGrowth(0);
    engine.advance(3500);
    const status = engine.growthStatus()!;
    expect(status.count).toBe(10);
    expect(status.at).toBe(1_750_000_000_000 + 9 * MINUTE);
  });

  it('places every note when stopped halfway', () => {
    const model = importedVault(30);
    const engine = engineWith(model);
    engine.startGrowth(0);
    engine.advance(2000);
    engine.endGrowth();
    expect(model.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(model.nodes.every((n) => n.bornAt !== Infinity)).toBe(true);
  });
});

describe('views', () => {
  it('keeps flat views flat', () => {
    const model = importedVault(30);
    const engine = engineWith(model);
    for (let t = 0; t < 200; t++) engine.advance(t * 16);
    expect(Math.max(...model.nodes.map((n) => Math.abs(n.z)))).toBeLessThan(1);
  });

  it('inflates into the brain when entering it, and keeps notes inside', () => {
    const model = importedVault(60);
    const engine = engineWith(model);
    const rescale = engine.setView('brain');
    expect(rescale).not.toBeNull();
    for (let t = 0; t < 300; t++) engine.advance(t * 16);
    const s = engine.brainScale;
    const outside = model.nodes.filter((n: GraphNode) => brainSDF(n.x / s, n.y / s, n.z / s) > 0.02);
    expect(outside).toEqual([]);
    expect(Math.max(...model.nodes.map((n) => Math.abs(n.z)))).toBeGreaterThan(s * 0.1);
  });

  it('keeps placed notes where they are when the model is rebuilt', () => {
    const model = importedVault(20);
    const engine = engineWith(model);
    const before = model.nodes.map((n) => [n.x, n.y]);
    engine.setModel(model, 'layers', 0);
    expect(model.nodes.map((n) => [n.x, n.y])).toEqual(before);
  });
});
