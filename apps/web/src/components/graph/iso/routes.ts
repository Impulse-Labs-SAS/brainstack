// The cables in line art: a link drawn as an orthogonal route that keeps to the streets between
// the plates, the way a city is wired. A cable leaves its note's block between the rows of its
// grid, steps off one plate after another down to the nearest plate both notes stand over,
// crosses it, and climbs back up to the other note.
//
// The decision worth keeping: on each plate a route is searched on the Hanan grid of what stands
// on it — its own grid and its child plates, each grown by half the plate's gap. Two neighbours'
// grown rects meet on the centreline of the street between them, so a cable runs down the middle
// of a street rather than along a plate's side, and A* with a cost for every turn keeps it to few
// corners. A plate's lines and obstacles are built once per layout, the first time a cable
// crosses it.
//
// Pure: numbers in, numbers out, the same points for the same layout.

import { BLOCK } from './block';
import { GAPS, type IsoLayout } from './layout/territories';

export type Vec3 = [number, number, number];

/** One cable: its points in the world, from the note it leaves to the one it reaches. */
export interface Route {
  points: Vec3[];
  /** World units: the sum of its segments. */
  length: number;
}

/** A cable between two projects of one vault: plate indices, `a` the lower, run from a to b. */
export interface ProjectRoute extends Route {
  a: number;
  b: number;
  /** How many links it carries, either way. */
  count: number;
}

/** How far above the top of the plate it crosses a cable runs: on the surface, not in it. */
export const ROUTE_LIFT = 0.01;

/** The ground under the vaults, at z 0: every vault plate's parent, with no plate of its own. */
const WORLD = -1;
/** What a turn costs, in world units of length: a longer way round beats one more corner. */
const TURN = 1.4;
/** How far from a plate's corner a cable may step off its edge. */
const CORNER = 0.25;
/**
 * Coordinates are snapped to a millionth of a unit, so two that should meet do whatever the
 * arithmetic that reached them: a street's line and the point stepped out onto it.
 */
const SNAP = 1e6;
/** Closer than this, a point is on a line, not on either side of it. */
const EPS = 1e-4;
/** A* states per node: arrived moving +x, −x, +y or −y, or not moved yet. */
const STATES = 5;
const NONE = 4;
const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;

interface Pt {
  x: number;
  y: number;
}
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type Side = 'px' | 'nx' | 'py' | 'ny';

/** A note as the router reads it: its cell's centre, its column and row, its plate and grid. */
interface Spot extends Pt {
  plate: number;
  col: number;
  row: number;
  grid: Box;
}

/** A plate's streets: what stands on it, grown, and the lines a route may run along. */
interface Streets {
  box: Box;
  /**
   * The street round everything on the plate: the obstacles' bounds, inside the plate's edge by
   * its padding less half its gap. Its sides are the outermost lines a route runs along, so a
   * cable never runs along a plate's rim, where it would trace the plate's own outline.
   */
  ring: Box;
  /** Obstacles grown by half the plate's gap, snapped: x0, y0, x1, y1 each. */
  obs: Float64Array;
  /** The Hanan lines: every obstacle's edges, snapped, sorted, each once. */
  xs: number[];
  ys: number[];
  /** Per interval between two consecutive `xs`, the obstacles that span it. */
  cols: number[][];
}

const snap = (v: number) => Math.round(v * SNAP) / SNAP;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const grow = (b: Box, d: number): Box => ({
  x0: b.x0 - d,
  y0: b.y0 - d,
  x1: b.x1 + d,
  y1: b.y1 + d,
});
const centre = (b: Box): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const holds = (b: Box, x: number, y: number) =>
  x >= b.x0 - EPS && x <= b.x1 + EPS && y >= b.y0 - EPS && y <= b.y1 + EPS;
const gridBox = (g: { x: number; y: number; cols: number; rows: number }): Box => ({
  x0: g.x,
  y0: g.y,
  x1: g.x + g.cols,
  y1: g.y + g.rows,
});
const at = (pts: readonly Pt[], z: number): Vec3[] => pts.map((p) => [p.x, p.y, z]);

