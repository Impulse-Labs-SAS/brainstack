import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import { threadEnds, threadKey, type ThreadKey } from '../threads';
import { dist, type Vec3 } from '../vec';

import { polylineThreadField, type PolylineFieldInput } from './polyline-field';

const key = (a: string, b: string) => threadKey({ id: a }, { id: b });

/**
 * A field from notes and lines drawn from one note to another through the
 * corners given, whichever way round the key names them.
 */
function fieldOf(
  nodes: Record<string, Vec3>,
  lines: ReadonlyArray<[string, string, Vec3[]]>,
  extra: Partial<PolylineFieldInput> = {},
) {
  const routes = new Map<ThreadKey, Float32Array>();
  const adjacency = new Map<string, ThreadKey[]>();
  for (const [a, b, corners] of lines) {
    const k = key(a, b);
    const points = [nodes[a]!, ...corners, nodes[b]!];
    if (threadEnds(k)[0] !== a) points.reverse();
    routes.set(k, Float32Array.from(points.flat()));
    for (const id of [a, b]) adjacency.set(id, [...(adjacency.get(id) ?? []), k]);
  }
  const field = polylineThreadField({
    nodes: new Map(Object.entries(nodes)),
    routes,
    adjacency,
    cell: 10,
    ...extra,
  });
  return { field, routes };
}

/** An L: 30 along x, then 40 up y. Named so that the key runs from `a` to `b`. */
const L = () => fieldOf({ a: [0, 0, 0], b: [30, 40, 0] }, [['a', 'b', [[30, 0, 0]]]]);

/** Where a point of the L lies along it, measured from `a`. */
const alongL = (p: Vec3) => (p[1] < 1e-6 ? p[0] : 30 + p[1]);

/** The closest point of segment a→b to q, and its squared distance. */
function onSegment(q: Vec3, a: Vec3, b: Vec3): { f: number; d2: number } {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const raw =
    l2 > 0 ? ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / l2 : 0;
  const f = Math.max(0, Math.min(1, raw));
  const p: Vec3 = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f];
  const d = dist(p, q);
  return { f, d2: d * d };
}

const pointsOf = (route: Float32Array): Vec3[] =>
  Array.from({ length: route.length / 3 }, (_, i) => [
    route[i * 3]!,
    route[i * 3 + 1]!,
    route[i * 3 + 2]!,
  ]);

