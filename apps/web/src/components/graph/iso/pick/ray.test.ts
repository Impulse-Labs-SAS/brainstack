import { describe, expect, it } from 'vitest';

import type { Viewport } from '@/lib/graph-camera';

import {
  layoutIso,
  type IsoLayout,
  type IsoPlate,
  type LayoutNote,
  type LayoutVault,
} from '../layout/territories';
import {
  ISO_EL,
  PLAN_EL,
  isoProject,
  isoUnproject,
  snapAz,
  viewDir,
  type IsoCam,
} from '../math/camera';
import { BLOCK, BLOCK_H } from '../block';
import { PickIndex, viewRay, type PickHit, type Ray } from './ray';

type Vec3 = [number, number, number];

const VP: Viewport = { width: 1024, height: 640 };
const TIE = 1e-9;
const NO_LIFTS: ReadonlyMap<number, number> = new Map();

/** A small LCG, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const VAULTS: LayoutVault[] = [
  { id: 'own', label: 'Your vault', shared: false },
  { id: 'rohan', label: 'Rohan', shared: true },
];

function note(vault: string, path: string, createdAt: number): LayoutNote {
  const project = path.split('/')[0]!;
  return {
    id: `${vault}/${path}`,
    path,
    project: `${vault}|${project}`,
    projectLabel: project,
    vault,
    isIndex: false,
    createdAt,
  };
}

const many = (vault: string, folder: string, n: number) =>
  Array.from({ length: n }, (_, i) => note(vault, `${folder}/note ${i}.md`, 1_000 + i));

// Plates four deep, full grids and part-full ones (Atlas: three notes in a 2×2 grid), and a
// project, Gondor, whose nine notes fill a 3×3 grid on its own plate.
const NOTES: LayoutNote[] = [
  ...many('own', 'Orbit', 5),
  ...many('own', 'Orbit/Ledger', 12),
  ...many('own', 'Orbit/Ledger/Q1', 7),
  ...many('own', 'Orbit/Atlas', 3),
  ...many('own', 'Gondor', 9),
  ...many('own', 'Erebor/Halls', 20),
  ...many('rohan', 'Edoras', 4),
  ...many('rohan', 'Edoras/Meduseld', 10),
];
const LAYOUT = layoutIso(NOTES, VAULTS);

const name = (h: PickHit | null) =>
  !h ? 'ground' : h.kind === 'note' ? `note ${h.note}` : `plate ${h.plate}`;

function plateNamed(layout: IsoLayout, id: string): number {
  const i = layout.plates.findIndex((p) => p.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return i;
}

/** Where a note stands: the centre of its cell, and the top of its plate. */
const cellOf = (layout: IsoLayout, k: number) => ({
  x: layout.cells[k * 3]!,
  y: layout.cells[k * 3 + 1]!,
  z: layout.cells[k * 3 + 2]!,
});

/** The note standing in each cell of a plate's grid, by "col,row". */
function notesOn(layout: IsoLayout, plate: number): Map<string, number> {
  const grid = layout.plates[plate]!.grid!;
  const out = new Map<string, number>();
  layout.ids.forEach((_, k) => {
    if (layout.plateOf[k] !== plate) return;
    const { x, y } = cellOf(layout, k);
    out.set(`${Math.round(x - grid.x - 0.5)},${Math.round(y - grid.y - 0.5)}`, k);
  });
  return out;
}

/**
 * Every orientation the map takes — the four iso corners and the four plan turns, each at both
 * tilts, and as many caught mid-turn and mid-tilt, as an eased turn or tilt passes through —
 * aimed anywhere over the layout, from far out to close in. At the snapped turns the ray runs
 * along a diagonal or straight down, so only the cameras in between walk the cells at every
 * slope.
 */
