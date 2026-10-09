import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';
import { OWN_VAULT, type GraphEdge, type GraphModel, type GraphNode } from '@/lib/graph-model';

import { walkable } from '../../crawl-plan';
import { sampleVault, type SampleVault } from '../../sample-vault';
import { threadEnds, threadKey } from '../../threads';
import type { Vec3 } from '../../vec';
import { largeVault } from '../large-vault';

import {
  ISLAND_GAP,
  PART_HUB,
  PART_SATELLITE,
  ballRadius,
  clusterSdf,
  lobePart,
  neckPart,
} from './cluster';
import { VOLUME_SPACING, volumeLayout, type VolumeLayout } from './layout';

// Each large vault takes a few dozen milliseconds to build and lay out: once each.
const vaults = new Map<string, SampleVault>();
const layouts = new Map<string, VolumeLayout>();
const vault = (name: string): SampleVault => {
  let v = vaults.get(name);
  if (!v) {
    const [kind, seed, size] = name.split(':') as [string, string, string?];
    v =
      kind === 'sample'
        ? sampleVault(Number(seed))
        : largeVault(Number(seed), Number(size ?? 1600));
    vaults.set(name, v);
  }
  return v;
};
const layout = (name: string): VolumeLayout => {
  let l = layouts.get(name);
  if (!l) {
    l = volumeLayout(vault(name).model);
    layouts.set(name, l);
  }
  return l;
};
/** Two seeds of the 69-note sample and of a 1,600-note vault. */
const VAULTS = ['sample:7', 'sample:3', 'large:11', 'large:5'];

const notesOf = (model: GraphModel) => model.nodes.filter((n) => n.kind === 'note');
const siteAt = (l: VolumeLayout, v: number): Vec3 => [
  l.lattice.points[v * 3]!,
  l.lattice.points[v * 3 + 1]!,
  l.lattice.points[v * 3 + 2]!,
];
const pointOf = (p: Float32Array, i: number): Vec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
const neighbours = (l: VolumeLayout, v: number) =>
  Array.from(l.lattice.adj.subarray(l.lattice.offsets[v], l.lattice.offsets[v + 1]));
const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const len = (v: Vec3) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
const distance = (u: Vec3, v: Vec3) => len(sub(u, v));

/** How many pieces a set of sites falls in over the lattice's neighbours. */
function piecesOf(l: VolumeLayout, sites: readonly number[]): number {
  const left = new Set(sites);
  let pieces = 0;
  for (const start of sites) {
    if (!left.has(start)) continue;
    pieces++;
    left.delete(start);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const w of neighbours(l, queue[head]!)) {
        if (!left.has(w)) continue;
        left.delete(w);
        queue.push(w);
      }
    }
  }
  return pieces;
}

/** The ground a region claimed, ascending. */
const groundOf = (l: VolumeLayout, r: number) =>
  Array.from({ length: l.lattice.count }, (_, v) => v).filter((v) => l.owner[v] === r);

/** How far `p` is from the segment from `a` to `b`. */
function offChord(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const ll = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ap = sub(p, a);
  const t =
    ll > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / ll)) : 0;
  return distance(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}

/** A copy of the model whose notes `relabel` moves to another project, vault or id. */
function remade(
  base: GraphModel,
  copies: readonly ((n: GraphNode) => Partial<GraphNode>)[],
): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const relabel of copies) {
    const made = new Map<GraphNode, GraphNode>();
    for (const n of base.nodes) {
      const m = { ...n, ...relabel(n) };
      made.set(n, m);
      nodes.push(m);
    }
    for (const e of base.edges) {
      edges.push({ ...e, source: made.get(e.source)!, target: made.get(e.target)! });
    }
  }
  return { ...base, nodes, edges };
}

/**
 * A vault of made-up projects, each a tree of links under its index, an index
 * of one project linked to the index of another for each pair in `links`.
 * Every field a note needs besides comes from a note of the sample.
 */