describe('polylineThreadField', () => {
  it('is as long as its line, elbows and all', () => {
    expect(L().field.length(key('a', 'b'))).toBeCloseTo(70, 9);
    // A Z: 10 along x, 20 up z, 10 along x again.
    const z = fieldOf({ a: [0, 0, 0], b: [20, 0, 20] }, [
      [
        'a',
        'b',
        [
          [10, 0, 0],
          [10, 0, 20],
        ],
      ],
    ]);
    expect(z.field.length(key('a', 'b'))).toBeCloseTo(40, 9);
  });

  it('moves an even distance for an even step along the thread, round its elbows', () => {
    const { field } = L();
    const k = key('a', 'b');
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i <= 140; i++) {
      expect(field.point(k, i / 140, p)).toBe(true);
      expect(p[0] === 30 || p[1] === 0).toBe(true);
      expect(alongL(p)).toBeCloseTo((70 * i) / 140, 4);
    }

    // However the line is cut up: the second leg in many short pieces, the first in one.
    const corners: Vec3[] = [[30, 0, 0]];
    for (let y = 1; y < 40; y += 1.5) corners.push([30, y, 0]);
    const fine = fieldOf({ a: [0, 0, 0], b: [30, 40, 0] }, [['a', 'b', corners]]).field;
    for (let i = 0; i <= 70; i++) {
      fine.point(k, i / 70, p);
      expect(alongL(p)).toBeCloseTo(i, 4);
    }
  });

  it("starts at its key's first note and ends at its second, whichever way it was linked", () => {
    const nodes: Record<string, Vec3> = { zeta: [5, 1, 2], alpha: [-7, 3, 9] };
    // Linked from zeta to alpha; the key runs from alpha, the first id.
    const { field } = fieldOf(nodes, [['zeta', 'alpha', [[5, 3, 2]]]]);
    const k = key('zeta', 'alpha');
    expect(threadEnds(k)).toEqual(['alpha', 'zeta']);
    const p: Vec3 = [0, 0, 0];
    field.point(k, 0, p);
    expect(dist(p, nodes.alpha!)).toBeLessThan(1e-6);
    field.point(k, 1, p);
    expect(dist(p, nodes.zeta!)).toBeLessThan(1e-6);
    // Past either end, it stays at the note.
    field.point(k, -0.5, p);
    expect(dist(p, nodes.alpha!)).toBeLessThan(1e-6);
    field.point(k, 1.5, p);
    expect(dist(p, nodes.zeta!)).toBeLessThan(1e-6);
  });

  it('finds the closest point of a thread with u kept within [uMin, uMax]', () => {
    const { field } = L();
    const k = key('a', 'b');
    const at = (u: number): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      field.point(k, u, p);
      return p;
    };
    // Off the first leg: the foot of the perpendicular.
    const free = field.closest(k, [12, -5, 0])!;
    expect(free.u).toBeCloseTo(12 / 70, 6);
    expect(free.d2).toBeCloseTo(25, 4);
    // At the notes themselves, held back from them.
    const start = field.closest(k, [0, 0, 0], 0.2, 0.8)!;
    expect(start.u).toBeCloseTo(0.2, 6);
    expect(dist(start.p, at(0.2))).toBeLessThan(1e-4);
    const end = field.closest(k, [30, 40, 0], 0.2, 0.8)!;
    expect(end.u).toBeCloseTo(0.8, 6);
    expect(dist(end.p, at(0.8))).toBeLessThan(1e-4);

    // Anywhere, never outside the range, and never further than the closest point sampled inside it.
    const rnd = seededRandom(11);
    for (let i = 0; i < 300; i++) {
      const q: Vec3 = [rnd() * 60 - 15, rnd() * 60 - 10, rnd() * 20 - 10];
      const uMin = rnd() * 0.5;
      const uMax = uMin + rnd() * (1 - uMin);
      const c = field.closest(k, q, uMin, uMax)!;
      expect(c.u).toBeGreaterThanOrEqual(uMin - 1e-9);
      expect(c.u).toBeLessThanOrEqual(uMax + 1e-9);
      expect(dist(c.p, at(c.u))).toBeLessThan(1e-3);
      let sampled = Infinity;
      for (let j = 0; j <= 400; j++) {
        const d = dist(q, at(uMin + ((uMax - uMin) * j) / 400));
        sampled = Math.min(sampled, d * d);
      }
      expect(c.d2).toBeLessThanOrEqual(sampled + 1e-3);
    }
  });

  it('keeps u within [uMin, uMax] on a line that repeats a point', () => {
    // An L whose corner falls on its first note, as a route between two
    // notes in line draws it: the line starts with a piece of no length.
    const { field } = fieldOf({ a: [0, 0, 0], b: [0, 40, 0] }, [['a', 'b', [[0, 0, 0]]]]);
    const c = field.closest(key('a', 'b'), [0, -3, 0], 0.1, 0.9)!;
    expect(c.u).toBeCloseTo(0.1, 6);
    expect(c.p[1]).toBeCloseTo(4, 4);
  });

  it('finds the threads near a point exactly as a search of every thread does', () => {
    const rnd = seededRandom(23);
    const nodes: Record<string, Vec3> = {};
    for (let i = 0; i < 40; i++) nodes[`n${i}`] = [rnd() * 200, rnd() * 200, rnd() * 200];
    const lines: Array<[string, string, Vec3[]]> = [];
    const seen = new Set<ThreadKey>();
    while (lines.length < 120) {
      const a = `n${Math.floor(rnd() * 40)}`;
      const b = `n${Math.floor(rnd() * 40)}`;
      if (a === b || seen.has(key(a, b))) continue;
      seen.add(key(a, b));
      const pa = nodes[a]!;
      const pb = nodes[b]!;
      // Pipes with elbows, as a space routes them, and lines wandering anywhere.
      const corners: Vec3[] =
        rnd() < 0.5
          ? [
              [pb[0], pa[1], pa[2]],
              [pb[0], pb[1], pa[2]],
            ]
          : Array.from({ length: Math.floor(rnd() * 4) }, () => [
              rnd() * 200,
              rnd() * 200,
              rnd() * 200,
            ]);
      lines.push([a, b, corners]);
    }
    const hidden = new Set(['n3', 'n17']);
    const shown = (id: string) => !hidden.has(id);

    // Cells much finer than the lines' segments, about the radius, coarser
    // than everything, and none that makes sense (it falls back to one that does).
    for (const cell of [4, 10, 40, 500, Number.NaN]) {
      const { field, routes } = fieldOf(nodes, lines, { shown, cell });
      for (let i = 0; i < 100; i++) {
        const q: Vec3 = [rnd() * 240 - 20, rnd() * 240 - 20, rnd() * 240 - 20];
        const r = 5 + rnd() * 55;
        // Every drawn thread's distance, the slow way.
        const d2 = new Map<ThreadKey, number>();
        for (const [k, route] of routes) {
          if (!threadEnds(k).every(shown)) continue;
          const pts = pointsOf(route);
          let best = Infinity;
          for (let j = 0; j + 1 < pts.length; j++) {
            best = Math.min(best, onSegment(q, pts[j]!, pts[j + 1]!).d2);
          }
          d2.set(k, best);
        }
        // Threads meeting at a note are equally near when the note is the
        // nearest point; rounding may order them either way.
        const eps = 1e-6 * r * r;
        const within = [...d2.values()].filter((d) => d <= r * r - eps).length;
        for (const max of [1, 3, 1000]) {
          const near = field.nearby(q, r, max);
          const ds = near.map((k) => d2.get(k)!);
          const worst = ds.at(-1) ?? -Infinity;
          // Thousands of checks: gathered, and asserted once a query.
          const wrong: string[] = [];
          if (new Set(near).size !== near.length) wrong.push('a thread twice');
          if (near.length > max) wrong.push('more than max');
          if (near.length < Math.min(max, within)) wrong.push('fewer than there are');
          ds.forEach((d, j) => {
            if (d > r * r + eps) wrong.push(`${near[j]} beyond the radius`);
            if (j > 0 && d < ds[j - 1]! - eps) wrong.push(`${near[j]} out of order`);
          });
          for (const [k, d] of d2) {
            if (d > r * r - eps || near.includes(k)) continue;
            if (near.length < max || d < worst - eps) wrong.push(`${k} left out`);
          }
          expect(wrong).toEqual([]);
        }
      }
    }
  });

  it('walks the threads around notes by hops, up to a limit', () => {
    const nodes: Record<string, Vec3> = {
      a: [0, 0, 0],
      b: [10, 0, 0],
      c: [20, 0, 0],
      d: [30, 0, 0],
      x: [10, 10, 0],
      far: [500, 0, 0],
    };
    const lines: Array<[string, string, Vec3[]]> = [
      ['a', 'b', []],
      ['b', 'c', [[15, 5, 0]]],
      ['c', 'd', []],
      ['b', 'x', []],
      ['d', 'far', []],
    ];
    const { field } = fieldOf(nodes, lines);
    const sorted = (keys: ThreadKey[]) => [...keys].sort();
    expect(field.around(['a'], 1, 10)).toEqual([key('a', 'b')]);
    expect(sorted(field.around(['a'], 2, 10))).toEqual(
      sorted([key('a', 'b'), key('b', 'c'), key('b', 'x')]),
    );
    expect(sorted(field.around(['c'], 1, 10))).toEqual(sorted([key('b', 'c'), key('c', 'd')]));
    expect(sorted(field.around(['a', 'd'], 1, 10))).toEqual(
      sorted([key('a', 'b'), key('c', 'd'), key('d', 'far')]),
    );
    expect(field.around(['a'], 2, 2)).toHaveLength(2);
    expect(field.around(['nobody'], 2, 10)).toEqual([]);

    // A hidden note cuts the way through it.
    const cut = fieldOf(nodes, lines, { shown: (id) => id !== 'b' }).field;
    expect(cut.around(['a'], 2, 10)).toEqual([]);
    expect(sorted(cut.around(['c'], 2, 10))).toEqual(sorted([key('c', 'd'), key('d', 'far')]));
  });

  it('hides a thread when either of its notes is hidden', () => {
    const nodes: Record<string, Vec3> = { a: [0, 0, 0], b: [10, 0, 0], c: [10, 10, 0] };
    const { field } = fieldOf(
      nodes,
      [
        ['a', 'b', [[5, 0, 0]]],
        ['b', 'c', []],
        ['a', 'c', [[0, 10, 0]]],
      ],
      { shown: (id) => id !== 'b' },
    );
    const p: Vec3 = [0, 0, 0];
    for (const k of [key('a', 'b'), key('b', 'c')]) {
      expect(field.has(k)).toBe(false);
      expect(field.point(k, 0.5, p)).toBe(false);
      expect(field.closest(k, [5, 0, 0])).toBeNull();
    }
    expect(field.node('b', p)).toBe(false);
    expect(field.has(key('a', 'c'))).toBe(true);
    expect(field.node('a', p)).toBe(true);
    // Standing on the hidden thread, only the one still drawn is near.
    expect(field.nearby([5, 0, 0], 20, 10)).toEqual([key('a', 'c')]);
  });

  it('does not draw a thread whose line has no place yet', () => {
    const nodes: Record<string, Vec3> = { a: [0, 0, 0], b: [10, 0, 0] };
    const { field } = fieldOf(nodes, [['a', 'b', [[Number.NaN, 0, 0]]]]);
    const p: Vec3 = [0, 0, 0];
    expect(field.has(key('a', 'b'))).toBe(false);
    expect(field.point(key('a', 'b'), 0.5, p)).toBe(false);
    expect(field.nearby([5, 0, 0], 20, 10)).toEqual([]);
  });

  it('says which way is up', () => {
    const p: Vec3 = [0, 0, 0];
    L().field.up([3, 4, 5], p);
    expect(p).toEqual([0, 1, 0]);
    fieldOf({ a: [0, 0, 0] }, [], { up: [0, 0, 1] }).field.up([3, 4, 5], p);
    expect(p).toEqual([0, 0, 1]);
  });
});