function cameras(layout: IsoLayout, seed: number, each: number): IsoCam[] {
  const r = rng(seed);
  const { x0, y0, x1, y1 } = layout.bounds;
  const out: IsoCam[] = [];
  for (const plan of [false, true])
    for (let turn = 0; turn < 4; turn++)
      for (const el of [ISO_EL, PLAN_EL])
        for (let i = 0; i < each; i++)
          out.push({
            tx: x0 - 4 + r() * (x1 - x0 + 8),
            ty: y0 - 4 + r() * (y1 - y0 + 8),
            tz: r() * 1.2,
            az: snapAz(turn, plan),
            el,
            ppu: 2 * 60 ** r(),
          });
  for (let i = 0; i < 16 * each; i++)
    out.push({
      tx: x0 - 4 + r() * (x1 - x0 + 8),
      ty: y0 - 4 + r() * (y1 - y0 + 8),
      tz: r() * 1.2,
      az: r() * 2 * Math.PI,
      el: ISO_EL + r() * (PLAN_EL - ISO_EL),
      ppu: 2 * 60 ** r(),
    });
  return out;
}

/**
 * Screen points for a camera: half anywhere on the stage; a quarter near a block picked at
 * random — on it, beside it, in the gap to its neighbour, on the plate's edge; and a quarter on a
 * side face the camera sees, close to its foot or its top edge. A block's foot is met only just
 * before the plate under it, so a walk that stops a cell short misses it there first.
 */
function screenPoints(layout: IsoLayout, cam: IsoCam, r: () => number, count: number) {
  const project = isoProject(cam, VP);
  const toCamera = viewDir(cam);
  return Array.from({ length: count }, (_, i) => {
    if (i % 2 || !layout.ids.length) return { x: r() * VP.width, y: r() * VP.height };
    const c = cellOf(layout, Math.floor(r() * layout.ids.length));
    if (i % 4 === 0)
      return project(c.x + (r() - 0.5) * 2, c.y + (r() - 0.5) * 2, c.z - 0.3 + r() * 1.5);
    const axis = r() < 0.5 ? 0 : 1;
    const out = (toCamera[axis] >= 0 ? 1 : -1) * (BLOCK / 2);
    const along = (r() - 0.5) * BLOCK;
    const h = r() < 0.5 ? r() * 0.06 : BLOCK_H - r() * 0.06;
    return axis === 0
      ? project(c.x + out, c.y + along, c.z + h)
      : project(c.x + along, c.y + out, c.z + h);
  });
}

/** The same layout moved across the ground by (dx, dy). */
function shifted(layout: IsoLayout, dx: number, dy: number): IsoLayout {
  const { x0, y0, x1, y1 } = layout.bounds;
  return {
    ...layout,
    plates: layout.plates.map((p) => ({
      ...p,
      x: p.x + dx,
      y: p.y + dy,
      grid: p.grid && { ...p.grid, x: p.grid.x + dx, y: p.grid.y + dy },
    })),
    cells: layout.cells.map((v, i) => v + (i % 3 === 0 ? dx : i % 3 === 1 ? dy : 0)),
    bounds: { x0: x0 + dx, y0: y0 + dy, x1: x1 + dx, y1: y1 + dy },
  };
}

/** What `cellSnap` should give for a hit, worked out from the screen point, not the ray. */
function snapOf(
  layout: IsoLayout,
  cam: IsoCam,
  sx: number,
  sy: number,
  hit: PickHit | null,
): PickHit | null {
  if (hit?.kind !== 'plate') return hit;
  const plate = layout.plates[hit.plate]!;
  if (!plate.grid) return hit;
  const q = isoUnproject(cam, VP, sx, sy, plate.z1 + BLOCK_H);
  const col = Math.floor(q.x - plate.grid.x);
  const row = Math.floor(q.y - plate.grid.y);
  const k = notesOn(layout, hit.plate).get(`${col},${row}`);
  return k === undefined ? hit : { kind: 'note', note: k };
}

// -- The brute force the index must agree with -----------------------------------------------

