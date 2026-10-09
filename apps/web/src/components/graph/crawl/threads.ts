// The threads a crawl walks, as geometry — pure, so the replay and the Sentinel
// can be tested without a canvas.
//
// A thread is a link someone wrote, or a structure edge to an index: the edges
// `walkable` accepts. It is named by its two notes' ids, in either order,
// because the graph builds new edge objects on every rebuild (a layer toggled,
// a vault loaded) while the notes keep their objects and ids. Anything that
// remembers a thread across frames — what is lit, what a tentacle holds —
// remembers its key, never the edge.
//
// The scene draws each thread as a gentle quadratic curve, cut into six
// straight chords. Grips land on those chords, exactly where the line is drawn;
// walking uses the true curve, which is never more than a fraction of a pixel
// away.

import type { GraphEdge, GraphModel, GraphNode } from '@/lib/graph-model';

import { walkable } from './crawl-plan';
import { UP, dist, type Vec3 } from './vec';

/** Two note ids, order-free: the same thread whichever end you start from. */
export type ThreadKey = string;

const SEP = '\u0000';

export function threadKey(a: { id: string }, b: { id: string }): ThreadKey {
  return a.id < b.id ? `${a.id}${SEP}${b.id}` : `${b.id}${SEP}${a.id}`;
}

/** The ids a key joins, in key order: positions along a thread are measured from the first. */
export function threadEnds(key: ThreadKey): [string, string] {
  const i = key.indexOf(SEP);
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Chords per thread in the scene's line geometry (graph-scene.ts `SEGMENTS`). */
export const THREAD_CHORDS = 6;

/** Where a node is drawn, search lift included — the threads are drawn from there. */
export function at(n: GraphNode): Vec3 {
  return [n.x + n.ox, n.y + n.oy, (n.z || 0) + n.oz];
}

/** The control point of the curve the scene draws from `s` to `g`. */
function control(s: Vec3, g: Vec3): Vec3 {
  const dx = g[0] - s[0];
  const dy = g[1] - s[1];
  return [(s[0] + g[0]) / 2 - dy * 0.1, (s[1] + g[1]) / 2 + dx * 0.1, (s[2] + g[2]) / 2];
}

function bezier(s: Vec3, c: Vec3, g: Vec3, t: number): Vec3 {
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const z = t * t;
  return [
    a * s[0] + b * c[0] + z * g[0],
    a * s[1] + b * c[1] + z * g[1],
    a * s[2] + b * c[2] + z * g[2],
  ];
}

/** A point on an edge's curve, `t` from its source: the curve graph-scene and graph-overlay draw. */
export function onEdge(e: GraphEdge, t: number): Vec3 {
  const s = at(e.source);
  const g = at(e.target);
  return bezier(s, control(s, g), g, t);
}

/** A point on the six chords the scene actually draws, `u` from the edge's source. */
export function onChords(e: GraphEdge, u: number): Vec3 {
  const s = at(e.source);
  const g = at(e.target);
  const c = control(s, g);
  const x = Math.max(0, Math.min(1, u)) * THREAD_CHORDS;
  const k = Math.min(THREAD_CHORDS - 1, Math.floor(x));
  const a = bezier(s, c, g, k / THREAD_CHORDS);
  const b = bezier(s, c, g, (k + 1) / THREAD_CHORDS);
  const f = x - k;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * The point of an edge's drawn chords closest to `q`, with `u` (from the
 * source) kept within [uMin, uMax] — away from the notes at either end.
 */
export function closestOnEdge(
  e: GraphEdge,
  q: Vec3,
  uMin = 0,
  uMax = 1,
): { u: number; d2: number; p: Vec3 } {
  const s = at(e.source);
  const g = at(e.target);
  const c = control(s, g);
  let best = { u: uMin, d2: Infinity, p: s };
  let a = bezier(s, c, g, 0);
  for (let k = 0; k < THREAD_CHORDS; k++) {
    const b = bezier(s, c, g, (k + 1) / THREAD_CHORDS);
    // The part of this chord inside [uMin, uMax], as a fraction of it.
    const lo = Math.max(0, uMin * THREAD_CHORDS - k);
    const hi = Math.min(1, uMax * THREAD_CHORDS - k);
    if (lo > hi) {
      a = b;
      continue;
    }
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const l2 = abx * abx + aby * aby + abz * abz;
    let f = l2 > 0 ? ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby + (q[2] - a[2]) * abz) / l2 : lo;
    f = Math.max(lo, Math.min(hi, f));
    const u = (k + f) / THREAD_CHORDS;
    const p: Vec3 = [a[0] + abx * f, a[1] + aby * f, a[2] + abz * f];
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    const dz = p[2] - q[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best.d2) best = { u, d2, p };
    a = b;
  }
  return best;
}

