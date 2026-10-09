import { describe, expect, it } from 'vitest';

import { findPath, hopsFrom, type GraphModel, type GraphNode } from '@/lib/graph-model';

import { findWalk, planCrawl, walkable } from '../crawl-plan';
import type { SampleVault } from '../sample-vault';
import { largeVault } from './large-vault';

// Each build takes a few dozen milliseconds: build each seed once.
const built = new Map<number, SampleVault>();
const vault = (seed = 11): SampleVault => {
  const hit = built.get(seed);
  if (hit) return hit;
  const v = largeVault(seed);
  built.set(seed, v);
  return v;
};
const SEEDS = [11, 1, 2, 3, 4];

const byPath = (model: GraphModel, path: string): GraphNode => {
  const n = model.nodes.find((m) => m.path === path && !m.foreign);
  if (!n) throw new Error(`no note at ${path}`);
  return n;
};
const ownProjects = (model: GraphModel) =>
  model.projects.filter((p) => p.vault === 'own' && p.label !== 'Sketchbook');
const neighbours = (model: GraphModel, n: GraphNode) =>
  (model.adjacency.get(n) ?? []).map((x) => x.node);

describe('largeVault', () => {
  it('builds the same vault for the same seed, and another for another seed', () => {
    const shape = (v: SampleVault) => ({
      nodes: v.model.nodes.map((n) => [n.id, n.x, n.y, n.z]),
      edges: v.model.edges.map((e) => [e.source.id, e.target.id, e.kind]),
      crawls: v.crawls,
    });
    expect(shape(largeVault(5))).toEqual(shape(largeVault(5)));
    expect(shape(largeVault(6)).nodes).not.toEqual(shape(largeVault(5)).nodes);
  });

  it('holds as many notes as asked for', () => {
    expect(vault().model.nodes).toHaveLength(1600);
    expect(largeVault(11, 800).model.nodes).toHaveLength(800);
  });

  it('files them in about sixty projects, a few big and many small', () => {
    const sizes = ownProjects(vault().model)
      .map((p) => p.nodes.length)
      .sort((a, b) => b - a);
    expect(sizes.length).toBeGreaterThanOrEqual(55);
    expect(sizes.length).toBeLessThanOrEqual(65);
    expect(sizes[0]).toBeGreaterThan(100);
    expect(sizes[Math.floor(sizes.length / 2)]).toBeLessThan(30);
    expect(sizes.at(-1)).toBeGreaterThanOrEqual(5);
  });

  it('draws between 3,000 and 3,800 threads a crawl can walk, and nothing else', () => {
    for (const seed of SEEDS) {
      const { edges } = vault(seed).model;
      expect(edges.every(walkable)).toBe(true);
      expect(edges.length).toBeGreaterThanOrEqual(3000);
      expect(edges.length).toBeLessThanOrEqual(3800);
    }
  });

  it('gives every project one index at its root, filing most of its notes', () => {
    const { model } = vault();
    let notes = 0;
    let filed = 0;
    for (const p of model.projects.filter((g) => g.label !== 'Sketchbook')) {
      const indexes = p.nodes.filter((n) => n.isIndex);
      expect(indexes.map((n) => n.path)).toEqual([`${p.label}/_${p.label}.md`]);
      const index = indexes[0]!;
      for (const n of p.nodes) {
        if (n === index) continue;
        notes++;
        if (neighbours(model, n).includes(index)) filed++;
      }
    }
    expect(filed / notes).toBeGreaterThan(0.5);
    expect(filed / notes).toBeLessThan(0.75);
  });

  it('files notes in one to six folders, and keeps some at the project root', () => {
    const { model } = vault();
    let atRoot = 0;
    for (const p of ownProjects(model)) {
      const folders = new Set<string>();
      for (const n of p.nodes) {
        const parts = n.path.split('/');
        expect(parts[0]).toBe(p.label);
        if (parts.length === 3) folders.add(parts[1]!);
        else if (!n.isIndex) atRoot++;
      }
      expect(folders.size).toBeGreaterThanOrEqual(1);
      expect(folders.size).toBeLessThanOrEqual(6);
    }
    expect(atRoot).toBeGreaterThan(50);
  });

  it('cites a few notes from many other projects', () => {
    const { model } = vault();
    const outside = new Map<GraphNode, number>();
    for (const e of model.edges) {
      if (e.kind !== 'link' || e.source.project?.id === e.target.project?.id) continue;
      for (const n of [e.source, e.target]) outside.set(n, (outside.get(n) ?? 0) + 1);
    }
    const counts = [...outside.values()].sort((a, b) => b - a);
    expect(counts[0]).toBeGreaterThanOrEqual(8);
    expect(counts[Math.floor(counts.length / 2)]).toBeLessThanOrEqual(2);
  });

  it('ties every project together, and keeps the island out of reach of all of them', () => {
    const { model } = vault();
    const lattice = ownProjects(model).flatMap((p) => p.nodes);
    const reached = hopsFrom(model, lattice[0]!, model.nodes.length);
    expect(lattice.every((n) => reached.has(n))).toBe(true);

    const island = model.projects.find((p) => p.label === 'Sketchbook')!.nodes;
    expect(island).toHaveLength(12);
    expect(findWalk(model, lattice[0]!, island[0]!)).toBeNull();
    expect(findWalk(model, island[0]!, island.at(-1)!)).not.toBeNull();
    for (const n of island)
      expect(neighbours(model, n).every((m) => island.includes(m))).toBe(true);
  });

  it('shares a foreign annex of about forty notes, linked only among themselves', () => {
    const { model } = vault();
    const annex = model.nodes.filter((n) => n.ownerId === 'ana');
    expect(annex.length).toBeGreaterThanOrEqual(35);
    expect(annex.length).toBeLessThanOrEqual(45);
    expect(annex.every((n) => n.foreign && n.vault === 'ana')).toBe(true);
    for (const n of annex)
      expect(neighbours(model, n).every((m) => m.ownerId === 'ana')).toBe(true);
    expect(model.vaults.map((v) => v.id)).toEqual(['own', 'ana']);
  });

  it('puts every note somewhere finite, with no draw offset', () => {
    for (const n of vault().model.nodes) {
      expect([n.x, n.y, n.z].every(Number.isFinite)).toBe(true);
      expect([n.ox, n.oy, n.oz]).toEqual([0, 0, 0]);
    }
  });

  it('walks between two named notes six to ten threads apart, then out along three links', () => {
    for (const seed of SEEDS) {
      const { model, crawls } = vault(seed);
      const [first, second, ...linked] = crawls.walk.notes;
      expect(first!.via.kind).toBe('named');
      expect(second!.via.kind).toBe('named');
      const a = byPath(model, first!.path);
      const b = byPath(model, second!.path);
      expect(findPath(model, a, b)!.edges.length).toBeGreaterThanOrEqual(6);
      const walk = findWalk(model, a, b);
      expect(walk!.length - 1).toBeGreaterThanOrEqual(6);
      expect(walk!.length - 1).toBeLessThanOrEqual(10);

      expect(linked).toHaveLength(3);
      expect(linked.filter((n) => n.isDecision)).toHaveLength(1);
      for (const n of linked) {
        expect(n.via).toMatchObject({ kind: 'linked', from: a.path });
        expect(neighbours(model, a)).toContain(byPath(model, n.path));
      }
    }
  });

  it('crosses into the island in the gap crawl', () => {
    const { model, crawls } = vault();
    const named = crawls.gap.notes.find((n) => n.via.kind === 'named')!;
    expect(byPath(model, named.path).project?.label).toBe('Sketchbook');
    expect(crawls.gap.notes.some((n) => n.via.kind === 'prompt')).toBe(true);
  });

  it('asks about one reference nothing matches and one two notes could mean', () => {
    const { model, crawls } = vault();
    const [none, both] = crawls.ask.unresolved;
    expect(none?.reason).toBe('no-match');
    expect(both?.reason).toBe('ambiguous');
    const candidates = both!.candidates!.map((c) => byPath(model, c.path));
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.title).toBe(candidates[1]!.title);
    expect(candidates[0]!.project?.id).not.toBe(candidates[1]!.project?.id);
  });

  it('tours everything the other crawls reach', () => {
    const { crawls } = vault();
    const paths = new Set(crawls.tour.notes.map((n) => n.path));
    for (const c of [crawls.walk, crawls.gap, crawls.ask]) {
      for (const n of c.notes) expect(paths.has(n.path)).toBe(true);
    }
    expect(crawls.tour.notes).toHaveLength(paths.size);
    expect(crawls.tour.unresolved).toEqual(crawls.ask.unresolved);
  });

  it('plans every crawl it offers onto notes the graph shows, ending in finish', () => {
    for (const seed of SEEDS) {
      const { model, crawls } = vault(seed);
      for (const result of Object.values(crawls)) {
        const plan = planCrawl(result, model);
        expect(plan.offGraph).toBe(0);
        expect(plan.steps.at(-1)?.kind).toBe('finish');
      }
    }
  });

  it('builds in under 150 ms once warm', () => {
    // The whole suite runs files in parallel, which can double a build's wall time, so
    // it keeps timing until one build fits, up to ten: a slow generator still fails all.
    largeVault(99);
    let best = Infinity;
    for (let i = 0; i < 10 && best >= 150; i++) {
      const t0 = performance.now();
      largeVault(98 - i);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(150);
  });
});
