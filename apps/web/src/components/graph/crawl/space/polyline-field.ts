// A ThreadField over threads drawn as polylines: what a space of its own gives
// the Sentinel when its threads are pipes with elbows, arcs between cells or
// bridges over a gap rather than the brain's gentle curve. Pure, so a space's
// layout and its walk are tested without a canvas.
//
// Each thread is a line of points from its key's first note to its second.
// Positions along it are measured by arc length, so a walk moves at an even
// pace whatever the line's shape. A spatial hash over the lines' segments
// answers `nearby`: what is at hand around a point, links or not.

import type { ThreadField, ThreadKey } from '../threads';
import type { Vec3 } from '../vec';

export interface PolylineFieldInput {
  /** Where each note is drawn, by id, world units. */
  nodes: ReadonlyMap<string, Vec3>;
  /**
   * Each thread's drawn line as xyz triples, from its key's first note to its
   * second (`threadEnds`), at least two points.
   */
  routes: ReadonlyMap<ThreadKey, Float32Array>;
  /** The threads touching each note, by id: what `around` walks. */
  adjacency: ReadonlyMap<string, readonly ThreadKey[]>;
  /** Whether a note is shown; a thread is drawn when both its notes are. All, by default. */
  shown?: (id: string) => boolean;
  /** Up, everywhere in the space. +y by default. */
  up?: Vec3;
  /**
   * Spatial hash cell for `nearby`, world units: about the radius it will be
   * asked for, which for the Sentinel's grips is the space's unit. Required,
   * because no default fits: a query reads (radius / cell)³ cells, and the
   * median segment — the obvious guess — is several times smaller than the
   * grips' reach in every space tried, which made planning a long leg take a second.
   */
  cell: number;
}

interface Route {
  key: ThreadKey;
  points: Float32Array;
  /** Arc length at each point; the last is the line's length. */
  arc: Float32Array;
  a: string;
  b: string;
  /** The last `nearby` query that met this line, and what it found: drawn or not, and how near. */
  seen: number;
  drawn: boolean;
  d2: number;
}

/** A segment of a line, as the spatial hash files it. */
interface Entry {
  route: Route;
  /** The segment from point `i` to point `i + 1`. */
  i: number;
  /** The last `nearby` query that measured it: filed in several cells, it is measured once. */
  seen: number;
}