/** One stretch of a walk: along a thread, or straight across where no thread joins two notes. */
export interface WalkSegment {
  from: GraphNode;
  to: GraphNode;
  /** The thread walked; null across the void. */
  edge: GraphEdge | null;
  length: number;
}

/** A point on a walk segment, `t` from its `from` end. Across the void, silk sags under its weight. */
export function pointOnSegment(seg: Omit<WalkSegment, 'length'>, t: number, unit: number): Vec3 {
  if (seg.edge) return onEdge(seg.edge, seg.edge.source === seg.from ? t : 1 - t);
  const a = at(seg.from);
  const b = at(seg.to);
  const sag = -Math.sin(Math.PI * t) * unit * 0.6;
  return [
    a[0] + (b[0] - a[0]) * t + UP[0] * sag,
    a[1] + (b[1] - a[1]) * t + UP[1] * sag,
    a[2] + (b[2] - a[2]) * t + UP[2] * sag,
  ];
}

export function segmentLength(seg: Omit<WalkSegment, 'length'>, unit: number): number {
  let total = 0;
  let prev = pointOnSegment(seg, 0, unit);
  for (let i = 1; i <= 8; i++) {
    const p = pointOnSegment(seg, i / 8, unit);
    total += dist(prev, p);
    prev = p;
  }
  return Math.max(total, 1e-6);
}

/** A little over half the median thread: the scale everything about the crawl is measured in. */
export function typicalLink(model: Pick<GraphModel, 'edges'>): number {
  const lengths = model.edges
    .filter(walkable)
    .map((e) => dist(at(e.source), at(e.target)))
    .filter((l) => l > 0 && Number.isFinite(l))
    .sort((a, b) => a - b);
  return lengths.length ? lengths[Math.floor(lengths.length / 2)]! * 0.6 : 10;
}

/** One stretch of a leg, by id: what `legPoint` walks. */
export interface LegStretch {
  fromId: string;
  toId: string;
  key: ThreadKey | null;
  length: number;
}

/**
 * Where a cursor `s` (world units from the start) sits along a leg, and the
 * heading there. Threads are followed as drawn; across the void the line
 * sags by `voidSag` (world units, positive is down) at its middle — silk
 * under its weight, or a negative sag for something gliding over the gap.
 * False when a note or thread it needs is gone.
 */
export function legPoint(
  stretches: readonly LegStretch[],
  s: number,
  field: ThreadField,
  voidSag: number,
  out: Vec3,
  heading?: Vec3,
): boolean {
  if (stretches.length === 0) return false;
  let k = 0;
  let d = Math.max(0, s);
  while (k < stretches.length - 1 && d > stretches[k]!.length) {
    d -= stretches[k]!.length;
    k++;
  }
  const st = stretches[k]!;
  const t = Math.max(0, Math.min(1, d / st.length));
  const place = (tt: number, o: Vec3): boolean => {
    if (st.key) {
      const [first] = threadEnds(st.key);
      return field.point(st.key, first === st.fromId ? tt : 1 - tt, o);
    }
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    if (!field.node(st.fromId, a) || !field.node(st.toId, b)) return false;
    const up: Vec3 = [0, 0, 0];
    field.up(a, up);
    const sag = -Math.sin(Math.PI * tt) * voidSag;
    o[0] = a[0] + (b[0] - a[0]) * tt + up[0] * sag;
    o[1] = a[1] + (b[1] - a[1]) * tt + up[1] * sag;
    o[2] = a[2] + (b[2] - a[2]) * tt + up[2] * sag;
    return true;
  };
  if (!place(t, out)) return false;
  if (heading) {
    const step = Math.min(0.05, 0.5 / Math.max(st.length, 1e-6));
    const ahead: Vec3 = [0, 0, 0];
    const behind: Vec3 = [0, 0, 0];
    if (place(Math.min(1, t + step), ahead) && place(Math.max(0, t - step), behind)) {
      const hx = ahead[0] - behind[0];
      const hy = ahead[1] - behind[1];
      const hz = ahead[2] - behind[2];
      const l = Math.hypot(hx, hy, hz);
      if (l > 1e-9) {
        heading[0] = hx / l;
        heading[1] = hy / l;
        heading[2] = hz / l;
      }
    }
  }
  return true;
}