/** The first index of `sorted` whose value is above `v`. */
function above(sorted: readonly number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Snapped values between `lo` and `hi`, sorted, each once. */
function lines(values: number[], lo: number, hi: number): number[] {
  const sorted = values.filter((v) => v >= lo - EPS && v <= hi + EPS).sort((p, q) => p - q);
  return sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
}

/** `base` with `a` and `b` among its lines, where they are not already. */
function withLines(base: readonly number[], a: number, b: number): number[] {
  const out = base.slice();
  for (const v of [a, b]) {
    const i = above(out, v);
    if (out[i - 1] !== v) out.splice(i, 0, v);
  }
  return out;
}

/** The side of `r` that faces `p`: the one its direction from the centre leaves by. */
function sideOf(r: Box, p: Pt): Side {
  const dx = (p.x - (r.x0 + r.x1) / 2) / ((r.x1 - r.x0) / 2 + 1e-9);
  const dy = (p.y - (r.y0 + r.y1) / 2) / ((r.y1 - r.y0) / 2 + 1e-9);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'px' : 'nx';
  return dy >= 0 ? 'py' : 'ny';
}

/**
 * Where a cable steps off `side` of plate `r` toward `p`: level with it, kept off the corners and
 * within the span of `ring`, the street round the plate's contents, so it reaches the edge
 * straight from that street.
 */
function edgePoint(r: Box, ring: Box, side: Side, p: Pt): Pt {
  const x = clamp(p.x, Math.max(r.x0 + CORNER, ring.x0), Math.min(r.x1 - CORNER, ring.x1));
  const y = clamp(p.y, Math.max(r.y0 + CORNER, ring.y0), Math.min(r.y1 - CORNER, ring.y1));
  if (side === 'px') return { x: r.x1, y };
  if (side === 'nx') return { x: r.x0, y };
  if (side === 'py') return { x, y: r.y1 };
  return { x, y: r.y0 };
}

/** The point of `ring` straight in from `p`, a point on `side` of the plate's edge. */
function inward(ring: Box, side: Side, p: Pt): Pt {
  if (side === 'px') return { x: ring.x1, y: p.y };
  if (side === 'nx') return { x: ring.x0, y: p.y };
  if (side === 'py') return { x: p.x, y: ring.y1 };
  return { x: p.x, y: ring.y0 };
}

function outward(p: Pt, side: Side, d: number): Pt {
  if (side === 'px') return { x: p.x + d, y: p.y };
  if (side === 'nx') return { x: p.x - d, y: p.y };
  if (side === 'py') return { x: p.x, y: p.y + d };
  return { x: p.x, y: p.y - d };
}

/** Whether (x, y) is inside something standing on the plate, the half street round it included. */
function blocked(st: Streets, x: number, y: number): boolean {
  const { xs, cols, obs } = st;
  if (xs.length < 2) return false;
  // An obstacle's edges are lines, so one that holds x spans the interval x is in.
  const k = clamp(above(xs, x) - 1, 0, xs.length - 2);
  for (const o of cols[k]!) {
    const i = o * 4;
    if (
      x > obs[i]! + EPS &&
      x < obs[i + 2]! - EPS &&
      y > obs[i + 1]! + EPS &&
      y < obs[i + 3]! - EPS
    )
      return true;
  }
  return false;
}

/** Between two notes of one grid, along the gaps between its rows and columns. */
function gridRoute(a: Spot, b: Spot): Pt[] {
  const hb = BLOCK / 2;
  const sx = Math.sign(b.x - a.x);
  const sy = Math.sign(b.y - a.y);
  if (a.row === b.row && Math.abs(a.col - b.col) === 1)
    return [
      { x: a.x + sx * hb, y: a.y },
      { x: b.x - sx * hb, y: b.y },
    ];
  if (a.col === b.col && Math.abs(a.row - b.row) === 1)
    return [
      { x: a.x, y: a.y + sy * hb },
      { x: b.x, y: b.y - sy * hb },
    ];
  if (a.row === b.row) {
    const gy = a.y + 0.5;
    return [
      { x: a.x, y: a.y + hb },
      { x: a.x, y: gy },
      { x: b.x, y: gy },
      { x: b.x, y: b.y + hb },
    ];
  }
  // Out of a's row toward b's, along to the gap beside b's column, and into b from that side.
  const side = sx || 1;
  const gy = a.y + sy * 0.5;
  const gx = b.x - side * 0.5;
  return [
    { x: a.x, y: a.y + sy * hb },
    { x: a.x, y: gy },
    { x: gx, y: gy },
    { x: gx, y: b.y },
    { x: b.x - side * hb, y: b.y },
  ];
}

/** The cable as drawn: snapped, without repeated points or points in line with their neighbours. */
function finish(path: readonly Vec3[]): Route {
  const points: Vec3[] = [];
  for (const p of path) {
    const q: Vec3 = [snap(p[0]), snap(p[1]), snap(p[2])];
    const last = points[points.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1] && last[2] === q[2]) continue;
    const before = points[points.length - 2];
    if (before && last && straightOn(before, last, q)) points[points.length - 1] = q;
    else points.push(q);
  }
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [p, q] = [points[i - 1]!, points[i]!];
    length += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  }
  return { points, length };
}

