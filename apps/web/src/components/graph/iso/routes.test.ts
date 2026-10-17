// Cables along the streets, checked on invented layouts: every stretch runs along an axis, on the
// top of the plate it crosses, never across a plate standing there or through a block, from one
// note's block to the other's.

import { describe, expect, it } from 'vitest';

import { isIndexNote } from '@/lib/graph-structure';

import { BLOCK } from './block';
import {
  GAPS,
  layoutIso,
  type IsoLayout,
  type IsoPlate,
  type LayoutNote,
  type LayoutVault,
} from './layout/territories';
import { ROUTE_LIFT, projectRoutes, routeBetween, routesFrom, type Vec3 } from './routes';

const TOL = 1e-6;
/** `cells` holds a block's centre as a float32: its faces are where they are to a few ulps. */
const CELL_TOL = 1e-4;
const HB = BLOCK / 2;

const VAULTS: LayoutVault[] = [
  { id: 'own', label: 'Your vault', shared: false },
  { id: 'eowyn', label: 'Rohan', shared: true },
];

function note(vault: string, path: string, createdAt = 1_000): LayoutNote {
  const project = path.split('/')[0]!;
  return {
    id: `${vault}/${path}`,
    path,
    project: `${vault}|${project}`,
    projectLabel: project,
    vault,
    isIndex: isIndexNote(path),
    createdAt,
  };
}

const many = (vault: string, folder: string, n: number, from = 2_000) =>
  Array.from({ length: n }, (_, i) => note(vault, `${folder}/note ${i}.md`, from + i));

// Your vault with three projects of different shapes — one with folders and a sub-folder, one
// whose notes all share a folder, one flat — and a shared vault with one project.
const NOTES: LayoutNote[] = [
  note('own', 'Orbit/_Orbit.md', 500),
  note('own', 'Orbit/plan.md', 900),
  note('own', 'Orbit/brief.md', 800),
  ...many('own', 'Orbit/Ledger', 5),
  ...many('own', 'Orbit/Ledger/Q1', 3),
  ...many('own', 'Orbit/Atlas', 4),
  ...many('own', 'Gondor/Minas', 6),
  ...many('own', 'Erebor', 12),
  note('eowyn', 'Rohan/_Rohan.md', 10),
  ...many('eowyn', 'Rohan/Edoras', 7),
];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const rect = (p: IsoPlate): Box => ({ x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h });
const grow = (b: Box, d: number): Box => ({
  x0: b.x0 - d,
  y0: b.y0 - d,
  x1: b.x1 + d,
  y1: b.y1 + d,
});
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const holds = (r: Box, p: readonly number[]) =>
  p[0]! >= r.x0 - TOL && p[0]! <= r.x1 + TOL && p[1]! >= r.y0 - TOL && p[1]! <= r.y1 + TOL;
const onEdge = (r: Box, p: readonly number[]) =>
  holds(r, p) && (near(p[0]!, r.x0) || near(p[0]!, r.x1) || near(p[1]!, r.y0) || near(p[1]!, r.y1));
/** Whether the open segment p–q meets the inside of `r`, shrunk by `tol`. */
const crosses = (p: Vec3, q: Vec3, r: Box, tol = TOL) =>
  Math.min(p[0], q[0]) < r.x1 - tol &&
  Math.max(p[0], q[0]) > r.x0 + tol &&
  Math.min(p[1], q[1]) < r.y1 - tol &&
  Math.max(p[1], q[1]) > r.y0 + tol;
const fmt = (p: Vec3) => `(${p.map((v) => +v.toFixed(3)).join(', ')})`;

/** A plate (or the world, -1) as cables cross it: the height they run at, box, half a street. */
function geometry(layout: IsoLayout) {
  const { plates } = layout;
  return {
    top: (c: number) => (c < 0 ? 0 : plates[c]!.z1) + ROUTE_LIFT,
    box: (c: number): Box => (c < 0 ? grow(layout.bounds, GAPS.world) : rect(plates[c]!)),
    ro: (c: number) => (c < 0 ? GAPS.world : GAPS[plates[c]!.kind]) / 2,
  };
}