/**
 * The world as the Sentinel sees it: notes as points, threads as curves,
 * named by id and key. It never sees the brain or the model, so the space
 * Crawl walks can change under it.
 */
export interface ThreadField {
  /** A drawn thread: both ends visible, positions finite. */
  has(key: ThreadKey): boolean;
  /** Where a thread is drawn at `u`, measured from its key's first id. False when it is gone. */
  point(key: ThreadKey, u: number, out: Vec3): boolean;
  /** The drawn point of a thread closest to `q`, `u` within [uMin, uMax] from its key's first id. */
  closest(
    key: ThreadKey,
    q: Vec3,
    uMin?: number,
    uMax?: number,
  ): { u: number; d2: number; p: Vec3 } | null;
  /** Where a note is drawn. False when it is hidden, gone or has no position yet. */
  node(id: string, out: Vec3): boolean;
  /** Threads within `hops` of these notes, at most `max`. */
  around(ids: readonly string[], hops: 1 | 2, max: number): ThreadKey[];
  /** Which way is up at a point: the Sentinel floats above its threads along it. */
  up(p: Vec3, out: Vec3): void;
  /**
   * A thread's length as drawn, world units. A field whose threads are not the
   * brain's gentle curve — pipes with elbows, arcs, bridges — says how long
   * they are; without it a walk measures the brain's curve.
   */
  length?(key: ThreadKey): number;
  /**
   * Threads drawn within `r` of `q`, nearest first, at most `max`: what lies at
   * hand, whatever the links say. Without it, grips search around the walk.
   */
  nearby?(q: Vec3, r: number, max: number): ThreadKey[];
}

/** A note is shown once it has appeared this far; the scene hides threads below it. */
const SHOWN = 0.6;

/** The brain's threads as a ThreadField. Positions are read live, so it follows the layout. */
export function graphThreadField(
  model: GraphModel,
  appear: (n: GraphNode) => number = () => 1,
): ThreadField {
  const edges = new Map<ThreadKey, GraphEdge>();
  for (const e of model.edges) if (walkable(e)) edges.set(threadKey(e.source, e.target), e);
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const shown = (n: GraphNode) => appear(n) >= SHOWN && Number.isFinite(n.x + n.y + (n.z || 0));

  const drawn = (key: ThreadKey): GraphEdge | null => {
    const e = edges.get(key);
    return e && shown(e.source) && shown(e.target) ? e : null;
  };
  /** `u` along the key flipped to the edge's own direction, and back. */
  const flip = (e: GraphEdge, key: ThreadKey) => !key.startsWith(`${e.source.id}${SEP}`);

  return {
    has: (key) => drawn(key) !== null,
    point(key, u, out) {
      const e = drawn(key);
      if (!e) return false;
      const p = onChords(e, flip(e, key) ? 1 - u : u);
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return true;
    },
    closest(key, q, uMin = 0, uMax = 1) {
      const e = drawn(key);
      if (!e) return null;
      if (!flip(e, key)) return closestOnEdge(e, q, uMin, uMax);
      const c = closestOnEdge(e, q, 1 - uMax, 1 - uMin);
      return { ...c, u: 1 - c.u };
    },
    node(id, out) {
      const n = nodes.get(id);
      if (!n || !shown(n)) return false;
      const p = at(n);
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return true;
    },
    around(ids, hops, max) {
      const out = new Set<ThreadKey>();
      let frontier = ids.map((id) => nodes.get(id)).filter((n): n is GraphNode => !!n);
      const seen = new Set(frontier);
      for (let h = 0; h < hops && out.size < max; h++) {
        const next: GraphNode[] = [];
        for (const n of frontier) {
          for (const nb of model.adjacency.get(n) ?? []) {
            if (!walkable(nb.edge)) continue;
            const key = threadKey(n, nb.node);
            if (drawn(key)) out.add(key);
            if (out.size >= max) break;
            if (!seen.has(nb.node)) {
              seen.add(nb.node);
              next.push(nb.node);
            }
          }
          if (out.size >= max) break;
        }
        frontier = next;
      }
      return [...out];
    },
    up(_p, out) {
      out[0] = UP[0];
      out[1] = UP[1];
      out[2] = UP[2];
    },
  };
}