/** Whether going on from `m` to `q` keeps the direction from `p` to `m`: `m` is no corner. */
function straightOn(p: Vec3, m: Vec3, q: Vec3): boolean {
  const u = [m[0] - p[0], m[1] - p[1], m[2] - p[2]] as const;
  const v = [q[0] - m[0], q[1] - m[1], q[2] - m[2]] as const;
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return cross.every((c) => Math.abs(c) <= 1e-9) && u[0] * v[0] + u[1] * v[1] + u[2] * v[2] > 0;
}

/** A binary min-heap of search states by their estimated cost. */
class Heap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  /** The lowest key: the next `pop`'s. */
  key(): number {
    return this.keys[0]!;
  }

  push(key: number, val: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up]! <= key) break;
      keys[i] = keys[up]!;
      vals[i] = vals[up]!;
      i = up;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): number {
    const { keys, vals } = this;
    const top = vals[0]!;
    const key = keys.pop()!;
    const val = vals.pop()!;
    const n = keys.length;
    if (!n) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      let m = -1;
      let mk = key;
      if (l < n && keys[l]! < mk) [m, mk] = [l, keys[l]!];
      if (l + 1 < n && keys[l + 1]! < mk) [m, mk] = [l + 1, keys[l + 1]!];
      if (m < 0) break;
      keys[i] = mk;
      vals[i] = vals[m]!;
      i = m;
    }
    keys[i] = key;
    vals[i] = val;
    return top;
  }
}

/** The routes of one layout. A layout is never changed once made, so what it builds is kept. */
class Router {
  /** Per plate, the world first: the plates standing on it. */
  private readonly children: number[][];
  /** Per plate: the project it is, or is in; -1 for a vault. */
  private readonly project: Int32Array;
  /** Per plate, the world first, once a cable has crossed it. */
  private readonly built: (Streets | undefined)[] = [];

  constructor(private readonly layout: IsoLayout) {
    const { plates } = layout;
    this.children = Array.from({ length: plates.length + 1 }, () => []);
    this.project = new Int32Array(plates.length).fill(-1);
    // Every parent comes before its children, so a folder finds its project already set.
    plates.forEach((p, i) => {
      this.children[p.parent + 1]!.push(i);
      if (p.depth === 2) this.project[i] = i;
      else if (p.depth > 2) this.project[i] = this.project[p.parent]!;
    });
  }

  route(a: number, b: number): Route {
    if (a === b || !this.isNote(a) || !this.isNote(b)) return { points: [], length: 0 };
    const A = this.spot(a);
    const B = this.spot(b);
    if (A.plate === B.plate) return finish(at(gridRoute(A, B), this.z(A.plate)));
    const meet = this.meet(A.plate, B.plate);
    // Each end leaves its plates on the side facing the other note, but level with the point
    // halfway between them. Level with the other note, two ends offset along the street would
    // each run past the other, and the cable would double back across the plate they meet on.
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const up = this.climb(A, meet, B, mid);
    const down = this.climb(B, meet, A, mid);
    const [s, t] = [up[up.length - 1]!, down[down.length - 1]!];
    const across = this.routeIn(meet, { x: s[0], y: s[1] }, { x: t[0], y: t[1] });
    return finish([...up, ...at(across, this.z(meet)), ...down.reverse()]);
  }