/** Everything wrong with a cable's path across the map, as a list: empty when it is sound. */
function problems(layout: IsoLayout, points: readonly Vec3[]): string[] {
  const out: string[] = [];
  const { plates } = layout;
  const { top, box, ro } = geometry(layout);
  const places = [-1, ...plates.keys()];
  for (let k = 1; k < points.length; k++) {
    const [p, q] = [points[k - 1]!, points[k]!];
    const where = `${k}: ${fmt(p)} → ${fmt(q)}`;
    const moved = [0, 1, 2].filter((d) => !near(p[d]!, q[d]!));
    if (moved.length !== 1) {
      out.push(`${where}: not along one axis`);
      continue;
    }
    if (moved[0] === 2) {
      const [lo, hi] = [Math.min(p[2], q[2]), Math.max(p[2], q[2])];
      const drop = plates.some(
        (pl, i) => near(top(i), hi) && near(top(pl.parent), lo) && onEdge(rect(pl), p),
      );
      if (!drop) out.push(`${where}: a vertical that is no drop off a plate's edge`);
      continue;
    }
    // The top it runs on, by the height it runs at and where it is.
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const on = places.filter((c) => near(top(c), p[2]) && holds(box(c), mid));
    if (on.length !== 1) {
      out.push(`${where}: on ${on.length} plates`);
      continue;
    }
    const c = on[0]!;
    const b = box(c);
    if (!holds(b, p) || !holds(b, q)) out.push(`${where}: off the top it runs on`);
    // Along the rim it would trace the plate's own outline: a cable only steps off it.
    const rim =
      (near(p[0], q[0]) && (near(p[0], b.x0) || near(p[0], b.x1))) ||
      (near(p[1], q[1]) && (near(p[1], b.y0) || near(p[1], b.y1)));
    if (rim) out.push(`${where}: along the rim`);
    // Never across a plate standing there, and into the street round one only to or from its edge.
    for (const pl of plates) {
      if (pl.parent !== c) continue;
      const r = rect(pl);
      if (crosses(p, q, r)) out.push(`${where}: across ${pl.id}`);
      else if (crosses(p, q, grow(r, ro(c))) && !onEdge(r, p) && !onEdge(r, q))
        out.push(`${where}: off the street round ${pl.id}`);
    }
    for (let n = 0; n < layout.ids.length; n++) {
      if (layout.plateOf[n] !== c) continue;
      const [x, y] = [layout.cells[n * 3]!, layout.cells[n * 3 + 1]!];
      const foot = { x0: x - HB, y0: y - HB, x1: x + HB, y1: y + HB };
      if (crosses(p, q, foot, CELL_TOL)) out.push(`${where}: through ${layout.ids[n]}`);
    }
  }
  return out;
}

/** Whether `p` is the middle of a side of note `n`'s block, as high as cables cross its plate. */
function onBlock(layout: IsoLayout, n: number, p: Vec3): boolean {
  const dx = Math.abs(p[0] - layout.cells[n * 3]!);
  const dy = Math.abs(p[1] - layout.cells[n * 3 + 1]!);
  const side =
    (near(dx, HB, CELL_TOL) && dy < CELL_TOL) || (near(dy, HB, CELL_TOL) && dx < CELL_TOL);
  return side && near(p[2], layout.plates[layout.plateOf[n]!]!.z1 + ROUTE_LIFT);
}

/** The nearest plate both notes stand on or over; -1, the world, when there is none. */
function meetOf(layout: IsoLayout, a: number, b: number): number {
  const chain = (from: number) => {
    const out: number[] = [];
    for (let c = from; c >= 0; c = layout.plates[c]!.parent) out.push(c);
    return out;
  };
  const up = chain(layout.plateOf[a]!);
  return chain(layout.plateOf[b]!).find((c) => up.includes(c)) ?? -1;
}

const plateIndex = (layout: IsoLayout, id: string) => {
  const i = layout.plates.findIndex((p) => p.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return i;
};
const noteIndex = (layout: IsoLayout, id: string) => {
  const i = layout.ids.indexOf(id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return i;
};

/** Every ordered pair of different notes. */
function pairs(layout: IsoLayout): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < layout.ids.length; a++) {
    for (let b = 0; b < layout.ids.length; b++) if (a !== b) out.push([a, b]);
  }
  return out;
}

