import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import type { Vec3 } from '../../vec';

import { PARTS, SITE_INSET, clusterFor, clusterSdf, probe, type ClusterNeeds } from './cluster';
import { LATTICE_TURN, fccStep, nearestSite } from './fcc';
import { fccLattice, type VolumeLattice } from './lattice';

/** World units between sites: the layout's 1.7 creature units of 10. */
const A = 17;
/** A 1,600-note vault's needs, and the sample's: a hub alone and a satellite. */
const LARGE: ClusterNeeds = { hub: 1372, lobes: [293, 168, 123, 98, 90, 70, 58], satellite: 22 };
const SMALL: ClusterNeeds = { hub: 88, lobes: [], satellite: 15 };

const pointOf = (l: VolumeLattice, v: number): Vec3 => [
  l.points[v * 3]!,
  l.points[v * 3 + 1]!,
  l.points[v * 3 + 2]!,
];
const neighbours = (l: VolumeLattice, v: number) =>
  Array.from(l.adj.subarray(l.offsets[v], l.offsets[v + 1]));
const distance = (u: Vec3, v: Vec3) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
/** Lattice coordinates of a world point: the turn's transpose, over the step. */
const coordinates = (p: Vec3): Vec3 => {
  const m = LATTICE_TURN;
  const s = fccStep(A);
  return [
    (m[0]! * p[0] + m[3]! * p[1] + m[6]! * p[2]) / s,
    (m[1]! * p[0] + m[4]! * p[1] + m[7]! * p[2]) / s,
    (m[2]! * p[0] + m[5]! * p[1] + m[8]! * p[2]) / s,
  ];
};

describe('fccLattice', () => {
  for (const [name, needs] of [
    ['a large vault’s cluster', LARGE],
    ['the sample’s', SMALL],
  ] as const) {
    it(`fills ${name} with sites, each well inside it, twelve neighbours a spacing apart`, () => {
      const c = clusterFor(needs, { spacing: A, neck: 2 });
      const l = fccLattice(c);
      expect(l.spacing).toBe(A);
      expect(l.count).toBeGreaterThan(needs.hub);
      // Measured over every site, then checked once: an expect per site takes seconds.
      let deepest = -Infinity;
      let wrongPart = 0;
      let lo = Infinity;
      let hi = 0;
      let crowded = 0;
      let lopsided = 0;
      let unsorted = 0;
      const out = { d: 0, part: 0 };
      for (let v = 0; v < l.count; v++) {
        const p = pointOf(l, v);
        deepest = Math.max(deepest, clusterSdf(c, p));
        if (probe(c, p[0], p[1], p[2], out).part !== l.part[v]) wrongPart++;
        const near = neighbours(l, v);
        if (near.length > 12) crowded++;
        near.forEach((w, k) => {
          if (k > 0 && near[k - 1]! >= w) unsorted++;
          if (!neighbours(l, w).includes(v)) lopsided++;
          const d = distance(p, pointOf(l, w));
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        });
      }
      expect(deepest).toBeLessThanOrEqual(-SITE_INSET * A + 1e-9);
      expect(wrongPart).toBe(0);
      expect(lo / A).toBeCloseTo(1, 9);
      expect(hi / A).toBeCloseTo(1, 9);
      expect([crowded, lopsided, unsorted]).toEqual([0, 0, 0]);
      // Somewhere deep inside, a site has all twelve.
      expect(Math.max(...Array.from({ length: l.count }, (_, v) => neighbours(l, v).length))).toBe(
        12,
      );

      expect(l.counts).toHaveLength(PARTS);
      expect(l.counts.reduce((sum, n) => sum + n, 0)).toBe(l.count);
      const tally = new Int32Array(PARTS);
      for (const p of l.part) tally[p]!++;
      expect(Array.from(tally)).toEqual(Array.from(l.counts));
    });
  }

  it('stands a site on the centre of every bulb', () => {
    for (const needs of [LARGE, SMALL]) {
      const c = clusterFor(needs, { spacing: A, neck: 2 });
      const l = fccLattice(c);
      for (const b of [c.hub, ...c.lobes, c.satellite!]) {
        let nearest = Infinity;
        for (let v = 0; v < l.count; v++)
          nearest = Math.min(nearest, distance(pointOf(l, v), b.centre));
        expect(nearest).toBeLessThan(1e-9);
      }
    }
  });

  it('numbers the same cluster’s sites the same way', () => {
    const c = clusterFor(LARGE, { spacing: A, neck: 2 });
    const once = fccLattice(c);
    const again = fccLattice(c);
    expect(again.count).toBe(once.count);
    expect(Array.from(again.points)).toEqual(Array.from(once.points));
    expect(Array.from(again.part)).toEqual(Array.from(once.part));
    expect(Array.from(again.adj)).toEqual(Array.from(once.adj));
    expect(Array.from(again.offsets)).toEqual(Array.from(once.offsets));
  });
});

describe('nearestSite', () => {
  it('returns the lattice point nearest any point', () => {
    const rnd = seededRandom(5);
    const s = fccStep(A);
    const t = LATTICE_TURN;
    // Counted over every point, then checked once: an expect per pair takes seconds.
    let offLattice = 0;
    let odd = 0;
    let farthest = 0;
    let beaten = 0;
    for (let k = 0; k < 500; k++) {
      const p: Vec3 = [0, 1, 2].map(() => (rnd() - 0.5) * 400) as Vec3;
      const site = nearestSite(p, A);
      // A lattice point: integer coordinates with an even sum.
      const q = coordinates(site);
      const r = q.map(Math.round);
      if (!q.every((x, i) => Math.abs(x - r[i]!) < 1e-9)) offLattice++;
      if ((r[0]! + r[1]! + r[2]!) % 2 !== 0) odd++;
      // No lattice point round it is nearer, and none is ever further than a deep hole.
      const d = distance(p, site);
      farthest = Math.max(farthest, d);
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          for (let m = -2; m <= 2; m++) {
            if ((i + j + m) % 2 !== 0) continue;
            const [x, y, z] = [r[0]! + i, r[1]! + j, r[2]! + m];
            const other: Vec3 = [
              (t[0]! * x + t[1]! * y + t[2]! * z) * s,
              (t[3]! * x + t[4]! * y + t[5]! * z) * s,
              (t[6]! * x + t[7]! * y + t[8]! * z) * s,
            ];
            if (distance(p, other) < d - 1e-9) beaten++;
          }
        }
      }
    }
    expect([offLattice, odd, beaten]).toEqual([0, 0, 0]);
    expect(farthest).toBeLessThanOrEqual(A / Math.SQRT2 + 1e-9);
  });

  it('turns the lattice off every world axis', () => {
    // The lattice's own axes, in the world: none lines up with x, y or z.
    const t = LATTICE_TURN;
    for (let col = 0; col < 3; col++) {
      const axis = [t[col]!, t[3 + col]!, t[6 + col]!];
      expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
      for (const x of axis) expect(Math.abs(x)).toBeLessThan(0.99);
    }
  });
});
