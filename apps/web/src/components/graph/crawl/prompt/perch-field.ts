// The frame round the prompt as threads the grip planner already knows how to
// hold, and a field that is a space's own with that frame in it.
//
// The frame is four rails between four corner nodes, a `polylineThreadField`,
// with the perch's node beside all four so that a field with no `nearby`
// still finds them round it. Merged with the space's field, the replay walks
// from the frame to the cluster and back over one field: the same grips, the
// same crossing of the void, the same motion. Ids start with U+0001, which no
// note path or id holds.
//
// Up is the frame's near the perch — away from the viewer, the creature
// clinging to the back of the panel — and the space's further out. Between
// the two it turns about the screen's right, which both are square to (the
// camera never rolls, and the space's up is +y), so a creature setting out
// from the frame rights itself over the first few units of the crossing. A
// normalised blend of the two shrinks toward nothing as they near opposite —
// the frame flat, the camera looking steeply down — and there it turned the
// body nearly twice as fast as turning about the screen's right does.

import type { CrossingPace, ReplayPerch } from '../crawl-replay';
import { HOVER } from '../sentinel/anatomy';
import { polylineThreadField, type PolylineField } from '../space/polyline-field';
import { threadEnds, threadKey, type ThreadField, type ThreadKey } from '../threads';
import type { Vec3 } from '../vec';

import type { PerchShot } from './perch-geometry';

export const PERCH_ID = '\u0001perch';
/** TL, TR, BR, BL: `${PERCH_ID}:0` … `:3`. */
export const PERCH_CORNERS: readonly [string, string, string, string] = [
  `${PERCH_ID}:0`,
  `${PERCH_ID}:1`,
  `${PERCH_ID}:2`,
  `${PERCH_ID}:3`,
];
/** The rails as thread keys: top, right, bottom, left — each between its two corners. */
export const PERCH_RAILS: readonly ThreadKey[] = PERCH_CORNERS.map((id, i) =>
  threadKey({ id }, { id: PERCH_CORNERS[(i + 1) % 4]! }),
);
export const PERCH_RAIL_SET: ReadonlySet<ThreadKey> = new Set(PERCH_RAILS);

/** The perch's node or one of its corners: nothing of the vault. */
export function isPerchId(id: string): boolean {
  return id === PERCH_ID || id.startsWith(`${PERCH_ID}:`);
}

/**
 * Creature units from the perch's node within which up is wholly the frame's,
 * and past which it is wholly the space's. The perch keeps every note further
 * than UP_FAR away (perch-geometry's `gap`), so the walk among the notes never
 * feels the frame.
 */
export const UP_NEAR = 2;
export const UP_FAR = 8;

/**
 * The frame alone: its rails, the perch's node beside all four (so `around`
 * finds them), up the perch's everywhere, the hash's cell the unit.
 */
export function frameField(shot: PerchShot): PolylineField {
  const nodes = new Map<string, Vec3>([[PERCH_ID, shot.perch.node]]);
  PERCH_CORNERS.forEach((id, i) => nodes.set(id, shot.corners[i]!));
  const routes = new Map<ThreadKey, Float32Array>();
  const adjacency = new Map<string, ThreadKey[]>([[PERCH_ID, [...PERCH_RAILS]]]);
  PERCH_RAILS.forEach((key, i) => {
    // A route runs from its key's first id: the left rail, BL→TL, runs from TL.
    const rail = shot.rails[i]!;
    const points = threadEnds(key)[0] === PERCH_CORNERS[i] ? rail : [...rail].reverse();
    routes.set(key, Float32Array.from(points.flat()));
    adjacency.set(PERCH_CORNERS[i]!, [PERCH_RAILS[(i + 3) % 4]!, key]);
  });
  return polylineThreadField({ nodes, routes, adjacency, up: shot.perch.up, cell: shot.unit });
}

/** A space's field with the frame in it. */
export interface PerchedField extends ThreadField {
  /** Moves the frame — a resize, a knob — or takes it away (null): the same object, so a replay holding it sees the change. */
  setFrame(shot: PerchShot | null): void;
}

const smoothstep = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/**
 * `base` with the frame in it. Notes, threads, `around`, `nearby` and
 * `length` answer from whichever part owns the id or key. `nearby` and
 * `length` exist only when `base` has them: the grip planner then asks
 * `nearby` alone, and over a field without it the rails are found through the
 * perch node's `around`. Up is the frame's within UP_NEAR units of the perch
 * node, the space's past UP_FAR, and turns between them about the screen's
 * right, eased.
 */