/** Squared distance from `q` to the segment from point `i` of `p` to the next. */
function segmentD2(p: Float32Array, i: number, q: Vec3): number {
  const o = i * 3;
  const ax = p[o]!;
  const ay = p[o + 1]!;
  const az = p[o + 2]!;
  const bx = p[o + 3]! - ax;
  const by = p[o + 4]! - ay;
  const bz = p[o + 5]! - az;
  const l2 = bx * bx + by * by + bz * bz;
  let f = l2 > 0 ? ((q[0] - ax) * bx + (q[1] - ay) * by + (q[2] - az) * bz) / l2 : 0;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const dx = ax + bx * f - q[0];
  const dy = ay + by * f - q[1];
  const dz = az + bz * f - q[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Cells along each axis at most: the cells of the hash must all be numbered exactly. */
const MAX_CELLS = 200_000;

const SEP = '\u0000';

export type PolylineField = ThreadField & {
  length(key: ThreadKey): number;
  nearby(q: Vec3, r: number, max: number): ThreadKey[];
};

export function polylineThreadField(input: PolylineFieldInput): PolylineField {
  const shown = input.shown ?? (() => true);
  const up: Vec3 = input.up ?? [0, 1, 0];
  const routes = new Map<ThreadKey, Route>();
  const lengths: number[] = [];
  for (const [key, points] of input.routes) {
    const n = Math.floor(points.length / 3);
    // A line with a point not placed yet is not drawn: `has` promises finite
    // positions, and a NaN would reach every grip planned on it.
    if (n < 2 || !points.every(Number.isFinite)) continue;
    const arc = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const dx = points[i * 3]! - points[i * 3 - 3]!;
      const dy = points[i * 3 + 1]! - points[i * 3 - 2]!;
      const dz = points[i * 3 + 2]! - points[i * 3 - 1]!;
      const l = Math.hypot(dx, dy, dz);
      arc[i] = arc[i - 1]! + l;
      if (l > 0) lengths.push(l);
    }
    const i = key.indexOf(SEP);
    routes.set(key, {
      key,
      points,
      arc,
      a: key.slice(0, i),
      b: key.slice(i + 1),
      seen: 0,
      drawn: false,
      d2: Infinity,
    });
  }

  const drawn = (key: ThreadKey): Route | null => {
    const r = routes.get(key);
    return r && shown(r.a) && shown(r.b) ? r : null;
  };

  // The spatial hash. Each segment is cut into pieces no longer than a cell
  // and filed in every cell a piece's box touches: a few cells a piece.
  // Filed by the whole segment's box instead, one long diagonal — a bridge, a
  // span across the void — filled the cube of cells around it, hundreds of
  // thousands of them, and froze the build.
  //
  // Cells are numbered within the box of every line, so a lookup is a number:
  // grips ask what is near a slot's spot over and over as they plan a leg,
  // and building and hashing a string for each of the cells a query reads
  // took almost half of all the planning.
  lengths.sort((x, y) => x - y);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const r of routes.values()) {
    for (let j = 0; j < r.points.length; j++) {
      const k = j % 3;
      lo[k] = Math.min(lo[k]!, r.points[j]!);
      hi[k] = Math.max(hi[k]!, r.points[j]!);
    }
  }
  if (routes.size === 0) {
    lo.fill(0);
    hi.fill(0);
  }
  // A cell that is not a positive number falls back to the median segment:
  // slow to ask, but every answer still right.
  const cell = Math.max(
    input.cell > 0 && Number.isFinite(input.cell)
      ? input.cell
      : Math.max(1e-3, lengths[lengths.length >> 1] ?? 1),
    ...[0, 1, 2].map((k) => (hi[k]! - lo[k]!) / MAX_CELLS),
  );
  const cells = [0, 1, 2].map((k) => Math.floor((hi[k]! - lo[k]!) / cell) + 1) as Vec3;
  const cellOf = (v: number, k: 0 | 1 | 2) => Math.floor((v - lo[k]) / cell);
  const grid = new Map<number, Entry[]>();
  const file = (entry: Entry, a: Vec3, b: Vec3) => {
    for (let z = cellOf(Math.min(a[2], b[2]), 2); z <= cellOf(Math.max(a[2], b[2]), 2); z++) {
      for (let y = cellOf(Math.min(a[1], b[1]), 1); y <= cellOf(Math.max(a[1], b[1]), 1); y++) {
        for (let x = cellOf(Math.min(a[0], b[0]), 0); x <= cellOf(Math.max(a[0], b[0]), 0); x++) {
          const h = x + cells[0] * (y + cells[1] * z);
          const list = grid.get(h);
          // The pieces touching a cell follow one another: the last entry is
          // the only one this segment may already have there.
          if (!list) grid.set(h, [entry]);
          else if (list[list.length - 1] !== entry) list.push(entry);
        }
      }
    }
  };
  for (const r of routes.values()) {
    const p = r.points;
    for (let i = 0; i + 1 < r.arc.length; i++) {
      const o = i * 3;
      const entry: Entry = { route: r, i, seen: 0 };
      const pieces = Math.max(1, Math.ceil((r.arc[i + 1]! - r.arc[i]!) / cell));
      const a: Vec3 = [p[o]!, p[o + 1]!, p[o + 2]!];
      for (let k = 1; k <= pieces; k++) {
        // The last piece ends exactly where the segment does, not a rounding away.
        const f = k / pieces;
        const b: Vec3 =
          k === pieces
            ? [p[o + 3]!, p[o + 4]!, p[o + 5]!]
            : [
                p[o]! + (p[o + 3]! - p[o]!) * f,
                p[o + 1]! + (p[o + 4]! - p[o + 1]!) * f,
                p[o + 2]! + (p[o + 5]! - p[o + 2]!) * f,
              ];
        file(entry, a, b);
        a[0] = b[0];
        a[1] = b[1];
        a[2] = b[2];
      }
    }
  }
  /** Queries so far: what a line or a segment last met is stamped with the query's number. */
  let queries = 0;

  return {
    has: (key) => drawn(key) !== null,
    point(key, u, out) {
      const r = drawn(key);
      if (!r) return false;
      const total = r.arc[r.arc.length - 1]!;
      const s = Math.max(0, Math.min(1, u)) * total;
      // The segment holding s: the last arc mark at or below it.
      let lo = 0;
      let hi = r.arc.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (r.arc[mid]! <= s) lo = mid;
        else hi = mid;
      }
      const len = r.arc[hi]! - r.arc[lo]!;
      const f = len > 0 ? (s - r.arc[lo]!) / len : 0;
      const o = lo * 3;
      out[0] = r.points[o]! + (r.points[o + 3]! - r.points[o]!) * f;
      out[1] = r.points[o + 1]! + (r.points[o + 4]! - r.points[o + 1]!) * f;
      out[2] = r.points[o + 2]! + (r.points[o + 5]! - r.points[o + 2]!) * f;
      return true;
    },
    closest(key, q, uMin = 0, uMax = 1) {
      const r = drawn(key);
      if (!r) return null;
      const { points, arc } = r;
      const total = arc[arc.length - 1]!;
      const sMin = uMin * total;
      const sMax = uMax * total;
      // Measured in place, segment by segment: grips ask this a thousand times a leg.
      let best = Infinity;
      let at = -1;
      let along = 0;
      for (let i = 0; i + 1 < arc.length; i++) {
        const s0 = arc[i]!;
        const len = arc[i + 1]! - s0;
        // A piece of no length — a repeated point, a corner on a note — sits
        // at s0: outside the range, it would hand back a u outside it.
        if (!(len > 0) && (s0 < sMin || s0 > sMax)) continue;
        const lo = len > 0 ? Math.max(0, (sMin - s0) / len) : 0;
        const hi = len > 0 ? Math.min(1, (sMax - s0) / len) : 1;
        if (lo > hi) continue;
        const o = i * 3;
        const ax = points[o]!;
        const ay = points[o + 1]!;
        const az = points[o + 2]!;
        const bx = points[o + 3]! - ax;
        const by = points[o + 4]! - ay;
        const bz = points[o + 5]! - az;
        const l2 = bx * bx + by * by + bz * bz;
        let f = l2 > 0 ? ((q[0] - ax) * bx + (q[1] - ay) * by + (q[2] - az) * bz) / l2 : lo;
        f = Math.max(lo, Math.min(hi, f));
        const dx = ax + bx * f - q[0];
        const dy = ay + by * f - q[1];
        const dz = az + bz * f - q[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) {
          best = d2;
          at = i;
          along = f;
        }
      }
      if (at < 0) return null;
      const o = at * 3;
      const p: Vec3 = [
        points[o]! + (points[o + 3]! - points[o]!) * along,
        points[o + 1]! + (points[o + 4]! - points[o + 1]!) * along,
        points[o + 2]! + (points[o + 5]! - points[o + 2]!) * along,
      ];
      const s = arc[at]! + (arc[at + 1]! - arc[at]!) * along;
      return { u: total > 0 ? s / total : 0, d2: best, p };
    },
    node(id, out) {
      const p = input.nodes.get(id);
      if (!p || !shown(id) || !Number.isFinite(p[0] + p[1] + p[2])) return false;
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return true;
    },
    around(ids, hops, max) {
      const out = new Set<ThreadKey>();
      let frontier = [...ids];
      const seen = new Set(frontier);
      for (let h = 0; h < hops && out.size < max; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const key of input.adjacency.get(id) ?? []) {
            const r = drawn(key);
            if (!r) continue;
            out.add(key);
            if (out.size >= max) break;
            const other = r.a === id ? r.b : r.a;
            if (!seen.has(other)) {
              seen.add(other);
              next.push(other);
            }
          }
          if (out.size >= max) break;
        }
        frontier = next;
      }
      return [...out];
    },
    up(_p, out) {
      out[0] = up[0];
      out[1] = up[1];
      out[2] = up[2];
    },
    length(key) {
      const r = routes.get(key);
      return r ? r.arc[r.arc.length - 1]! : 0;
    },
    nearby(q, radius, max) {
      if (!(radius >= 0) || !(max > 0)) return [];
      const stamp = ++queries;
      const met: Route[] = [];
      const clamp = (v: number, k: 0 | 1 | 2) => Math.max(0, Math.min(cells[k] - 1, v));
      const x0 = clamp(cellOf(q[0] - radius, 0), 0);
      const x1 = clamp(cellOf(q[0] + radius, 0), 0);
      const y0 = clamp(cellOf(q[1] - radius, 1), 1);
      const y1 = clamp(cellOf(q[1] + radius, 1), 1);
      const z0 = clamp(cellOf(q[2] - radius, 2), 2);
      const z1 = clamp(cellOf(q[2] + radius, 2), 2);
      // A query wholly outside the lines' box clamps to its edge: the
      // distance check below still keeps only what is within the radius.
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const list = grid.get(x + cells[0] * (y + cells[1] * z));
            if (!list) continue;
            for (const e of list) {
              if (e.seen === stamp) continue;
              e.seen = stamp;
              const r = e.route;
              if (r.seen !== stamp) {
                r.seen = stamp;
                r.drawn = shown(r.a) && shown(r.b);
                r.d2 = Infinity;
                if (r.drawn) met.push(r);
              }
              if (r.drawn) r.d2 = Math.min(r.d2, segmentD2(r.points, e.i, q));
            }
          }
        }
      }
      const r2 = radius * radius;
      let n = 0;
      for (const r of met) if (r.d2 <= r2) met[n++] = r;
      met.length = n;
      met.sort((m, k) => m.d2 - k.d2 || (m.key < k.key ? -1 : 1));
      const out: ThreadKey[] = [];
      for (let i = 0; i < n && i < max; i++) out.push(met[i]!.key);
      return out;
    },
  };
}
