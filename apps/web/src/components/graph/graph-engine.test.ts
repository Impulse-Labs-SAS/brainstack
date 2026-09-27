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

/** Two vaults nothing links together, each a chain, plus three notes without a single link. */
function islands() {
  const make = (owner: string, project: string, i: number): InputNode => ({
    id: `${owner}/${project}/${i}.md`,
    path: `${project}/${i}.md`,
    title: `${project} ${i}`,
    ownerId: owner,
    project: { id: `${owner}|${project}`, label: project },
    createdAt: 1_750_000_000_000 + i * MINUTE,
    updatedAt: 1_750_000_000_000,
  });
  const mine = Array.from({ length: 20 }, (_, i) => make('me', i < 10 ? 'Kora' : 'Lumen', i));
  const theirs = Array.from({ length: 12 }, (_, i) => make('ana', 'Research', i));
  const loose = Array.from({ length: 3 }, (_, i) => make('me', 'Inbox', 100 + i));
  const chain = (list: InputNode[]): InputEdge[] => list.slice(1).map((n, i) => ({ source: n.id, target: list[i]!.id, weight: 1 }));
  return buildGraphModel({
    nodes: [...mine, ...theirs, ...loose],
    edges: [...chain(mine), ...chain(theirs)],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    ownerNames: new Map([['ana', 'Ana']]),
    cache: new Map(),
  });
}

function engineWith(model: ReturnType<typeof importedVault>, view: 'brain' | 'network' | 'territories' = 'network') {
  const engine = new GraphEngine(true);
  engine.view = view;
  engine.setModel(model, 'init', 0);
  return engine;
}

function settle(engine: GraphEngine, frames = 400) {
  for (let t = 0; t < frames; t++) engine.advance(t * 16);
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

  it('in the brain, keeps every note shown so far at a real position, frame by frame', () => {
    // 300 notes over 8.4 s: a note every 28 ms, several between two syncs of the simulation.
    const model = importedVault(300);
    const engine = engineWith(model, 'brain');
    engine.startGrowth(0);
    for (let t = 0; engine.growth; t += 16) {
      engine.advance(t);
      const lost = engine.growth?.active.filter((n) => !Number.isFinite(n.x + n.y + n.z)) ?? [];
      expect(lost).toEqual([]);
    }
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

  it('in Network, gives pieces nothing links their own room, and rings the notes without links', () => {
    const model = islands();
    const engine = engineWith(model);
    settle(engine);
    const centre = (list: GraphNode[]) => {
      const x = list.reduce((s, n) => s + n.x, 0) / list.length;
      const y = list.reduce((s, n) => s + n.y, 0) / list.length;
      return { x, y, r: Math.max(...list.map((n) => Math.hypot(n.x - x, n.y - y))) };
    };
    const mine = centre(model.nodes.filter((n) => n.vault === 'own' && n.degree > 0));
    const theirs = centre(model.nodes.filter((n) => n.vault === 'ana'));
    // Both pulled to one centre, the two pieces used to thread through each other.
    expect(Math.hypot(mine.x - theirs.x, mine.y - theirs.y)).toBeGreaterThan(Math.max(mine.r, theirs.r));

    const ring = engine.ring!;
    expect(ring.count).toBe(3);
    const reach = Math.max(...model.nodes.filter((n) => n.degree > 0).map((n) => Math.hypot(n.x, n.y)));
    for (const n of model.nodes.filter((x) => x.degree === 0)) {
      expect(Math.hypot(n.x, n.y)).toBeGreaterThan(reach);
      expect(Math.abs(Math.hypot(n.x, n.y) - ring.r) / ring.r).toBeLessThan(0.2);
    }
  });

  it('in Territories, eases every note to its place on the map, flat, and comes to rest', () => {
    const model = islands();
    const engine = engineWith(model);
    settle(engine, 60);
    expect(engine.setView('territories')).toBeNull();
    expect(engine.moving).toBe(true);
    settle(engine, 200);
    expect(engine.moving).toBe(false);
    for (const n of model.nodes) {
      const p = engine.territory!.positions.get(n)!;
      expect([n.x, n.y, n.z]).toEqual([p.x, p.y, 0]);
    }
    expect(engine.land!.sites).toHaveLength(model.nodes.length);
    expect(engine.countryAt(engine.territory!.countries[0]!.x, engine.territory!.countries[0]!.y)).toBe(engine.territory!.countries[0]!.id);
  });

  it('in Territories, grows the land with the replay', () => {
    const model = islands();
    const engine = engineWith(model, 'territories');
    engine.startGrowth(0);
    engine.advance(3000);
    const partway = engine.land!.sites.length;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(model.nodes.length);
    for (const n of engine.growth!.active) expect(engine.territory!.positions.get(n)).toEqual({ x: n.x, y: n.y });
    engine.endGrowth();
    expect(engine.land!.sites).toHaveLength(model.nodes.length);
  });

  it('keeps placed notes where they are when the model is rebuilt', () => {
    const model = importedVault(20);
    const engine = engineWith(model);
    const before = model.nodes.map((n) => [n.x, n.y]);
    engine.setModel(model, 'layers', 0);
    expect(model.nodes.map((n) => [n.x, n.y])).toEqual(before);
  });
});

describe('first layout', () => {
  function opened(view: 'brain' | 'network' = 'network') {
    const model = importedVault(300);
    const engine = new GraphEngine(false);
    engine.view = view;
    engine.setModel(model, 'init', 0);
    return { model, engine };
  }

  it('settles out of sight over the next frames, then lights the notes up', () => {
    const { model, engine } = opened();
    expect(engine.warming).toBe(true);
    expect(model.nodes.every((n) => engine.appear(n, 0) === 0)).toBe(true);
    let t = 0;
    while (engine.warming) engine.advance((t += 16));
    expect(model.nodes.every((n) => Number.isFinite(n.x + n.y) && n.bornAt >= t && n.bornAt < Infinity)).toBe(true);
    expect(engine.moving).toBe(true);
  });

  it('shows every note when the model is rebuilt before the layout settled', () => {
    const { model, engine } = opened();
    engine.setModel(model, 'layers', 16);
    expect(engine.warming).toBe(false);
    expect(model.nodes.every((n) => n.bornAt < Infinity)).toBe(true);
  });

  it('shows every note when the view changes before the layout settled', () => {
    const { model, engine } = opened();
    engine.advance(16);
    engine.setView('brain');
    expect(engine.warming).toBe(false);
    expect(model.nodes.every((n) => n.bornAt < Infinity)).toBe(true);
  });
});
