import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import type { Vec3 } from '../../vec';

import { crystalFrame, crystalShape, type CrystalKind } from './crystals';

const KINDS: CrystalKind[] = ['note', 'index', 'decision'];

const vertex = (a: Float32Array, i: number): Vec3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Applies a column-major 4 × 4 matrix to a point. */
function apply(m: Float32Array, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

const column = (m: Float32Array, c: number): Vec3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

describe('crystal shapes', () => {
  it('cuts a note as a shard, an index as a geode and a decision as a diamond', () => {
    expect(crystalShape('note').triangles).toBe(12);
    expect(crystalShape('index').triangles).toBe(60);
    expect(crystalShape('decision').triangles).toBe(8);
  });

  it('turns every facet out of the gem, wound counter-clockwise from outside', () => {
    for (const kind of KINDS) {
      const s = crystalShape(kind);
      const n = s.triangles * 3;
      const mid: Vec3 = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const p = vertex(s.positions, i);
        mid[0] += p[0] / n;
        mid[1] += p[1] / n;
        mid[2] += p[2] / n;
      }
      for (let t = 0; t < s.triangles; t++) {
        const a = vertex(s.positions, t * 3);
        const b = vertex(s.positions, t * 3 + 1);
        const c = vertex(s.positions, t * 3 + 2);
        const wound = cross(
          [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
          [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        );
        const centroid: Vec3 = [
          (a[0] + b[0] + c[0]) / 3 - mid[0],
          (a[1] + b[1] + c[1]) / 3 - mid[1],
          (a[2] + b[2] + c[2]) / 3 - mid[2],
        ];
        expect(dot(wound, centroid)).toBeGreaterThan(0);
        for (let k = 0; k < 3; k++) {
          const normal = vertex(s.normals, t * 3 + k);
          expect(length(normal)).toBeCloseTo(1, 5);
          // The same flat normal at all three corners: the facet's own.
          expect(dot(normal, wound) / length(wound)).toBeCloseTo(1, 5);
        }
      }
    }
  });

  it('closes every gem: each edge is shared by two facets, one each way round', () => {
    for (const kind of KINDS) {
      const s = crystalShape(kind);
      const key = (p: Vec3) => p.map((x) => x.toFixed(5)).join(',');
      const directed = new Map<string, number>();
      for (let t = 0; t < s.triangles; t++) {
        for (let k = 0; k < 3; k++) {
          const from = key(vertex(s.positions, t * 3 + k));
          const to = key(vertex(s.positions, t * 3 + ((k + 1) % 3)));
          const edge = `${from}>${to}`;
          directed.set(edge, (directed.get(edge) ?? 0) + 1);
        }
      }
      for (const [edge, count] of directed) {
        expect(count).toBe(1);
        const [from, to] = edge.split('>');
        expect(directed.get(`${to}>${from}`)).toBe(1);
      }
    }
  });

  it('marks each corner of a facet apart, so every edge of the gem can be drawn', () => {
    for (const kind of KINDS) {
      const s = crystalShape(kind);
      for (let t = 0; t < s.triangles; t++) {
        for (let k = 0; k < 3; k++) {
          const e = vertex(s.edges, t * 3 + k);
          expect(e[k]).toBe(1);
          expect(e[0] + e[1] + e[2]).toBe(1);
        }
      }
    }
  });

  it('puts the crown at the top, one footprint across, with the light inside', () => {
    for (const kind of KINDS) {
      const s = crystalShape(kind);
      let top = -Infinity;
      let wide = 0;
      for (let i = 0; i < s.triangles * 3; i++) {
        const p = vertex(s.positions, i);
        top = Math.max(top, p[1]);
        wide = Math.max(wide, Math.hypot(p[0], p[2]));
      }
      expect(top).toBeCloseTo(0, 6);
      expect(wide).toBeCloseTo(1, 6);
      expect(s.bottom).toBeLessThan(-0.5);
      expect(s.coreY).toBeLessThan(0);
      expect(s.coreY).toBeGreaterThan(s.bottom);
      // The light's sphere fits between crown and keel.
      expect(s.coreR).toBeLessThan(Math.min(-s.coreY, s.coreY - s.bottom));
    }
  });

  it('squashes the geode flatter than it is wide', () => {
    const s = crystalShape('index');
    expect(-s.bottom).toBeLessThan(1.4);
    expect(-crystalShape('note').bottom).toBeGreaterThan(1.6);
  });
});

describe('turning a crystal about its note', () => {
  const unit = 10;
  /** Three seeded numbers in [0, 1): a turn. */
  const turnOf = (random: () => number): [number, number, number] => [random(), random(), random()];

  it('puts its light on the note and keeps the whole gem round it, square and right-handed', () => {
    const random = seededRandom(5);
    const m = new Float32Array(16);
    const shapes = KINDS.map(crystalShape);
    for (let i = 0; i < 200; i++) {
      const s = shapes[i % 3]!;
      // Off the origin, as far out as a large cluster reaches.
      const position: Vec3 = [
        (random() - 0.5) * 600,
        (random() - 0.5) * 600,
        (random() - 0.5) * 600,
      ];
      const radius = unit * (0.1 + random() * 0.3);
      const stretch = 0.9 + random() * 0.2;
      crystalFrame({ position, turn: turnOf(random), radius, stretch, core: s.coreY }, m);
      const light = apply(m, [0, s.coreY, 0]);
      for (let k = 0; k < 3; k++) expect(Math.abs(light[k]! - position[k]!)).toBeLessThan(1e-4);
      // Every corner within the gem's own reach of the note: a gem left at its
      // crown, or off its note, would reach further.
      const reach = radius * Math.max(1, stretch) * (1 - s.bottom);
      for (let v = 0; v < s.triangles * 3; v++) {
        const p = apply(m, vertex(s.positions, v));
        const off: Vec3 = [p[0] - position[0], p[1] - position[1], p[2] - position[2]];
        expect(length(off)).toBeLessThanOrEqual(reach + 1e-4);
      }
      // Square and right-handed, so facets stay wound outwards, and scaled as its kind.
      const x = column(m, 0);
      const y = column(m, 1);
      const z = column(m, 2);
      expect(Math.abs(dot(x, y)) / (length(x) * length(y))).toBeLessThan(1e-5);
      expect(Math.abs(dot(y, z)) / (length(y) * length(z))).toBeLessThan(1e-5);
      expect(Math.abs(dot(z, x)) / (length(z) * length(x))).toBeLessThan(1e-5);
      expect(dot(cross(x, y), z)).toBeGreaterThan(0);
      expect(length(x)).toBeCloseTo(radius, 4);
      expect(length(y)).toBeCloseTo(radius * stretch, 4);
      expect(length(z)).toBeCloseTo(radius, 4);
    }
  });

  it('turns gems every way, with no favoured axis', () => {
    const random = seededRandom(11);
    const m = new Float32Array(16);
    const mean: Vec3 = [0, 0, 0];
    const signs = [new Set<number>(), new Set<number>(), new Set<number>()];
    const n = 500;
    for (let i = 0; i < n; i++) {
      crystalFrame(
        { position: [0, 0, 0], turn: turnOf(random), radius: 1, stretch: 1, core: 0 },
        m,
      );
      const y = column(m, 1);
      for (let k = 0; k < 3; k++) {
        mean[k] = mean[k]! + y[k]! / n;
        signs[k]!.add(Math.sign(y[k]!));
      }
    }
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(mean[k]!)).toBeLessThan(0.15);
      expect(signs[k]!.has(1) && signs[k]!.has(-1)).toBe(true);
    }
  });

  it('is finite at the ends of a turn', () => {
    const m = new Float32Array(16);
    for (const turn of [
      [0, 0, 0],
      [0.999999, 0.999999, 0.999999],
    ] as [number, number, number][]) {
      crystalFrame({ position: [1, 2, 3], turn, radius: 2, stretch: 1.1, core: -0.4 }, m);
      expect(Array.from(m).every(Number.isFinite)).toBe(true);
      expect(length(column(m, 0))).toBeCloseTo(2, 5);
      expect(dot(cross(column(m, 0), column(m, 1)), column(m, 2))).toBeGreaterThan(0);
    }
  });
});