  projects(links: readonly (readonly [number, number])[]): ProjectRoute[] {
    const { plates, plateOf } = this.layout;
    const counts = new Map<number, number>();
    for (const [i, j] of links) {
      if (!this.isNote(i) || !this.isNote(j)) continue;
      const pa = this.project[plateOf[i]!]!;
      const pb = this.project[plateOf[j]!]!;
      if (pa < 0 || pb < 0 || pa === pb || plates[pa]!.parent !== plates[pb]!.parent) continue;
      const key = Math.min(pa, pb) * plates.length + Math.max(pa, pb);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.keys()]
      .sort((p, q) => p - q)
      .map((key) => {
        const a = Math.floor(key / plates.length);
        const b = key % plates.length;
        return { a, b, count: counts.get(key)!, ...this.between(a, b) };
      });
  }

  private isNote(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.layout.ids.length;
  }

  private parentOf(c: number): number {
    return this.layout.plates[c]!.parent;
  }

  /** A plate's footprint; the world's is the vaults' bounds and the street round them. */
  private box(c: number): Box {
    if (c === WORLD) return grow(this.layout.bounds, GAPS.world);
    const p = this.layout.plates[c]!;
    return { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
  }

  /** Half the street between what stands on a plate: from a neighbour's edge to its centreline. */
  private ro(c: number): number {
    return (c === WORLD ? GAPS.world : GAPS[this.layout.plates[c]!.kind]) / 2;
  }

  /** The height a cable runs at across a plate. */
  private z(c: number): number {
    return (c === WORLD ? 0 : this.layout.plates[c]!.z1) + ROUTE_LIFT;
  }

  /** The nearest plate both are on or over; the world when they are in different vaults. */
  private meet(a: number, b: number): number {
    const seen = new Set<number>();
    for (let c = a; c !== WORLD; c = this.parentOf(c)) seen.add(c);
    for (let c = b; c !== WORLD; c = this.parentOf(c)) if (seen.has(c)) return c;
    return WORLD;
  }

  private spot(i: number): Spot {
    const { cells, plateOf, plates } = this.layout;
    const plate = plateOf[i]!;
    const cx = cells[i * 3]!;
    const cy = cells[i * 3 + 1]!;
    // The centre again at full precision, from the grid: `cells` holds it as a float32, and a
    // cable that left a block a rounding error off its face would not meet the gap between rows.
    const g = plates[plate]!.grid ?? { x: cx - 0.5, y: cy - 0.5, cols: 1, rows: 1 };
    const col = Math.round(cx - g.x - 0.5);
    const row = Math.round(cy - g.y - 0.5);
    return { x: g.x + col + 0.5, y: g.y + row + 0.5, plate, col, row, grid: gridBox(g) };
  }

  /** From a note's block, out between the rows (or columns) of its grid to the street round it. */
  private gridExit(n: Spot, toward: Pt): Pt[] {
    const G = n.grid;
    const o = this.ro(n.plate);
    const hb = BLOCK / 2;
    const side = sideOf(G, toward);
    if (side === 'px' || side === 'nx') {
      const s = toward.y < n.y ? -1 : 1;
      const x = side === 'px' ? G.x1 + o : G.x0 - o;
      return [
        { x: n.x, y: n.y + s * hb },
        { x: n.x, y: n.y + s * 0.5 },
        { x, y: n.y + s * 0.5 },
      ];
    }
    const s = toward.x < n.x ? -1 : 1;
    const y = side === 'py' ? G.y1 + o : G.y0 - o;
    return [
      { x: n.x + s * hb, y: n.y },
      { x: n.x + s * 0.5, y: n.y },
      { x: n.x + s * 0.5, y },
    ];
  }

  /**
   * From a note's block to the streets of `to`, a plate under the note's own: out of its grid,
   * then off each plate's edge on the side facing `toward`, level with `level` as near as the
   * edge allows, a drop to the parent's top and a step out to the street round the plate. The
   * last point is on `to`.
   */
  private climb(n: Spot, to: number, toward: Pt, level: Pt): Vec3[] {
    let c = n.plate;
    const exit = this.gridExit(n, toward);
    const path = at(exit, this.z(c));
    let from = exit[exit.length - 1]!;
    while (c !== to) {
      const parent = this.parentOf(c);
      const box = this.box(c);
      const { ring } = this.streets(c);
      const side = sideOf(box, toward);
      const edge = edgePoint(box, ring, side, level);
      // Along the streets to the one round the plate's contents, and straight off the edge.
      path.push(...at(this.routeIn(c, from, inward(ring, side, edge)), this.z(c)));
      from = outward(edge, side, this.ro(parent));
      path.push(
        [edge.x, edge.y, this.z(c)],
        [edge.x, edge.y, this.z(parent)],
        [from.x, from.y, this.z(parent)],
      );
      c = parent;
    }
    return path;
  }

  /** Two projects of one vault, across its top from the edges they face each other by. */
  private between(a: number, b: number): Route {
    const vault = this.parentOf(a);
    const ra = this.box(a);
    const rb = this.box(b);
    // Level with the point between the two, as a note's cable is (see `route`).
    const [ca, cb] = [centre(ra), centre(rb)];
    const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
    const [sa, sb] = [sideOf(ra, cb), sideOf(rb, ca)];
    const ea = edgePoint(ra, this.streets(a).ring, sa, mid);
    const eb = edgePoint(rb, this.streets(b).ring, sb, mid);
    const o = this.ro(vault);
    const across = this.routeIn(vault, outward(ea, sa, o), outward(eb, sb, o));
    return finish(at([ea, ...across, eb], this.z(vault)));
  }

  private streets(c: number): Streets {
    const known = this.built[c + 1];
    if (known) return known;
    const box = this.box(c);
    const ro = this.ro(c);
    const rects = this.children[c + 1]!.map((k) => this.box(k));
    const grid = c === WORLD ? null : this.layout.plates[c]!.grid;
    if (grid) rects.unshift(gridBox(grid));
    // The sums the exits and steps out make, so a street's line and a point stepped onto it agree.
    const obs = new Float64Array(rects.length * 4);
    rects.forEach((r, i) =>
      obs.set([snap(r.x0 - ro), snap(r.y0 - ro), snap(r.x1 + ro), snap(r.y1 + ro)], i * 4),
    );
    const along = (d: 0 | 1) => Array.from(obs).filter((_, i) => i % 2 === d);
    const [ox, oy] = [along(0), along(1)];
    const ring = rects.length
      ? { x0: Math.min(...ox), y0: Math.min(...oy), x1: Math.max(...ox), y1: Math.max(...oy) }
      : { x0: snap(box.x0), y0: snap(box.y0), x1: snap(box.x1), y1: snap(box.y1) };
    const xs = lines([ring.x0, ring.x1, ...ox], box.x0, box.x1);
    const ys = lines([ring.y0, ring.y1, ...oy], box.y0, box.y1);
    const cols: number[][] = xs.slice(1).map(() => []);
    for (let o = 0; o < rects.length; o++) {
      const from = above(xs, obs[o * 4]!) - 1;
      const to = above(xs, obs[o * 4 + 2]!) - 1;
      for (let k = Math.max(0, from); k < to; k++) cols[k]!.push(o);
    }
    const st: Streets = { box, ring, obs, xs, ys, cols };
    this.built[c + 1] = st;
    return st;
  }

  /** An orthogonal route from `s` to `t` across plate `c`, along the streets between its parts. */
  private routeIn(c: number, s: Pt, t: Pt): Pt[] {
    const st = this.streets(c);
    const fallback = [s, { x: t.x, y: s.y }, t];
    const [sx, sy, tx, ty] = [snap(s.x), snap(s.y), snap(t.x), snap(t.y)];
    if (!holds(st.box, sx, sy) || !holds(st.box, tx, ty)) return fallback;
    if (sx === tx && sy === ty) return [{ x: sx, y: sy }];
    const xs = withLines(st.xs, sx, tx);
    const ys = withLines(st.ys, sy, ty);
    const nx = xs.length;
    const ny = ys.length;
    const start = (above(ys, sy) - 1) * nx + above(xs, sx) - 1;
    const goal = (above(ys, ty) - 1) * nx + above(xs, tx) - 1;

    // What is free is found as the search reaches it: 0 not known yet, 1 free, 2 blocked. The
    // ends are free whatever they touch; an edge is free when its middle is.
    const node = new Uint8Array(nx * ny);
    const edgeX = new Uint8Array(nx * ny);
    const edgeY = new Uint8Array(nx * ny);
    node[start] = node[goal] = 1;
    const free = (memo: Uint8Array, i: number, x: number, y: number) => {
      let v = memo[i]!;
      if (!v) memo[i] = v = blocked(st, x, y) ? 2 : 1;
      return v === 1;
    };

    const g = new Float64Array(nx * ny * STATES).fill(Infinity);
    const prev = new Int32Array(nx * ny * STATES).fill(-1);
    const h = (n: number) => Math.abs(xs[n % nx]! - tx) + Math.abs(ys[(n / nx) | 0]! - ty);
    const heap = new Heap();
    g[start * STATES + NONE] = 0;
    heap.push(h(start), start * STATES + NONE);
    let end = -1;
    while (heap.size) {
      const f = heap.key();
      const state = heap.pop();
      const n = (state / STATES) | 0;
      if (n === goal) {
        end = state;
        break;
      }
      const cost = g[state]!;
      // Queued before the state was reached more cheaply: that entry is stale.
      if (f > cost + h(n) + 1e-9) continue;
      const dir = state % STATES;
      const i = n % nx;
      const j = (n / nx) | 0;
      for (let k = 0; k < 4; k++) {
        const ii = i + DX[k]!;
        const jj = j + DY[k]!;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const m = jj * nx + ii;
        const [xa, xb, ya, yb] = [xs[i]!, xs[ii]!, ys[j]!, ys[jj]!];
        if (!free(node, m, xb, yb)) continue;
        if (!free(k < 2 ? edgeX : edgeY, Math.min(n, m), (xa + xb) / 2, (ya + yb) / 2)) continue;
        const next =
          cost + Math.abs(xb - xa) + Math.abs(yb - ya) + (dir !== NONE && dir !== k ? TURN : 0);
        const ms = m * STATES + k;
        if (next < g[ms]! - 1e-9) {
          g[ms] = next;
          prev[ms] = state;
          heap.push(next + h(m), ms);
        }
      }
    }
    if (end < 0) return fallback;
    const out: Pt[] = [];
    for (let k = end; k >= 0; k = prev[k]!) {
      const n = (k / STATES) | 0;
      out.push({ x: xs[n % nx]!, y: ys[(n / nx) | 0]! });
    }
    return out.reverse();
  }
}

const routers = new WeakMap<IsoLayout, Router>();
function routerOf(layout: IsoLayout): Router {
  let router = routers.get(layout);
  if (!router) routers.set(layout, (router = new Router(layout)));
  return router;
}

/**
 * The cable from note `a` to note `b` (indices in layout.ids), along the streets. Empty from a
 * note to itself.
 */
export function routeBetween(layout: IsoLayout, a: number, b: number): Route {
  return routerOf(layout).route(a, b);
}

/** Every cable from `from` to each of `to`, as the kit draws a selection's links. */
export function routesFrom(layout: IsoLayout, from: number, to: readonly number[]): Route[] {
  const router = routerOf(layout);
  return to.map((t) => router.route(from, t));
}

/**
 * One cable per pair of projects in a vault that link to each other, with how many links it
 * carries. `links` are pairs of note indices, either way round.
 */
export function projectRoutes(
  layout: IsoLayout,
  links: readonly (readonly [number, number])[],
): ProjectRoute[] {
  return routerOf(layout).projects(links);
}