function projectsVault(
  projects: readonly { name: string; notes: number; vault?: string }[],
  links: readonly (readonly [string, string])[] = [],
): GraphModel {
  const base = vault('sample:7').model;
  const carrier = notesOf(base)[0]!;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const link = (source: GraphNode, target: GraphNode): GraphEdge => ({
    source,
    target,
    kind: 'link',
    weight: 1,
    shared: [],
  });
  const index = new Map<string, GraphNode>();
  for (const { name, notes, vault: v = OWN_VAULT } of projects) {
    const tree: GraphNode[] = [];
    for (let i = 0; i < notes; i++) {
      const n: GraphNode = {
        ...carrier,
        id: `${v}/${name}/${String(i).padStart(4, '0')}.md`,
        path: `${name}/${String(i).padStart(4, '0')}.md`,
        vault: v,
        ownerId: v === OWN_VAULT ? carrier.ownerId : v,
        isIndex: i === 0,
        project: { id: name.toLowerCase(), label: name },
        createdAt: i,
      };
      tree.push(n);
      if (i > 0) edges.push(link(n, tree[(i - 1) >> 1]!));
    }
    nodes.push(...tree);
    index.set(name, tree[0]!);
  }
  for (const [from, to] of links) edges.push(link(index.get(from)!, index.get(to)!));
  return { ...base, nodes, edges, projects: [] };
}

/** Whether no other region's ground lies a lattice step from region `r`'s, its own vault's aside. */
function moated(l: VolumeLayout, r: number): boolean {
  const vaultOf = l.regions[r]!.vault;
  return groundOf(l, r).every((v) =>
    neighbours(l, v).every((w) => {
      const o = l.owner[w]!;
      return (
        o < 0 || o === r || (l.regions[r]!.apart === 'annex' && l.regions[o]!.vault === vaultOf)
      );
    }),
  );
}