export function withPerch(base: ThreadField, shot: PerchShot | null): PerchedField {
  let frame: PolylineField | null = null;
  let node: Vec3 = [0, 0, 0];
  let unit = 1;
  let frameUp: Vec3 = [0, 1, 0];
  let screenRight: Vec3 = [1, 0, 0];
  const owns = (key: ThreadKey) => PERCH_RAIL_SET.has(key);

  const field: PerchedField = {
    setFrame(s) {
      frame = s ? frameField(s) : null;
      if (!s) return;
      node = s.perch.node;
      unit = s.unit;
      frameUp = s.perch.up;
      screenRight = s.bezel.right;
    },
    has: (key) => (owns(key) ? !!frame && frame.has(key) : base.has(key)),
    point: (key, u, out) =>
      owns(key) ? !!frame && frame.point(key, u, out) : base.point(key, u, out),
    closest: (key, q, uMin, uMax) =>
      owns(key) ? (frame?.closest(key, q, uMin, uMax) ?? null) : base.closest(key, q, uMin, uMax),
    node: (id, out) => (isPerchId(id) ? !!frame && frame.node(id, out) : base.node(id, out)),
    around(ids, hops, max) {
      const mine = ids.filter(isPerchId);
      if (mine.length === 0 || !frame) return base.around(ids, hops, max);
      const out = frame.around(mine, hops, max);
      const theirs = ids.filter((id) => !isPerchId(id));
      if (theirs.length > 0 && out.length < max) {
        out.push(...base.around(theirs, hops, max - out.length));
      }
      return out;
    },
    up(p, out) {
      base.up(p, out);
      if (!frame) return;
      const d = Math.hypot(p[0] - node[0], p[1] - node[1], p[2] - node[2]) / unit;
      // `!(d < …)` is also true of NaN: the space's up, as far from the frame as can be.
      if (!(d < UP_FAR)) return;
      turnUp(frameUp, out, smoothstep((d - UP_NEAR) / (UP_FAR - UP_NEAR)), screenRight, out);
    },
  };
  if (base.length) {
    field.length = (key) => (owns(key) ? (frame?.length(key) ?? 0) : base.length!(key));
  }
  if (base.nearby) {
    field.nearby = (q, r, max) => {
      const theirs = base.nearby!(q, r, max);
      const mine = frame ? frame.nearby(q, r, max) : [];
      if (mine.length === 0) return theirs;
      if (theirs.length === 0) return mine;
      // Both near at once: the frame never sits among the notes, but answer nearest first all the same.
      const d2 = (key: ThreadKey) => field.closest(key, q)?.d2 ?? Infinity;
      return [...theirs, ...mine]
        .map((key) => ({ key, d: d2(key) }))
        .sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1))
        .slice(0, max)
        .map((c) => c.key);
    };
  }
  field.setFrame(shot);
  return field;
}

/**
 * Up `share` of the way from `a` (the frame's) to `b` (the space's), into
 * `out`: turned about `axis` — the screen's right — when both are square to
 * it, else about the axis square to both. Both unit length.
 */
function turnUp(a: Vec3, b: Vec3, share: number, axis: Vec3, out: Vec3): void {
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const cos = a[0] * bx + a[1] * by + a[2] * bz;
  // a × b
  const cx = a[1] * bz - a[2] * by;
  const cy = a[2] * bx - a[0] * bz;
  const cz = a[0] * by - a[1] * bx;
  const square = (v: Vec3) => Math.abs(v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]) < 1e-6;
  let n: Vec3;
  let angle: number;
  const sin = Math.hypot(cx, cy, cz);
  if (square(a) && square([bx, by, bz])) {
    n = axis;
    angle = Math.atan2(cx * axis[0] + cy * axis[1] + cz * axis[2], cos);
  } else if (sin > 1e-9) {
    n = [cx / sin, cy / sin, cz / sin];
    angle = Math.atan2(sin, cos);
  } else {
    // Along the same line: the same way needs no turn, the opposite one any axis square to it.
    n = axis;
    angle = cos > 0 ? 0 : Math.PI;
  }
  const t = angle * share;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * (1 - c);
  // Rodrigues: a turned by t about unit n.
  const x = a[0] * c + (n[1] * a[2] - n[2] * a[1]) * s + n[0] * k;
  const y = a[1] * c + (n[2] * a[0] - n[0] * a[2]) * s + n[1] * k;
  const z = a[2] * c + (n[0] * a[1] - n[1] * a[0]) * s + n[2] * k;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

export interface PerchOptions {
  /** The grip planner's reach on the frame, creature units: a thread's is 0.93. */
  reach?: number;
  /** How long the crossing from the frame to the crawl takes: seconds, or a pace for its length. */
  crossing?: number | CrossingPace | null;
  /** Seconds it holds still, letting go, before that crossing moves. */
  release?: number;
}

/**
 * The replay's perch for a shot: its node, its heading, the spot it sets out
 * from and lands on — `hover` below the body, where a walk floats the body
 * exactly where it clings — and the rails it may hold but never light.
 */
export function replayPerch(shot: PerchShot, opts: PerchOptions = {}): ReplayPerch {
  const { body, up, heading } = shot.perch;
  const h = HOVER * shot.unit;
  return {
    id: PERCH_ID,
    heading: [heading[0], heading[1], heading[2]],
    at: [body[0] - up[0] * h, body[1] - up[1] * h, body[2] - up[2] * h],
    keys: PERCH_RAIL_SET,
    ...(opts.reach !== undefined ? { grip: { reach: opts.reach } } : {}),
    crossing: opts.crossing ?? null,
    release: Math.max(0, opts.release ?? 0),
  };
}
