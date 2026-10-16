// What is under a screen point in line art: the nearest box the view ray meets, block or plate,
// found the way the map is drawn. A block is picked wherever it shows — lifted, or half behind
// another — and never through one standing in front of it.
//
// The decision worth keeping: blocks are found by walking the unit cells the ray crosses
// between the highest a block can reach and the lowest one stands (a grid DDA), testing only
// the blocks filed in those cells. A pick costs the few cells under the pointer, not every note
// on the map, so it can run on every pointer move. Plates, a few hundred at most, are each
// tested.
//
// Pure: no DOM, no three.

import type { Viewport } from '@/lib/graph-camera';

import { BLOCK, BLOCK_H } from '../block';
import type { IsoLayout } from '../layout/territories';
import { isoUnproject, viewDir, type IsoCam } from '../math/camera';

/** `note` is an index in `layout.ids`, `plate` one in `layout.plates`. */
export type PickHit = { kind: 'note'; note: number } | { kind: 'plate'; plate: number };

type Vec3 = [number, number, number];

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * Two hits this close along the ray are one, and the higher thing wins it: a block over the
 * plate it stands on, a plate over the one under it. They meet at a shared face.
 */
const TIE = 1e-9;
/**
 * A footprint is filed in every cell it comes this close to, so a ray that crosses a cell's
 * corner by less than a rounding error still finds the block there.
 */
const PAD = 1e-4;
/** Below this, a ray is parallel to an axis: straight down, in plan. */
const PARALLEL = 1e-12;
/** Room above and below the heights the blocks span, so the walk never ends a hair short. */
const MARGIN = 0.01;

/** The view ray through a screen point: a point on it and its direction, toward the scene. */
export function viewRay(cam: IsoCam, vp: Viewport, sx: number, sy: number): Ray {
  // The point at the target's height: the ray parameter then runs from the target's plane.
  const at = isoUnproject(cam, vp, sx, sy, cam.tz);
  const back = viewDir(cam);
  return { origin: [at.x, at.y, cam.tz], dir: [-back[0], -back[1], -back[2]] };
}

/** Narrows `span` (near, far) to where the ray lies between lo and hi on one axis; false when it never does. */
function narrow(span: Float64Array, o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < PARALLEL) return o >= lo && o <= hi;
  let a = (lo - o) / d;
  let b = (hi - o) / d;
  if (a > b) {
    const swap = a;
    a = b;
    b = swap;
  }
  if (a > span[0]!) span[0] = a;
  if (b < span[1]!) span[1] = b;
  return span[0]! <= span[1]!;
}

/** Where the ray enters the box, as a ray parameter; Infinity when it misses it. */
function entry(
  ray: Ray,
  span: Float64Array,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const { origin: o, dir: d } = ray;
  span[0] = -Infinity;
  span[1] = Infinity;
  const hit =
    narrow(span, o[0], d[0], x0, x1) &&
    narrow(span, o[1], d[1], y0, y1) &&
    narrow(span, o[2], d[2], z0, z1);
  return hit ? span[0]! : Infinity;
}

/** The part of the segment a → b (s from 0 to 1) inside the rectangle; null when none is. */
function clip(
  a: readonly [number, number],
  b: readonly [number, number],
  lo: readonly [number, number],
  hi: readonly [number, number],
): [number, number] | null {
  let s0 = 0;
  let s1 = 1;
  for (let k = 0; k < 2; k++) {
    const d = b[k]! - a[k]!;
    if (Math.abs(d) < PARALLEL) {
      if (a[k]! < lo[k]! || a[k]! > hi[k]!) return null;
      continue;
    }
    const p = (lo[k]! - a[k]!) / d;
    const q = (hi[k]! - a[k]!) / d;
    s0 = Math.max(s0, Math.min(p, q));
    s1 = Math.min(s1, Math.max(p, q));
  }
  return s0 <= s1 ? [s0, s1] : null;
}

/** The best hit so far: the ray parameter it was met at, and its rank to settle a tie. */
interface Best {
  t: number;
  rank: number;
  hit: PickHit | null;
}

/**
 * Whether a hit at t, of this rank, beats the best so far: nearer, or as near and ranked higher.
 * A miss (t = Infinity) beats nothing, not even no hit at all.
 */
const beats = (best: Best, t: number, rank: number) =>
  t < Infinity && (t < best.t - TIE || (t <= best.t + TIE && rank > best.rank));