describe('volumeLayout', () => {
  it('stands every note on a site of its own, inside the form', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      const a = l.spacing;
      const notes = notesOf(vault(name).model);
      expect(l.positions.size).toBe(notes.length);
      expect(new Set(l.siteOf.values()).size).toBe(notes.length);
      // Off its own site, or out of the form, at the most: checked once, not per note.
      let offSite = 0;
      let outermost = -Infinity;
      for (const n of notes) {
        const p = l.positions.get(n.id)!;
        offSite = Math.max(offSite, distance(p, siteAt(l, l.siteOf.get(n.id)!)));
        outermost = Math.max(outermost, clusterSdf(l.cluster, p));
      }
      expect(offSite).toBeLessThanOrEqual(0.25 * a + 1e-3);
      // A note stays a tenth of a spacing in; its position is a float32.
      expect(outermost).toBeLessThanOrEqual(-0.1 * a + 1e-3);
      expect(l.centre).toEqual([0, 0, 0]);
      expect(l.radius).toBe(l.cluster.radius);
      expect(l.stats.sites).toBe(l.lattice.count);
      expect(l.stats.unplaced).toBe(0);
      expect(l.stats.vacancy).toBeCloseTo(1 - notes.length / l.lattice.count, 12);
    }
  });

  it('never places a topic', () => {
    const base = vault('sample:7').model;
    const carrier = base.nodes[0]!;
    const topic: GraphNode = { ...carrier, id: 'topic:retention', kind: 'topic', project: null };
    const edge: GraphEdge = {
      source: carrier,
      target: topic,
      kind: 'topic',
      weight: 1,
      shared: [],
    };
    const model: GraphModel = {
      ...base,
      nodes: [...base.nodes, topic],
      edges: [...base.edges, edge],
    };
    const l = volumeLayout(model);
    expect(l.positions.has(topic.id)).toBe(false);
    expect(l.positions.size).toBe(base.nodes.length);
    expect([...l.routes.keys()].some((k) => threadEnds(k).includes(topic.id))).toBe(false);
  });

  it('spaces neighbouring sites 1.7 creature units apart, and no two notes within ¾ of that', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      const a = VOLUME_SPACING * l.unit;
      expect(l.spacing).toBeCloseTo(a, 9);
      let lo = Infinity;
      let hi = 0;
      for (let v = 0; v < l.lattice.count; v++) {
        for (const w of neighbours(l, v)) {
          const d = distance(siteAt(l, v), siteAt(l, w));
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      expect(lo / a).toBeCloseTo(1, 9);
      expect(hi / a).toBeCloseTo(1, 9);

      // Every pair on the sample; on a large vault every pair within two
      // lattice steps — sites further apart are at least √3 spacings, and no
      // jitter brings them within ¾.
      const noteAt = new Map([...l.siteOf].map(([id, v]) => [v, id]));
      let closest = Infinity;
      const ids = [...l.positions.keys()];
      if (name.startsWith('sample')) {
        ids.forEach((x, i) =>
          ids.forEach((y, j) => {
            if (j > i)
              closest = Math.min(closest, distance(l.positions.get(x)!, l.positions.get(y)!));
          }),
        );
      } else {
        for (const [v, id] of noteAt) {
          const near = new Set(neighbours(l, v).flatMap((w) => [w, ...neighbours(l, w)]));
          near.delete(v);
          for (const w of near) {
            const other = noteAt.get(w);
            if (other)
              closest = Math.min(closest, distance(l.positions.get(id)!, l.positions.get(other)!));
          }
        }
      }
      expect(closest).toBeGreaterThanOrEqual(0.75 * a - 1e-3);
      const share = l.positions.size / l.lattice.count;
      expect(share).toBeGreaterThanOrEqual(0.55);
      expect(share).toBeLessThanOrEqual(0.75);
    }
  });

  it('grows every project in one piece', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      expect(l.stats.pieces).toBe(0);
      for (const r of l.regions) {
        expect(r.pieces).toBe(0);
        expect(piecesOf(l, Array.from(r.sites))).toBe(1);
      }
      // One region a project, every note in its own project's.
      expect(l.regions.length).toBe(vault(name).model.projects.length);
      for (const n of notesOf(vault(name).model)) {
        const r = l.regions[l.regionOf.get(n.id)!]!;
        expect(r.key).toBe(`${n.vault}|${n.project!.id}`);
        expect(r.notes).toContain(n.id);
      }
    }
  });

  it('stands each index at its region’s medoid', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      const byId = new Map(vault(name).model.nodes.map((n) => [n.id, n]));
      let indexes = 0;
      l.regions.forEach((r, i) => {
        expect(r.sites[0]).toBe(r.centre);
        expect(l.siteOf.get(r.notes[0]!)).toBe(r.centre);
        // The site with the least summed distance to the rest of the ground,
        // summed in ascending site order, ties to the smaller site.
        const ground = groundOf(l, i);
        let medoid = -1;
        let least = Infinity;
        for (const v of ground) {
          const [x, y, z] = siteAt(l, v);
          let sum = 0;
          for (const w of ground) {
            const dx = l.lattice.points[w * 3]! - x;
            const dy = l.lattice.points[w * 3 + 1]! - y;
            const dz = l.lattice.points[w * 3 + 2]! - z;
            sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
          }
          if (sum < least) {
            least = sum;
            medoid = v;
          }
        }
        expect(r.centre).toBe(medoid);
        if (!r.notes.some((id) => byId.get(id)!.isIndex)) return;
        indexes++;
        expect(byId.get(r.notes[0]!)!.isIndex).toBe(true);
      });
      expect(indexes).toBeGreaterThan(0);
    }
  });

  it('draws notes that link to each other close together', () => {
    const l = layout('large:11');
    const gaps: number[] = [];
    for (const e of vault('large:11').model.edges) {
      if (e.kind !== 'link' || l.regionOf.get(e.source.id) !== l.regionOf.get(e.target.id))
        continue;
      gaps.push(distance(l.positions.get(e.source.id)!, l.positions.get(e.target.id)!) / l.spacing);
    }
    gaps.sort((x, y) => x - y);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(2.2);
  });

  it('routes every walkable thread whose notes both stand, from its first note to its second', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      const keys = new Set(
        vault(name)
          .model.edges.filter(
            (e) => walkable(e) && l.positions.has(e.source.id) && l.positions.has(e.target.id),
          )
          .map((e) => threadKey(e.source, e.target)),
      );
      expect(new Set(l.routes.keys())).toEqual(keys);
      // Every end exactly where its note stands — a walk arrives on its note,
      // not beside it — and listed at both notes. Counted, then checked once.
      let ends = 0;
      let astray = 0;
      for (const [key, line] of l.routes) {
        const [first, second] = threadEnds(key);
        const start = pointOf(line, 0);
        const end = pointOf(line, line.length / 3 - 1);
        const a = l.positions.get(first)!;
        const b = l.positions.get(second)!;
        if (start.some((x, k) => x !== a[k]) || end.some((x, k) => x !== b[k])) astray++;
        if (!l.adjacency.get(first)?.includes(key) || !l.adjacency.get(second)?.includes(key)) {
          astray++;
        }
        ends += 2;
      }
      expect(astray).toBe(0);
      let listed = 0;
      for (const list of l.adjacency.values()) listed += list.length;
      expect(listed).toBe(ends);
    }
  });

  it('routes each thread as a gentle bow in at most eight pieces', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      // Measured over every route, then checked once: an expect per point takes seconds.
      let fewest = Infinity;
      let most = 0;
      let wander = 0;
      let stretch = 0;
      let outward = -Infinity;
      let between = 0;
      for (const [key, line] of l.routes) {
        const n = line.length / 3;
        fewest = Math.min(fewest, n - 1);
        most = Math.max(most, n - 1);
        const a = pointOf(line, 0);
        const b = pointOf(line, n - 1);
        const chord = distance(a, b);
        if (chord === 0) continue;
        let drawn = 0;
        for (let i = 0; i < n; i++) {
          wander = Math.max(wander, offChord(pointOf(line, i), a, b) - 0.06 * chord);
          if (i > 0) drawn += distance(pointOf(line, i - 1), pointOf(line, i));
        }
        stretch = Math.max(stretch, drawn / chord);
        // Between parts, the route's middle bends towards the centre, never away.
        const [first, second] = threadEnds(key);
        const part = l.lattice.part;
        if (part[l.siteOf.get(first)!] === part[l.siteOf.get(second)!]) continue;
        between++;
        const half = (n - 1) / 2;
        const p = pointOf(line, Math.floor(half));
        const q = pointOf(line, Math.ceil(half));
        const middle: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        outward = Math.max(outward, len(middle) - len(mid));
      }
      expect(fewest).toBeGreaterThanOrEqual(1);
      expect(most).toBeLessThanOrEqual(8);
      expect(wander).toBeLessThanOrEqual(1e-3);
      expect(stretch).toBeLessThanOrEqual(1.03);
      if (name.startsWith('large')) expect(between).toBeGreaterThan(0);
      if (between > 0) expect(outward).toBeLessThanOrEqual(1e-3);
    }
  });

  it('gives each of the biggest projects a lobe, and the hub the rest', () => {
    const sample = layout('sample:7');
    expect(sample.cluster.lobes).toEqual([]);
    expect(sample.cluster.satellite).not.toBeNull();
    expect(sample.stats).toMatchObject({ lobes: 0, satellite: true });
    for (const name of ['large:11', 'large:5']) {
      const l = layout(name);
      const notes = l.positions.size;
      expect(l.cluster.lobes.length).toBeGreaterThanOrEqual(4);
      expect(l.cluster.lobes.length).toBeLessThanOrEqual(8);
      expect(l.stats.lobes).toBe(l.cluster.lobes.length);
      const part = (id: string) => l.lattice.part[l.siteOf.get(id)!]!;
      let biggestLobe = 0;
      let hubNotes = 0;
      for (const r of l.regions) {
        if (r.apart) continue;
        if (r.part === PART_HUB) {
          hubNotes += r.notes.length;
          expect(r.notes.every((id) => part(id) === PART_HUB)).toBe(true);
          continue;
        }
        const i = r.part - lobePart(0);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(r.notes.length).toBeGreaterThanOrEqual(Math.max(12, Math.ceil(0.03 * notes)));
        expect(r.notes.every((id) => part(id) === lobePart(i) || part(id) === neckPart(i))).toBe(
          true,
        );
        // A lobe of its own.
        expect(l.regions.filter((o) => o.part === r.part)).toEqual([r]);
        biggestLobe = Math.max(biggestLobe, r.notes.length);
      }
      expect(biggestLobe).toBeGreaterThan(0);
      expect(hubNotes).toBeGreaterThanOrEqual(2 * biggestLobe);
    }
  });

  it('keeps the island on a satellite apart, and the other vault in a lobe behind a moat', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      const a = l.spacing;
      const islands = l.regions.filter((r) => r.apart === 'island');
      expect(islands.map((r) => r.label)).toEqual([
        name.startsWith('sample') ? 'Island' : 'Sketchbook',
      ]);
      for (const r of islands) {
        expect(r.part).toBe(PART_SATELLITE);
        expect(Array.from(r.sites).every((v) => l.lattice.part[v] === PART_SATELLITE)).toBe(true);
      }
      // No lattice edge leaves the satellite, and every island note is the gap from any other.
      for (let v = 0; v < l.lattice.count; v++) {
        if (l.lattice.part[v] !== PART_SATELLITE) continue;
        expect(neighbours(l, v).every((w) => l.lattice.part[w] === PART_SATELLITE)).toBe(true);
      }
      let gap = Infinity;
      const ashore = [...l.positions].filter(
        ([id]) => l.regions[l.regionOf.get(id)!]!.apart !== 'island',
      );
      for (const r of islands) {
        for (const id of r.notes) {
          for (const [, p] of ashore) gap = Math.min(gap, distance(l.positions.get(id)!, p));
        }
      }
      expect(gap).toBeGreaterThanOrEqual(ISLAND_GAP * a);

      if (!name.startsWith('large')) continue;
      const annex = l.regions.filter((r) => r.vault !== OWN_VAULT);
      expect(annex).toHaveLength(1);
      const other = annex[0]!;
      expect(other.apart).toBe('annex');
      expect(other.part).toBeGreaterThanOrEqual(lobePart(0));
      expect(l.regions.filter((r) => r.part === other.part)).toEqual([other]);
      // Nobody else's ground within a lattice step of it: the moat.
      const mine = l.regions.indexOf(other);
      let beside = 0;
      for (const v of groundOf(l, mine)) {
        for (const w of neighbours(l, v)) if (l.owner[w] !== mine && l.owner[w]! >= 0) beside++;
      }
      expect(beside).toBe(0);
    }
  });

  it('sizes the form by the vault', () => {
    for (const name of ['sample:7', 'large:11']) {
      const l = layout(name);
      const perNote = l.lattice.count / l.positions.size;
      expect(perNote).toBeGreaterThanOrEqual(1 / 0.75);
      expect(perNote).toBeLessThanOrEqual(1 / 0.55);
    }
    // The hub grows with what it holds; the satellite stretches the small one's bounds.
    const small = layout('sample:7');
    const large = layout('large:11');
    expect(large.cluster.hub.radius).toBeGreaterThan(2 * small.cluster.hub.radius);
    expect(large.radius).toBeGreaterThan(small.radius);
  });

  it('gives the decision crystal only to the notes it is told record a decision', () => {
    const model = vault('large:11').model;
    const l = layout('large:11');
    // Titles and folders that say "decision" are not decisions.
    expect(model.nodes.some((n) => /decision/i.test(n.path))).toBe(true);
    expect([...l.kinds.values()]).not.toContain('decision');
    for (const n of notesOf(model)) expect(l.kinds.get(n.id)).toBe(n.isIndex ? 'index' : 'note');

    const decisions = new Set(
      notesOf(model)
        .filter((n) => !n.isIndex)
        .slice(0, 3)
        .map((n) => n.id),
    );
    const marked = volumeLayout(model, { decisions });
    for (const [id, kind] of marked.kinds) {
      expect(kind === 'decision').toBe(decisions.has(id));
    }
  });

  it('lays the same vault out the same way, whatever order its notes and threads come in', () => {
    const model = vault('large:11').model;
    const rnd = seededRandom(4);
    const shuffled = <T>(list: readonly T[]): T[] => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    const shape = (l: VolumeLayout) => ({
      radius: l.radius,
      positions: [...l.positions].sort(([x], [y]) => (x < y ? -1 : 1)),
      routes: [...l.routes]
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([k, line]) => [k, Array.from(line)]),
      adjacency: [...l.adjacency].sort(([x], [y]) => (x < y ? -1 : 1)),
      regions: l.regions.map((r) => [r.key, r.notes, r.centre, r.part]),
      owner: Array.from(l.owner),
    });
    const once = shape(layout('large:11'));
    expect(shape(volumeLayout(model))).toEqual(once);
    expect(
      shape(volumeLayout({ ...model, nodes: shuffled(model.nodes), edges: shuffled(model.edges) })),
    ).toEqual(once);
  });

  it('lays 1,600 notes out in under 60 ms', () => {
    const model = vault('large:11').model;
    volumeLayout(model);
    // The suite runs files in parallel, which can more than double a layout's
    // wall time, so it keeps timing until one layout fits, up to twenty: a slow
    // layout still fails every one.
    let best = Infinity;
    for (let k = 0; k < 20 && best >= 60; k++) {
      const t0 = performance.now();
      volumeLayout(model);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(60);
  });

  it('lays out a vault with no notes as a bare hub', () => {
    const model: GraphModel = { ...vault('sample:7').model, nodes: [], edges: [], projects: [] };
    const l = volumeLayout(model);
    expect(l.positions.size).toBe(0);
    expect(l.routes.size).toBe(0);
    expect(l.regions).toEqual([]);
    expect(l.radius).toBeGreaterThan(0);
    expect(l.stats.sites).toBeGreaterThan(0);
    expect(l.cluster.lobes).toEqual([]);
    expect(l.cluster.satellite).toBeNull();
  });

  it('keeps every project of twenty notes or more compact', () => {
    for (const name of VAULTS) {
      const l = layout(name);
      // Mean distance of its notes from their centroid, against a ball of as
      // many sites: a region grown as a skin round another comes out far over.
      let worst = 0;
      for (const r of l.regions) {
        if (r.notes.length < 20) continue;
        const ps = r.notes.map((id) => l.positions.get(id)!);
        const c = [0, 1, 2].map((k) => ps.reduce((sum, p) => sum + p[k]!, 0) / ps.length) as Vec3;
        const mean = ps.reduce((sum, p) => sum + distance(p, c), 0) / ps.length;
        worst = Math.max(worst, mean / (0.75 * ballRadius(r.notes.length, l.spacing)));
      }
      expect(worst).toBeGreaterThan(0);
      expect(worst).toBeLessThanOrEqual(1.4);
    }
  });

  it('grows in one piece on vaults it was not tuned on', () => {
    for (const name of ['large:1', 'large:2', 'large:3', 'large:11:300', 'large:11:3000']) {
      const l = volumeLayout(vault(name).model);
      expect(l.stats.pieces).toBe(0);
      expect(l.regions.every((r) => r.pieces === 0)).toBe(true);
      expect(l.positions.size).toBe(notesOf(vault(name).model).length);
      expect(l.stats.unplaced).toBe(0);
    }
  });

  it('grows every region whole where the first of several would leave the rest a skin', () => {
    const whole = (model: GraphModel) => {
      const l = volumeLayout(model);
      expect(l.positions.size).toBe(model.nodes.length);
      expect(l.stats.unplaced).toBe(0);
      expect(l.stats.pieces).toBe(0);
      for (const r of l.regions) expect(piecesOf(l, Array.from(r.sites))).toBe(1);
      return l;
    };

    // Two linked projects alone in the hub, the first most of it.
    for (const notes of [16, 50, 200]) {
      const l = whole(
        projectsVault(
          [
            { name: 'Orbit', notes },
            { name: 'Ledger', notes: 10 },
          ],
          [['Orbit', 'Ledger']],
        ),
      );
      expect(l.cluster.lobes).toEqual([]);
      expect(l.regions.every((r) => r.part === PART_HUB)).toBe(true);
    }

    // Two islands on the satellite, a moat round each.
    const two = whole(
      projectsVault(
        [
          { name: 'Orbit', notes: 300 },
          { name: 'Ledger', notes: 150 },
          { name: 'Atlas', notes: 80 },
          { name: 'Erebor', notes: 20 },
        ],
        [['Orbit', 'Ledger']],
      ),
    );
    const islands = two.regions.filter((r) => r.apart === 'island');
    expect(islands.map((r) => [r.label, r.part])).toEqual([
      ['Atlas', PART_SATELLITE],
      ['Erebor', PART_SATELLITE],
    ]);
    for (const r of islands) expect(moated(two, two.regions.indexOf(r))).toBe(true);

    // Somebody else's vault of three projects in one lobe.
    const shared = whole(
      projectsVault([
        { name: 'Orbit', notes: 47 },
        { name: 'Atlas', notes: 16, vault: 'ana' },
        { name: 'Ledger', notes: 7, vault: 'ana' },
        { name: 'Erebor', notes: 7, vault: 'ana' },
      ]),
    );
    const annex = shared.regions.filter((r) => r.vault === 'ana');
    expect(annex).toHaveLength(3);
    expect(annex.every((r) => r.part === lobePart(0))).toBe(true);
  });

  it('gives an island the satellite cannot hold ground of its own in the hub, behind a moat', () => {
    // Orbit and Ledger link to each other, Atlas and Erebor to nothing. Atlas
    // fills the satellite, so Erebor stays in the hub, claimed while the hub
    // is still open: after the others, every free site left would lie beside
    // somebody's ground, and it would get none.
    const model = projectsVault(
      [
        { name: 'Orbit', notes: 300 },
        { name: 'Ledger', notes: 150 },
        { name: 'Atlas', notes: 150 },
        { name: 'Erebor', notes: 20 },
      ],
      [['Orbit', 'Ledger']],
    );
    const l = volumeLayout(model);
    expect(l.positions.size).toBe(620);
    expect(l.stats).toMatchObject({ unplaced: 0, pieces: 0, lobes: 1, satellite: true });
    const at = (label: string) => l.regions.findIndex((r) => r.label === label);
    expect(l.regions[at('Atlas')]).toMatchObject({ apart: 'island', part: PART_SATELLITE });
    const erebor = l.regions[at('Erebor')]!;
    expect(erebor).toMatchObject({ apart: 'island', part: PART_HUB, pieces: 0 });
    expect(erebor.notes).toHaveLength(20);
    expect(moated(l, at('Erebor'))).toBe(true);
  });

  it('keeps a vault of one project a hub, and a shared vault bigger than your own in a lobe', () => {
    const base = vault('sample:7').model;
    const one = volumeLayout(remade(base, [() => ({ project: { id: 'solo', label: 'Solo' } })]));
    expect(one.cluster.lobes).toEqual([]);
    expect(one.cluster.satellite).toBeNull();
    expect(one.regions).toHaveLength(1);
    expect(one.regions[0]!.part).toBe(PART_HUB);
    expect(one.stats.pieces).toBe(0);

    // Your sample, and somebody else's vault twice its size.
    const shared = volumeLayout(
      remade(base, [
        () => ({}),
        (n) => ({ id: `ana/1/${n.id}`, vault: 'ana', ownerId: 'ana' }),
        (n) => ({
          id: `ana/2/${n.id}`,
          vault: 'ana',
          ownerId: 'ana',
          project: n.project && { id: `${n.project.id}-2`, label: n.project.label },
        }),
      ]),
    );
    expect(shared.cluster.lobes).toHaveLength(1);
    const lobe = shared.cluster.lobes[0]!;
    expect(shared.cluster.hub.radius).toBeGreaterThanOrEqual(1.1 * lobe.radius - 1e-9);
    const annex = shared.regions.filter((r) => r.vault === 'ana');
    expect(annex.length).toBeGreaterThan(1);
    expect(annex.every((r) => r.apart === 'annex' && r.part === lobePart(0))).toBe(true);
    expect(shared.stats.pieces).toBe(0);
    expect(shared.positions.size).toBe(3 * base.nodes.length);
  });
});