describe('routeBetween', () => {
  const layout = layoutIso(NOTES, VAULTS);

  it("runs every cable along the streets, from one note's block to the other's", () => {
    const bad: string[] = [];
    for (const [a, b] of pairs(layout)) {
      const { points } = routeBetween(layout, a, b);
      const name = `${layout.ids[a]} → ${layout.ids[b]}`;
      if (points.length < 2) {
        bad.push(`${name}: no cable`);
        continue;
      }
      if (!onBlock(layout, a, points[0]!)) bad.push(`${name}: does not leave its block`);
      if (!onBlock(layout, b, points.at(-1)!)) bad.push(`${name}: does not reach the other`);
      for (const p of problems(layout, points)) bad.push(`${name} ${p}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it('steps down to the nearest plate under both notes, and no further', () => {
    const { top } = geometry(layout);
    const bad: string[] = [];
    let acrossVaults = 0;
    for (const [a, b] of pairs(layout)) {
      const zs = routeBetween(layout, a, b).points.map((p) => p[2]);
      const meet = meetOf(layout, a, b);
      if (meet < 0) acrossVaults++;
      const lowest = Math.min(...zs);
      const turn = zs.indexOf(lowest);
      const down = zs.slice(0, turn + 1).every((z, i) => i === 0 || z <= zs[i - 1]! + TOL);
      const up = zs.slice(turn).every((z, i, rest) => i === 0 || z >= rest[i - 1]! - TOL);
      if (!near(lowest, top(meet)) || !down || !up)
        bad.push(`${layout.ids[a]} → ${layout.ids[b]}: ${zs.map((z) => z.toFixed(2)).join(' ')}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // Some cross the ground between the vaults, at its height.
    expect(acrossVaults).toBeGreaterThan(0);
  });

  it('steps off every plate on the side facing the other note', () => {
    const { top } = geometry(layout);
    const bad: string[] = [];
    for (const [a, b] of pairs(layout)) {
      const { points } = routeBetween(layout, a, b);
      for (let k = 1; k < points.length; k++) {
        const [p, q] = [points[k - 1]!, points[k]!];
        if (near(p[2], q[2])) continue;
        // Going down, a's side of the cable, steps off toward b; coming up, b's, toward a.
        const [hi, lo, other] = p[2] > q[2] ? [p, q, b] : [q, p, a];
        const pl = layout.plates.find(
          (pl, i) => near(top(i), hi[2]) && near(top(pl.parent), lo[2]) && onEdge(rect(pl), hi),
        );
        if (!pl) continue; // the first test says what is wrong with it
        const r = rect(pl);
        const [x, y] = [layout.cells[other * 3]!, layout.cells[other * 3 + 1]!];
        const facing =
          (near(hi[0], r.x0) && x < r.x0) ||
          (near(hi[0], r.x1) && x > r.x1) ||
          (near(hi[1], r.y0) && y < r.y0) ||
          (near(hi[1], r.y1) && y > r.y1);
        if (!facing) bad.push(`${layout.ids[a]} → ${layout.ids[b]}: off ${pl.id} at ${fmt(hi)}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('keeps to a few corners on every plate it crosses', () => {
    // A* charges for every turn, so a cable takes a longer way round before a staircase.
    let most = 0;
    for (const [a, b] of pairs(layout)) {
      const { points } = routeBetween(layout, a, b);
      // Points in a row at one height are the corners of a stretch across one plate, and its ends.
      let run = 1;
      for (let k = 1; k < points.length; k++) {
        run = near(points[k]![2], points[k - 1]![2]) ? run + 1 : 1;
        most = Math.max(most, run - 2);
      }
    }
    expect(most).toBeLessThanOrEqual(6);
  });

  it('never doubles back across the plate where the two ends meet', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const [a, b] of pairs(layout)) {
      const { points } = routeBetween(layout, a, b);
      const zs = points.map((p) => p[2]);
      const low = Math.min(...zs);
      // Where each end comes down onto the plate under both, unless a note stands on it.
      const i = zs.findIndex((z) => near(z, low));
      let j = zs.length - 1;
      while (!near(zs[j]!, low)) j--;
      if (i === 0 || j === zs.length - 1) continue;
      // The axis each end steps out from its edge along; along the other, the stretch between
      // the two drops runs the way the notes lie, never back past the other end.
      const moved = (p: Vec3, q: Vec3) => (near(p[0], q[0]) ? 1 : 0);
      const out = [moved(points[i]!, points[i + 1]!), moved(points[j - 1]!, points[j]!)];
      for (const d of [0, 1]) {
        if (out.includes(d)) continue;
        checked++;
        const notes = layout.cells[b * 3 + d]! - layout.cells[a * 3 + d]!;
        if ((points[j]![d]! - points[i]![d]!) * notes < -TOL)
          bad.push(`${layout.ids[a]} → ${layout.ids[b]}: ${fmt(points[i]!)} … ${fmt(points[j]!)}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it('routes two notes of one grid along the gaps between its rows and columns', () => {
    const plate = plateIndex(layout, 'p:own|Erebor');
    const g = layout.plates[plate]!.grid!;
    expect(g).toMatchObject({ cols: 4, rows: 3 });
    const notes = layout.ids.map((_, i) => i).filter((i) => layout.plateOf[i] === plate);
    expect(notes).toHaveLength(12);
    const onGap = (v: number, from: number) => near(v - from, Math.round(v - from), 1e-5);
    const inGrid = { x0: g.x, y0: g.y, x1: g.x + g.cols, y1: g.y + g.rows };
    for (const a of notes) {
      for (const b of notes) {
        if (a === b) continue;
        const { points } = routeBetween(layout, a, b);
        const name = `${layout.ids[a]} → ${layout.ids[b]}`;
        expect(problems(layout, points), name).toEqual([]);
        expect(points.length, name).toBeLessThanOrEqual(5);
        expect(
          points.every((p) => holds(inGrid, p)),
          name,
        ).toBe(true);
        // Between its ends, a cable turns only on the lines between rows and columns.
        for (const p of points.slice(1, -1)) {
          expect(onGap(p[0], g.x) || onGap(p[1], g.y), `${name} ${fmt(p)}`).toBe(true);
        }
      }
    }
  });

  it('crosses to the next block in a row, and round the corner to one across the grid', () => {
    const plate = plateIndex(layout, 'p:own|Erebor');
    const g = layout.plates[plate]!.grid!;
    // A hundredth above the plate's top: on its surface, not in it.
    const z = layout.plates[plate]!.z1 + 0.01;
    const cell = (col: number, row: number) => {
      const [x, y] = [g.x + col + 0.5, g.y + row + 0.5];
      const i = layout.ids.findIndex(
        (_, n) =>
          layout.plateOf[n] === plate &&
          near(layout.cells[n * 3]!, x, CELL_TOL) &&
          near(layout.cells[n * 3 + 1]!, y, CELL_TOL),
      );
      expect(i, `${col}, ${row}`).toBeGreaterThanOrEqual(0);
      return { i, x, y };
    };
    const close = (pts: number[][]) => pts.map((p) => p.map((v) => expect.closeTo(v, 5)));

    const [a, b] = [cell(0, 2), cell(1, 2)];
    const next = routeBetween(layout, a.i, b.i);
    expect(next.points).toEqual(
      close([
        [a.x + HB, a.y, z],
        [b.x - HB, b.y, z],
      ]),
    );
    expect(next.length).toBeCloseTo(1 - BLOCK, 5);

    // Out of the back row between it and the next, along to the gap before column 2, and in.
    const c = cell(2, 0);
    expect(routeBetween(layout, a.i, c.i).points).toEqual(
      close([
        [a.x, a.y - HB, z],
        [a.x, a.y - 0.5, z],
        [c.x - 0.5, a.y - 0.5, z],
        [c.x - 0.5, c.y, z],
        [c.x - HB, c.y, z],
      ]),
    );
  });

  it('gives the same points for the same input', () => {
    const again = layoutIso([...NOTES].reverse(), VAULTS);
    expect(again.ids).toEqual(layout.ids);
    for (const [a, b] of pairs(layout).filter((_, k) => k % 7 === 0)) {
      const route = routeBetween(layout, a, b);
      expect(routeBetween(layout, a, b)).toEqual(route);
      // A layout made again is a new object, with nothing of the first one's kept.
      expect(JSON.stringify(routeBetween(again, a, b))).toBe(JSON.stringify(route));
    }
  });

  it('leaves out repeated points and points in line, and measures what is left', () => {
    // Every segment runs along one axis (the first test), so in line means along the same one.
    const axis = (v: number[]) => v.findIndex((c) => Math.abs(c) > TOL);
    const bad: string[] = [];
    for (const [a, b] of pairs(layout)) {
      const { points, length } = routeBetween(layout, a, b);
      const name = `${layout.ids[a]} → ${layout.ids[b]}`;
      let sum = 0;
      for (let k = 1; k < points.length; k++) {
        const [p, q] = [points[k - 1]!, points[k]!];
        const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        sum += Math.hypot(...d);
        if (Math.hypot(...d) <= TOL) bad.push(`${name}: ${fmt(q)} twice`);
        const r = points[k + 1];
        if (!r) continue;
        const e = [r[0] - q[0], r[1] - q[1], r[2] - q[2]];
        if (axis(d) === axis(e) && d[axis(d)]! * e[axis(e)]! > 0)
          bad.push(`${name}: ${fmt(q)} in line with its neighbours`);
      }
      if (!near(length, sum, 1e-9)) bad.push(`${name}: length ${length}, segments ${sum}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('draws nothing from a note to itself, or to a note the layout does not have', () => {
    expect(routeBetween(layout, 3, 3)).toEqual({ points: [], length: 0 });
    expect(routeBetween(layout, 3, layout.ids.length)).toEqual({ points: [], length: 0 });
    expect(routeBetween(layout, -1, 3)).toEqual({ points: [], length: 0 });
  });
});

describe('routesFrom', () => {
  it("routes a selection's links in the order given, each as routeBetween would", () => {
    const layout = layoutIso(NOTES, VAULTS);
    const from = noteIndex(layout, 'own/Orbit/plan.md');
    const to = [
      noteIndex(layout, 'eowyn/Rohan/Edoras/note 3.md'),
      noteIndex(layout, 'own/Orbit/Ledger/Q1/note 1.md'),
      noteIndex(layout, 'own/Orbit/brief.md'),
    ];
    const routes = routesFrom(layout, from, to);
    expect(routes).toEqual(to.map((t) => routeBetween(layout, from, t)));
    expect(routes.map((r) => onBlock(layout, from, r.points[0]!))).toEqual([true, true, true]);
  });
});

describe('projectRoutes', () => {
  const layout = layoutIso(NOTES, VAULTS);
  const at = (id: string) => noteIndex(layout, id);

  it('pairs the projects of a vault that link, one cable a pair, its links counted', () => {
    const links: [number, number][] = [
      [at('own/Orbit/plan.md'), at('own/Gondor/Minas/note 0.md')],
      // From a sub-folder: the project is still Orbit.
      [at('own/Orbit/Ledger/Q1/note 1.md'), at('own/Gondor/Minas/note 2.md')],
      // The other way round: the same pair.
      [at('own/Gondor/Minas/note 3.md'), at('own/Orbit/brief.md')],
      [at('own/Orbit/Atlas/note 0.md'), at('own/Erebor/note 4.md')],
      // Within one project, and across vaults: no cable.
      [at('own/Orbit/plan.md'), at('own/Orbit/Ledger/note 0.md')],
      [at('own/Erebor/note 1.md'), at('eowyn/Rohan/Edoras/note 0.md')],
    ];
    const orbit = plateIndex(layout, 'p:own|Orbit');
    const gondor = plateIndex(layout, 'p:own|Gondor');
    const erebor = plateIndex(layout, 'p:own|Erebor');
    const pair = (x: number, y: number, count: number) => [Math.min(x, y), Math.max(x, y), count];
    const expected = [pair(orbit, gondor, 3), pair(orbit, erebor, 1)].sort(
      (p, q) => p[0]! - q[0]! || p[1]! - q[1]!,
    );

    const routes = projectRoutes(layout, links);
    expect(routes.map((r) => [r.a, r.b, r.count])).toEqual(expected);
    const vault = layout.plates[orbit]!.parent;
    const z = layout.plates[vault]!.z1 + ROUTE_LIFT;
    for (const r of routes) {
      const [a, b] = [layout.plates[r.a]!, layout.plates[r.b]!];
      const name = `${a.id} → ${b.id}`;
      expect(problems(layout, r.points), name).toEqual([]);
      expect(
        r.points.every((p) => near(p[2], z)),
        name,
      ).toBe(true);
      // From the edge of one that faces the other, to the edge of the other.
      const [first, last] = [r.points[0]!, r.points.at(-1)!];
      expect(onEdge(rect(a), first), name).toBe(true);
      expect(onEdge(rect(b), last), name).toBe(true);
      const centre = (p: IsoPlate) => [p.x + p.w / 2, p.y + p.h / 2] as const;
      const dist = (p: readonly number[], q: readonly number[]) =>
        Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!);
      expect(dist(first, centre(b)), name).toBeLessThan(dist(centre(a), centre(b)));
      // Along an axis neither end steps out on, it runs the way the projects lie, not back.
      const out = [
        near(first[0], r.points[1]![0]) ? 1 : 0,
        near(last[0], r.points.at(-2)![0]) ? 1 : 0,
      ];
      for (const d of [0, 1]) {
        if (out.includes(d)) continue;
        expect((last[d]! - first[d]!) * (centre(b)[d]! - centre(a)[d]!), name).toBeGreaterThan(
          -TOL,
        );
      }
    }
  });

  it('is the same for the same links, and draws nothing for none it can place', () => {
    const links: [number, number][] = [
      [at('own/Erebor/note 0.md'), at('own/Gondor/Minas/note 1.md')],
    ];
    expect(projectRoutes(layout, links)).toEqual(projectRoutes(layout, links));
    expect(projectRoutes(layout, [])).toEqual([]);
    expect(
      projectRoutes(layout, [
        [0, layout.ids.length],
        [-1, 2],
      ]),
    ).toEqual([]);
  });
});

describe('routes on a large map', () => {
  it('routes 40 links from a note across a 5,000-note map quickly', () => {
    const vaults: LayoutVault[] = [
      { id: 'own', label: 'Your vault', shared: false },
      { id: 'arwen', label: 'Rivendell', shared: true },
      { id: 'thorin', label: 'Erebor', shared: true },
    ];
    const notes = bigVault(5_000);
    const to = Array.from({ length: 40 }, (_, k) => (k * 125 + 61) % 5_000);
    // Once on another layout, so the timing below is the routing and not the JIT warming up.
    routesFrom(layoutIso(notes, vaults), 7, to);
    const layout = layoutIso(notes, vaults);
    const from = 2_500;
    const t0 = performance.now();
    const routes = routesFrom(layout, from, to);
    const ms = performance.now() - t0;
    console.log(
      `routesFrom: ${to.length} cables over ${layout.ids.length} notes in ${ms.toFixed(1)} ms`,
    );
    const bad = routes.flatMap((r, k) => {
      if (r.points.length < 2) return [`${k}: no cable`];
      return problems(layout, r.points).map((p) => `${k} ${p}`);
    });
    expect(bad.slice(0, 10)).toEqual([]);
    expect(ms).toBeLessThan(50);
  });
});

/** `n` invented notes: 30 projects over 3 vaults, folders up to four levels deep. */
function bigVault(n: number): LayoutNote[] {
  const vaultOf = (p: number) => (p < 16 ? 'own' : p < 25 ? 'arwen' : 'thorin');
  const folders = ['Docs', 'Docs/Specs', 'Docs/Specs/Old/Draft', 'Notes', 'Notes/Daily', 'Plans'];
  return Array.from({ length: n }, (_, i) => {
    const p = (i * 7) % 30;
    const folder = i % 11 === 0 ? '' : `${folders[i % folders.length]}/`;
    const path =
      i % 97 === 0 ? `Project ${p}/_Index ${i}.md` : `Project ${p}/${folder}note ${i}.md`;
    return note(vaultOf(p), path, (i * 31) % 10_000);
  });
}