interface Meet {
  t: number;
  /** The axis of the face the ray enters by: 2 is a top. */
  axis: number;
}

/** Where the ray enters the box, the slow and obvious way; null when it misses. */
function meet(ray: Ray, lo: Vec3, hi: Vec3): Meet | null {
  let near = -Infinity;
  let far = Infinity;
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    const o = ray.origin[a]!;
    const d = ray.dir[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < lo[a]! || o > hi[a]!) return null;
      continue;
    }
    const t0 = Math.min((lo[a]! - o) / d, (hi[a]! - o) / d);
    const t1 = Math.max((lo[a]! - o) / d, (hi[a]! - o) / d);
    if (t0 > near) {
      near = t0;
      axis = a;
    }
    far = Math.min(far, t1);
  }
  return near <= far ? { t: near, axis } : null;
}

function blockBox(layout: IsoLayout, k: number, lift = 0): [Vec3, Vec3] {
  const { x, y, z } = cellOf(layout, k);
  const r = BLOCK / 2;
  return [
    [x - r, y - r, z + lift],
    [x + r, y + r, z + lift + BLOCK_H],
  ];
}

const plateBox = (p: IsoPlate): [Vec3, Vec3] => [
  [p.x, p.y, p.z0],
  [p.x + p.w, p.y + p.h, p.z1],
];

/**
 * What the ray meets first, testing every plate and every block. On a tie the higher thing
 * wins: a block over the plate it stands on, a plate over the one it stands on.
 */
function bruteForce(
  layout: IsoLayout,
  lifts: ReadonlyMap<number, number>,
  ray: Ray,
  blocks = true,
): { hit: PickHit | null; side: boolean } {
  let best = { t: Infinity, rank: -Infinity, hit: null as PickHit | null, side: false };
  const consider = (hit: PickHit, m: Meet | null, rank: number) => {
    if (!m) return;
    if (m.t < best.t - TIE || (m.t <= best.t + TIE && rank > best.rank))
      best = { t: Math.min(best.t, m.t), rank, hit, side: m.axis !== 2 };
  };
  layout.plates.forEach((p, i) =>
    consider({ kind: 'plate', plate: i }, meet(ray, ...plateBox(p)), i),
  );
  if (blocks) {
    const n = layout.ids.length;
    for (let k = 0; k < n; k++) {
      const box = blockBox(layout, k, lifts.get(k) ?? 0);
      consider({ kind: 'note', note: k }, meet(ray, ...box), layout.plates.length + n - k);
    }
  }
  return { hit: best.hit, side: best.side };
}

function lifted(index: PickIndex, lifts: Map<number, number>, k: number, lift: number) {
  lifts.set(k, lift);
  index.setLift(k, lift);
}

function settle(index: PickIndex, lifts: Map<number, number>) {
  for (const k of lifts.keys()) index.setLift(k, 0);
  lifts.clear();
}

// -- Tests ----------------------------------------------------------------------------------

describe('viewRay', () => {
  it('passes through the screen point, toward the scene', () => {
    const r = rng(2);
    for (const cam of cameras(LAYOUT, 1, 2)) {
      const project = isoProject(cam, VP);
      const back = viewDir(cam);
      for (let i = 0; i < 10; i++) {
        const sx = r() * VP.width;
        const sy = r() * VP.height;
        const { origin, dir } = viewRay(cam, VP, sx, sy);
        expect(dir[0]).toBeCloseTo(-back[0], 12);
        expect(dir[1]).toBeCloseTo(-back[1], 12);
        expect(dir[2]).toBeCloseTo(-back[2], 12);
        const a = project(...origin);
        const far: Vec3 = [origin[0] + 5 * dir[0], origin[1] + 5 * dir[1], origin[2] + 5 * dir[2]];
        const b = project(...far);
        for (const p of [a, b]) {
          expect(p.x).toBeCloseTo(sx, 6);
          expect(p.y).toBeCloseTo(sy, 6);
        }
        // Along the ray is away from the camera: deeper by the distance gone.
        expect(b.depth - a.depth).toBeCloseTo(5, 9);
      }
    }
  });
});