/** Answers what is under a screen point, for one layout. Build it once per layout. */
export class PickIndex {
  /** The blocks lifted, by note index. */
  private readonly lifts = new Map<number, number>();
  private liftUp = 0;
  private liftDown = 0;
  /** The integer cells the blocks are filed in: the first cell's corner and how many each way. */
  private readonly gx: number;
  private readonly gy: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Per cell, where its notes start in `filed`; one more entry closes the last cell. */
  private readonly starts: Int32Array;
  private readonly filed: Int32Array;
  /** The lowest and highest any block stands, before lifts. */
  private readonly low: number;
  private readonly high: number;
  /** Per plate, the note in each cell of its grid (-1 when the cell is empty); null without a grid. */
  private readonly gridNotes: (Int32Array | null)[];
  private readonly span = new Float64Array(2);

  constructor(private readonly layout: IsoLayout) {
    const { cells, ids, plates, plateOf } = layout;
    const n = ids.length;
    const half = BLOCK / 2 + PAD;
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    let low = Infinity;
    let high = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = cells[k * 3]!;
      const y = cells[k * 3 + 1]!;
      const z = cells[k * 3 + 2]!;
      gx0 = Math.min(gx0, Math.floor(x - half));
      gy0 = Math.min(gy0, Math.floor(y - half));
      gx1 = Math.max(gx1, Math.floor(x + half));
      gy1 = Math.max(gy1, Math.floor(y + half));
      low = Math.min(low, z);
      high = Math.max(high, z);
    }
    const empty = n === 0;
    this.gx = empty ? 0 : gx0;
    this.gy = empty ? 0 : gy0;
    this.cols = empty ? 0 : gx1 - gx0 + 1;
    this.rows = empty ? 0 : gy1 - gy0 + 1;
    this.low = empty ? 0 : low;
    this.high = empty ? 0 : high;

    // Filed as compressed rows: count each cell's notes, then lay them out cell after cell.
    const starts = new Int32Array(this.cols * this.rows + 1);
    const eachCell = (k: number, fn: (cell: number) => void) => {
      const x = cells[k * 3]!;
      const y = cells[k * 3 + 1]!;
      for (let iy = Math.floor(y - half); iy <= Math.floor(y + half); iy++)
        for (let ix = Math.floor(x - half); ix <= Math.floor(x + half); ix++)
          fn((iy - this.gy) * this.cols + (ix - this.gx));
    };
    for (let k = 0; k < n; k++) eachCell(k, (c) => starts[c + 1]!++);
    for (let c = 0; c < this.cols * this.rows; c++) starts[c + 1]! += starts[c]!;
    const filed = new Int32Array(starts[this.cols * this.rows]!);
    const next = starts.slice(0, -1);
    for (let k = 0; k < n; k++) eachCell(k, (c) => (filed[next[c]!++] = k));
    this.starts = starts;
    this.filed = filed;

    this.gridNotes = plates.map((p) =>
      p.grid ? new Int32Array(p.grid.cols * p.grid.rows).fill(-1) : null,
    );
    for (let k = 0; k < n; k++) {
      const grid = plates[plateOf[k]!]!.grid;
      const notes = this.gridNotes[plateOf[k]!];
      if (!grid || !notes) continue;
      // A cell's centre is its corner plus a half; rounded, so a float32 centre lands in its own cell.
      const col = Math.round(cells[k * 3]! - grid.x - 0.5);
      const row = Math.round(cells[k * 3 + 1]! - grid.y - 0.5);
      if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows)
        notes[row * grid.cols + col] = k;
    }
  }

  /** A note's block raised by `lift` (0 to put it back): it is picked where it is drawn. */
  setLift(note: number, lift: number): void {
    if (lift) this.lifts.set(note, lift);
    else this.lifts.delete(note);
    this.liftUp = 0;
    this.liftDown = 0;
    for (const l of this.lifts.values()) {
      this.liftUp = Math.max(this.liftUp, l);
      this.liftDown = Math.min(this.liftDown, l);
    }
  }

  /**
   * What is under the screen point (sx, sy): the block or plate nearest the camera that the
   * view ray through it meets; null on bare ground. With `blocks: false`, plates only.
   * With `cellSnap`, a ray that meets a plate but no block takes the block standing in the
   * cell it meets at block-top height, if any (a finger's tap between two blocks).
   */
  pick(
    cam: IsoCam,
    vp: Viewport,
    sx: number,
    sy: number,
    opts: { blocks?: boolean; cellSnap?: boolean } = {},
  ): PickHit | null {
    const { blocks = true, cellSnap = false } = opts;
    const ray = viewRay(cam, vp, sx, sy);
    const best: Best = { t: Infinity, rank: -Infinity, hit: null };
    this.pickPlates(ray, best);
    if (!blocks) return best.hit;
    this.pickBlocks(ray, best);
    if (cellSnap && best.hit?.kind === 'plate') {
      const note = this.noteInCell(ray, best.hit.plate);
      if (note >= 0) return { kind: 'note', note };
    }
    return best.hit;
  }

  /** Every plate; of two met as near, the one standing on the other (parents come first). */
  private pickPlates(ray: Ray, best: Best): void {
    const { plates } = this.layout;
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i]!;
      const t = entry(ray, this.span, p.x, p.y, p.z0, p.x + p.w, p.y + p.h, p.z1);
      if (beats(best, t, i)) {
        best.t = Math.min(best.t, t);
        best.rank = i;
        best.hit = { kind: 'plate', plate: i };
      }
    }
  }

  /** The blocks filed in the cells the ray crosses on its way down, nearest cells first. */
  private pickBlocks(ray: Ray, best: Best): void {
    if (!this.filed.length) return;
    const { origin: o, dir: d } = ray;
    const fall = -d[2];
    if (!(fall > 0)) return;
    // Where the ray is at the top of the highest lifted block and at the foot of the lowest.
    const top = this.high + BLOCK_H + this.liftUp + MARGIN;
    const foot = this.low + this.liftDown - MARGIN;
    const tA = (o[2] - top) / fall;
    const tB = (o[2] - foot) / fall;
    const a: [number, number] = [o[0] + d[0] * tA, o[1] + d[1] * tA];
    const b: [number, number] = [o[0] + d[0] * tB, o[1] + d[1] * tB];
    const part = clip(a, b, [this.gx, this.gy], [this.gx + this.cols, this.gy + this.rows]);
    if (!part) return;
    const [s0, s1] = part;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const cellAt = (v: number, from: number, count: number) =>
      Math.min(from + count - 1, Math.max(from, Math.floor(v)));

    // Amanatides–Woo over floor(x), floor(y), in s along a → b.
    let ix = cellAt(a[0] + ex * s0, this.gx, this.cols);
    let iy = cellAt(a[1] + ey * s0, this.gy, this.rows);
    const endX = cellAt(a[0] + ex * s1, this.gx, this.cols);
    const endY = cellAt(a[1] + ey * s1, this.gy, this.rows);
    const stepX = Math.sign(endX - ix);
    const stepY = Math.sign(endY - iy);
    let nextX = stepX ? (ix + (stepX > 0 ? 1 : 0) - a[0]) / ex : Infinity;
    let nextY = stepY ? (iy + (stepY > 0 ? 1 : 0) - a[1]) / ey : Infinity;
    const deltaX = stepX ? 1 / Math.abs(ex) : Infinity;
    const deltaY = stepY ? 1 / Math.abs(ey) : Infinity;
    // A block outranks every plate; of two blocks met as near, the lower index wins, so the
    // answer does not hang on which cell the walk met it in first.
    const above = this.layout.plates.length + this.layout.ids.length;
    let enter = s0;
    for (let left = Math.abs(endX - ix) + Math.abs(endY - iy); ; left--) {
      // Every block met from this cell on is met past where the ray enters it.
      if (tA + enter * (tB - tA) > best.t + TIE) return;
      const c = (iy - this.gy) * this.cols + (ix - this.gx);
      for (let j = this.starts[c]!; j < this.starts[c + 1]!; j++) {
        const k = this.filed[j]!;
        const t = this.blockEntry(ray, k);
        if (beats(best, t, above - k)) {
          best.t = Math.min(best.t, t);
          best.rank = above - k;
          best.hit = { kind: 'note', note: k };
        }
      }
      if (left <= 0) return;
      // The nearer crossing: an entry taken early never cuts the walk short.
      enter = Math.min(nextX, nextY, 1);
      // Never past the last cell on either axis, whatever rounding says.
      if (ix !== endX && (iy === endY || nextX <= nextY)) {
        ix += stepX;
        nextX += deltaX;
      } else {
        iy += stepY;
        nextY += deltaY;
      }
    }
  }

  private blockEntry(ray: Ray, k: number): number {
    const { cells } = this.layout;
    const x = cells[k * 3]!;
    const y = cells[k * 3 + 1]!;
    const z = cells[k * 3 + 2]! + (this.lifts.get(k) ?? 0);
    const r = BLOCK / 2;
    return entry(ray, this.span, x - r, y - r, z, x + r, y + r, z + BLOCK_H);
  }

  /** The note standing in the cell of the plate's grid the ray meets at block-top height; -1 if none. */
  private noteInCell(ray: Ray, plate: number): number {
    const p = this.layout.plates[plate]!;
    const notes = this.gridNotes[plate];
    if (!p.grid || !notes) return -1;
    const { origin: o, dir: d } = ray;
    const t = (o[2] - (p.z1 + BLOCK_H)) / -d[2];
    const col = Math.floor(o[0] + d[0] * t - p.grid.x);
    const row = Math.floor(o[1] + d[1] * t - p.grid.y);
    if (col < 0 || col >= p.grid.cols || row < 0 || row >= p.grid.rows) return -1;
    return notes[row * p.grid.cols + col]!;
  }
}