describe('PickIndex', () => {
  it('agrees with every block and plate tested one by one, on thousands of screen points', () => {
    const r = rng(11);
    const seen = { note: 0, plate: 0, plateSide: 0, blockSide: 0, ground: 0 };
    const wrong: string[] = [];
    let points = 0;
    // The layout puts every edge on a twentieth of a unit; moved off it, block edges fall
    // anywhere in the cells the walk steps through, as close to a cell's edge as they come.
    for (const [layout, seed] of [
      [LAYOUT, 3],
      [shifted(LAYOUT, 0.3719, 0.6083), 13],
    ] as const) {
      const index = new PickIndex(layout);
      const lifts = new Map<number, number>();
      cameras(layout, seed, 2).forEach((cam, c) => {
        // Half the cameras see a few blocks lifted, one far higher than the kit lifts any.
        settle(index, lifts);
        if (c % 2) {
          for (const lift of [0.36, 0.55, 2.5])
            lifted(index, lifts, Math.floor(r() * layout.ids.length), lift);
        }
        for (const { x: sx, y: sy } of screenPoints(layout, cam, r, 160)) {
          const at = `camera ${c} at (${sx}, ${sy})`;
          const ray = viewRay(cam, VP, sx, sy);
          const truth = bruteForce(layout, lifts, ray);
          const got = index.pick(cam, VP, sx, sy);
          if (name(got) !== name(truth.hit))
            wrong.push(`${at}: ${name(got)}, not ${name(truth.hit)}`);
          const plates = bruteForce(layout, lifts, ray, false).hit;
          const gotPlates = index.pick(cam, VP, sx, sy, { blocks: false });
          if (name(gotPlates) !== name(plates))
            wrong.push(`${at}, plates only: ${name(gotPlates)}, not ${name(plates)}`);
          const snap = snapOf(layout, cam, sx, sy, truth.hit);
          const gotSnap = index.pick(cam, VP, sx, sy, { cellSnap: true });
          if (name(gotSnap) !== name(snap))
            wrong.push(`${at}, snapped: ${name(gotSnap)}, not ${name(snap)}`);
          points++;
          if (!truth.hit) seen.ground++;
          else if (truth.hit.kind === 'note') seen[truth.side ? 'blockSide' : 'note']++;
          else seen[truth.side ? 'plateSide' : 'plate']++;
        }
      });
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(points).toBeGreaterThan(10_000);
    // Every kind of point came up: block tops and sides, plate tops and sides, bare ground.
    expect(seen.note).toBeGreaterThan(600);
    expect(seen.blockSide).toBeGreaterThan(300);
    expect(seen.plate).toBeGreaterThan(1_000);
    expect(seen.plateSide).toBeGreaterThan(20);
    expect(seen.ground).toBeGreaterThan(1_000);
  });

  it('picks a block at the centre of its top face wherever nothing nearer covers it', () => {
    const r = rng(5);
    const index = new PickIndex(LAYOUT);
    const lifts = new Map<number, number>();
    const wrong: string[] = [];
    let checked = 0;
    let covered = 0;
    cameras(LAYOUT, 7, 2).forEach((cam, c) => {
      settle(index, lifts);
      for (const lift of [0.36, 0.55, 1.2])
        lifted(index, lifts, Math.floor(r() * LAYOUT.ids.length), lift);
      const project = isoProject(cam, VP);
      for (let k = 0; k < LAYOUT.ids.length; k++) {
        const { x, y, z } = cellOf(LAYOUT, k);
        const s = project(x, y, z + (lifts.get(k) ?? 0) + BLOCK_H);
        const truth = bruteForce(LAYOUT, lifts, viewRay(cam, VP, s.x, s.y)).hit;
        if (name(truth) !== `note ${k}`) {
          covered++;
          continue;
        }
        checked++;
        const got = index.pick(cam, VP, s.x, s.y);
        if (name(got) !== `note ${k}`) wrong.push(`camera ${c}, note ${k}: ${name(got)}`);
      }
    });
    expect(wrong.slice(0, 5)).toEqual([]);
    // A lifted block covers the odd top behind it; nearly every top is in sight.
    expect(covered).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(covered * 10);
  });

  it('picks a lifted block where it is drawn, and what is under it where it stood', () => {
    const gondor = plateNamed(LAYOUT, 'p:own|Gondor');
    // The front corner at the first turn: nothing stands in front of it.
    const k = notesOn(LAYOUT, gondor).get('2,0')!;
    const { x, y, z } = cellOf(LAYOUT, k);
    const cam: IsoCam = { tx: x, ty: y, tz: z, az: snapAz(0, false), el: ISO_EL, ppu: 40 };
    const project = isoProject(cam, VP);
    const index = new PickIndex(LAYOUT);
    const at = (p: { x: number; y: number }) => name(index.pick(cam, VP, p.x, p.y));

    const top = project(x, y, z + 0.55 + BLOCK_H);
    const low = project(x + BLOCK / 2, y - 0.15, z + 0.1);
    expect(at(low)).toBe(`note ${k}`);
    expect(at(top)).not.toBe(`note ${k}`);

    index.setLift(k, 0.55);
    expect(at(top)).toBe(`note ${k}`);
    expect(at(low)).toBe(`plate ${gondor}`);

    // Higher than any block stands and any lift the kit gives: still found where it is drawn.
    index.setLift(k, 3);
    expect(at(project(x, y, z + 3 + BLOCK_H))).toBe(`note ${k}`);
    expect(at(project(x + BLOCK / 2, y, z + 3 + BLOCK_H / 2))).toBe(`note ${k}`);

    index.setLift(k, 0);
    expect(at(low)).toBe(`note ${k}`);
    expect(at(top)).not.toBe(`note ${k}`);
  });

  it('with blocks: false, picks the plate a block stands on', () => {
    const gondor = plateNamed(LAYOUT, 'p:own|Gondor');
    const k = notesOn(LAYOUT, gondor).get('1,1')!;
    const { x, y, z } = cellOf(LAYOUT, k);
    const index = new PickIndex(LAYOUT);
    for (const [az, el] of [
      [snapAz(0, true), PLAN_EL],
      [snapAz(1, false), ISO_EL],
    ] as const) {
      const cam: IsoCam = { tx: x, ty: y, tz: z, az, el, ppu: 30 };
      const s = isoProject(cam, VP)(x, y, z + BLOCK_H);
      expect(name(index.pick(cam, VP, s.x, s.y))).toBe(`note ${k}`);
      expect(name(index.pick(cam, VP, s.x, s.y, { blocks: false }))).toBe(`plate ${gondor}`);
      // Plates only: the snap has no block to take.
      expect(name(index.pick(cam, VP, s.x, s.y, { blocks: false, cellSnap: true }))).toBe(
        `plate ${gondor}`,
      );
    }
  });

  it('with cellSnap, a tap between blocks takes the block of the cell at block-top height', () => {
    const index = new PickIndex(LAYOUT);
    const gondor = plateNamed(LAYOUT, 'p:own|Gondor');
    const cells = notesOn(LAYOUT, gondor);
    const k = cells.get('1,1')!;
    const { x, y, z } = cellOf(LAYOUT, k);

    // Straight down, the cell at block-top height is the cell under the finger.
    const plan: IsoCam = { tx: x, ty: y, tz: z, az: snapAz(0, true), el: PLAN_EL, ppu: 60 };
    const down = isoProject(plan, VP);
    const pick = (cam: IsoCam, p: { x: number; y: number }, cellSnap: boolean) =>
      name(index.pick(cam, VP, p.x, p.y, { cellSnap }));
    const left = down(x + 0.45, y, z);
    const right = down(x + 0.55, y, z);
    expect(pick(plan, left, false)).toBe(`plate ${gondor}`);
    expect(pick(plan, left, true)).toBe(`note ${k}`);
    expect(pick(plan, right, true)).toBe(`note ${cells.get('2,1')!}`);
    // A block hit is the block; bare ground stays bare.
    expect(pick(plan, down(x, y, z + BLOCK_H), true)).toBe(`note ${k}`);
    const { x0, y0 } = LAYOUT.bounds;
    expect(pick(plan, down(x0 - 3, y0 - 3, 0), true)).toBe('ground');

    // An empty cell has no block to give: Atlas holds three notes in a 2×2 grid.
    const atlas = plateNamed(LAYOUT, 'f:own|Orbit/Atlas');
    const grid = LAYOUT.plates[atlas]!.grid!;
    const empty = ['0,0', '1,0', '0,1', '1,1'].filter((c) => !notesOn(LAYOUT, atlas).has(c));
    expect(empty).toHaveLength(1);
    const [col, row] = empty[0]!.split(',').map(Number) as [number, number];
    const top = LAYOUT.plates[atlas]!.z1;
    const hole: IsoCam = { ...plan, tx: grid.x + col + 0.5, ty: grid.y + row + 0.5 };
    expect(pick(hole, isoProject(hole, VP)(hole.tx, hole.ty, top), true)).toBe(`plate ${atlas}`);

    // In iso, at every turn: wherever the plate shows between blocks, the snap takes the block
    // of the cell the ray meets at block-top height.
    const plate = LAYOUT.plates[gondor]!;
    const g = plate.grid!;
    let snapped = 0;
    let gaps = 0;
    for (let turn = 0; turn < 4; turn++) {
      const cam: IsoCam = { tx: x, ty: y, tz: z, az: snapAz(turn, false), el: ISO_EL, ppu: 50 };
      const project = isoProject(cam, VP);
      for (let u = 0.025; u < g.cols; u += 0.05) {
        for (let v = 0.025; v < g.rows; v += 0.05) {
          const s = project(g.x + u, g.y + v, plate.z1);
          if (pick(cam, s, false) !== `plate ${gondor}`) continue;
          gaps++;
          const q = isoUnproject(cam, VP, s.x, s.y, plate.z1 + BLOCK_H);
          const there = cells.get(`${Math.floor(q.x - g.x)},${Math.floor(q.y - g.y)}`);
          const want = there === undefined ? `plate ${gondor}` : `note ${there}`;
          expect(pick(cam, s, true)).toBe(want);
          if (there !== undefined) snapped++;
        }
      }
    }
    expect(gaps).toBeGreaterThan(100);
    expect(snapped).toBeGreaterThan(50);
  });

  it('a block in front hides the one behind it', () => {
    const index = new PickIndex(LAYOUT);
    const gondor = plateNamed(LAYOUT, 'p:own|Gondor');
    const cells = notesOn(LAYOUT, gondor);
    const front = cells.get('1,1')!;
    const back = cells.get('1,2')!;
    const { x, y, z } = cellOf(LAYOUT, front);
    const cam: IsoCam = { tx: x, ty: y, tz: z, az: snapAz(0, false), el: ISO_EL, ppu: 48 };

    // High on the +x face, near its back edge: the camera's side at the first turn. The ray
    // through it goes on into the block one cell further up y.
    const s = isoProject(cam, VP)(x + BLOCK / 2, y + BLOCK / 2 - 0.06, z + 0.45);
    const ray = viewRay(cam, VP, s.x, s.y);
    const near = meet(ray, ...blockBox(LAYOUT, front))!;
    const far = meet(ray, ...blockBox(LAYOUT, back))!;
    expect(far.t).toBeGreaterThan(near.t);
    expect(name(index.pick(cam, VP, s.x, s.y))).toBe(`note ${front}`);
    // Lifted out of the way, it uncovers the block behind.
    index.setLift(front, 3);
    expect(name(index.pick(cam, VP, s.x, s.y))).toBe(`note ${back}`);
    index.setLift(front, 0);

    // At every turn, a point on a side face the camera sees, with a neighbour behind it on the
    // same ray, picks the block in front.
    for (let turn = 0; turn < 4; turn++) {
      const turned: IsoCam = { ...cam, az: snapAz(turn, false) };
      const toCamera = viewDir(turned);
      const project = isoProject(turned, VP);
      const [min, max] = blockBox(LAYOUT, front);
      let hidden = 0;
      for (const [axis, sign] of [
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
      ] as const) {
        if (toCamera[axis] * sign <= 0) continue;
        const other = axis === 0 ? 1 : 0;
        for (let a = 0.05; a < 1; a += 0.1) {
          for (let h = 0.05; h < 1; h += 0.1) {
            const p: Vec3 = [0, 0, min[2] + h * BLOCK_H];
            p[axis] = sign > 0 ? max[axis] : min[axis];
            p[other] = min[other] + a * BLOCK;
            const at = project(...p);
            const through = viewRay(turned, VP, at.x, at.y);
            if (name(bruteForce(LAYOUT, NO_LIFTS, through).hit) !== `note ${front}`) continue;
            const behind = [...cells.values()].some(
              (j) => j !== front && meet(through, ...blockBox(LAYOUT, j)) !== null,
            );
            if (!behind) continue;
            hidden++;
            expect(name(index.pick(turned, VP, at.x, at.y))).toBe(`note ${front}`);
          }
        }
      }
      expect(hidden, `turn ${turn}`).toBeGreaterThan(0);
    }
  });

  it('finds a block met at its very foot, just past the edge of a cell', () => {
    // Where the walk stops early, and where it ends at the lowest blocks' feet, only shows on a
    // ray that meets a block's side right at its foot, a hair past the cell edge it crossed
    // last, with the plate just behind: random points never land there.
    const gondor = plateNamed(LAYOUT, 'p:own|Gondor');
    const grid = LAYOUT.plates[gondor]!.grid!;
    const cells = notesOn(LAYOUT, gondor);
    const low = Math.min(...LAYOUT.ids.map((_, k) => cellOf(LAYOUT, k).z));
    let cases = 0;
    for (let turn = 0; turn < 4; turn++) {
      const az = snapAz(turn, false);
      const toCamera = viewDir({ tx: 0, ty: 0, tz: 0, az, el: ISO_EL, ppu: 1 });
      // The corner block nearest the camera: nothing stands in front of it.
      const col = toCamera[0] > 0 ? grid.cols - 1 : 0;
      const row = toCamera[1] > 0 ? grid.rows - 1 : 0;
      const k = cells.get(`${col},${row}`)!;
      expect(cellOf(LAYOUT, k).z).toBe(low);
      for (const axis of [0, 1] as const) {
        const other = 1 - axis;
        const c = cellOf(LAYOUT, k);
        const centre = [c.x, c.y];
        const s = Math.sign(toCamera[axis]);
        // The face the camera sees, moved 2e-4 past a whole unit the ray crosses on its way
        // in: beyond the padding a footprint is filed with, so the cell before holds nothing.
        const face = centre[axis]! + (s * BLOCK) / 2;
        const shift: [number, number] = [0, 0];
        shift[axis] = (s > 0 ? Math.ceil(face) - 2e-4 : Math.floor(face) + 2e-4) - face;
        shift[other] = Math.floor(centre[other]!) + 0.5 - centre[other]!;
        const layout = shifted(LAYOUT, ...shift);
        const m = cellOf(layout, k);
        const p: Vec3 = [m.x, m.y, m.z + 1e-5];
        p[axis] += (s * BLOCK) / 2;
        expect(Math.abs(p[axis] - Math.round(p[axis]))).toBeGreaterThan(1.5e-4);
        expect(Math.abs(p[axis] - Math.round(p[axis]))).toBeLessThan(2.5e-4);

        const cam: IsoCam = { tx: m.x, ty: m.y, tz: m.z, az, el: ISO_EL, ppu: 60 };
        const at = isoProject(cam, VP)(...p);
        const label = `turn ${turn}, axis ${axis}`;
        const truth = bruteForce(layout, NO_LIFTS, viewRay(cam, VP, at.x, at.y));
        expect(name(truth.hit), label).toBe(`note ${k}`);
        expect(truth.side, label).toBe(true);
        expect(name(new PickIndex(layout).pick(cam, VP, at.x, at.y)), label).toBe(`note ${k}`);
        cases++;
      }
    }
    expect(cases).toBe(8);
  });

  it('finds nothing on an empty map', () => {
    const index = new PickIndex(layoutIso([], VAULTS));
    index.setLift(0, 0.5);
    const cam: IsoCam = { tx: 0, ty: 0, tz: 0, az: snapAz(0, false), el: ISO_EL, ppu: 20 };
    expect(index.pick(cam, VP, VP.width / 2, VP.height / 2, { cellSnap: true })).toBeNull();
  });

  it('picks 10,000 times among 5,000 notes well under a second', () => {
    const vaults: LayoutVault[] = [
      { id: 'own', label: 'Your vault', shared: false },
      { id: 'arwen', label: 'Rivendell', shared: true },
      { id: 'thorin', label: 'Erebor', shared: true },
    ];
    const layout = layoutIso(bigVault(5_000), vaults);
    const t0 = performance.now();
    const index = new PickIndex(layout);
    const built = performance.now() - t0;
    const r = rng(23);
    const lifts = new Map<number, number>();
    lifted(index, lifts, 17, 0.55);
    lifted(index, lifts, 4_000, 0.36);
    const cams = cameras(layout, 29, 8);
    const per = Math.ceil(10_000 / cams.length);
    const asks = cams
      .flatMap((cam) => screenPoints(layout, cam, r, per).map((p) => ({ cam, ...p })))
      .slice(0, 10_000);
    expect(asks).toHaveLength(10_000);

    const t1 = performance.now();
    let notes = 0;
    for (const a of asks) if (index.pick(a.cam, VP, a.x, a.y)?.kind === 'note') notes++;
    const ms = performance.now() - t1;
    console.log(
      `PickIndex: ${layout.ids.length} notes, ${layout.plates.length} plates; built in ` +
        `${built.toFixed(1)} ms, 10,000 picks in ${ms.toFixed(1)} ms (${notes} on a block)`,
    );
    expect(notes).toBeGreaterThan(500);
    // Expected in tens of milliseconds; the bound leaves room for a slow CI machine.
    expect(ms).toBeLessThan(1_000);

    // And still exact at this size, on a sample.
    const wrong: string[] = [];
    for (const a of asks.slice(0, 600)) {
      const truth = bruteForce(layout, lifts, viewRay(a.cam, VP, a.x, a.y)).hit;
      const got = index.pick(a.cam, VP, a.x, a.y);
      if (name(got) !== name(truth))
        wrong.push(`(${a.x}, ${a.y}): ${name(got)}, not ${name(truth)}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

/** `n` invented notes: 30 projects over 3 vaults, folders up to three levels deep. */
function bigVault(n: number): LayoutNote[] {
  const folders = [
    '',
    'Docs/',
    'Docs/Specs/',
    'Docs/Specs/Old/',
    'Notes/',
    'Notes/Daily/',
    'Plans/',
  ];
  return Array.from({ length: n }, (_, i) => {
    const p = (i * 7) % 30;
    const vault = p < 16 ? 'own' : p < 25 ? 'arwen' : 'thorin';
    return note(vault, `Project ${p}/${folders[i % folders.length]}note ${i}.md`, i);
  });
}
