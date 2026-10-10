// The dormant network's threads as straight chords, one between each pair of
// neighbouring points of a thread's route: what the filaments and the tubes
// draw. Pure, so it is tested in Node.
//
// The chords are cut from the very route arrays the replay's ThreadField walks
// (polyline-field.ts), their ends copied point for point, and measured the way
// the field measures them. So the line on screen is the line the Sentinel's
// grips close on: a claw never bites beside the thread it holds.
//
// Each thread's chords lie together, in the order the routes come, and that
// order is the thread's index everywhere in the space — its texels in the
// state texture, its place in the tubes.

import type { ThreadKey } from '../../threads';

export interface RouteChords {
  /** Every drawable thread, in order: a thread's index is its place here. */
  keys: ThreadKey[];
  /** Per thread: its first chord. */
  first: Uint32Array;
  /** Per thread: how many chords it has. */
  count: Uint32Array;
  /** Per thread: its length along the route, world units, exactly as the field measures it. */
  lengths: Float32Array;
  /** Chords in all. */
  chords: number;
  /** Per chord: where it starts, xyz. */
  a: Float32Array;
  /** Per chord: where it ends, xyz. */
  b: Float32Array;
  /** Per chord: its thread's index. */
  thread: Float32Array;
  /** Per chord: how far along its thread it starts and ends, from the key's first note, world units. */
  s: Float32Array;
}

/**
 * Cuts each route into its chords. A route with fewer than two points, or a
 * point that is not a number, is left out, as the field leaves it out; a
 * chord of no length is skipped, since it draws nothing.
 */
export function routeChords(routes: ReadonlyMap<ThreadKey, Float32Array>): RouteChords {
  const keys: ThreadKey[] = [];
  const lists: Float32Array[] = [];
  let total = 0;
  for (const [key, points] of routes) {
    const n = Math.floor(points.length / 3);
    if (n < 2 || !points.every(Number.isFinite)) continue;
    keys.push(key);
    lists.push(points);
    total += n - 1;
  }

  const first = new Uint32Array(keys.length);
  const count = new Uint32Array(keys.length);
  const lengths = new Float32Array(keys.length);
  const a = new Float32Array(total * 3);
  const b = new Float32Array(total * 3);
  const thread = new Float32Array(total);
  const s = new Float32Array(total * 2);
  // One float32 slot to add in, as the field adds its arc lengths up: the
  // same sums, rounded the same way.
  const arc = new Float32Array(1);
  let c = 0;
  lists.forEach((p, t) => {
    first[t] = c;
    arc[0] = 0;
    for (let i = 0; i + 1 < p.length / 3; i++) {
      const o = i * 3;
      const l = Math.hypot(p[o + 3]! - p[o]!, p[o + 4]! - p[o + 1]!, p[o + 5]! - p[o + 2]!);
      const s0: number = arc[0]!;
      arc[0] = s0 + l;
      if (!(l > 0)) continue;
      a[c * 3] = p[o]!;
      a[c * 3 + 1] = p[o + 1]!;
      a[c * 3 + 2] = p[o + 2]!;
      b[c * 3] = p[o + 3]!;
      b[c * 3 + 1] = p[o + 4]!;
      b[c * 3 + 2] = p[o + 5]!;
      thread[c] = t;
      s[c * 2] = s0;
      s[c * 2 + 1] = arc[0]!;
      c++;
    }
    count[t] = c - first[t]!;
    lengths[t] = arc[0]!;
  });
  return {
    keys,
    first,
    count,
    lengths,
    chords: c,
    a: c === total ? a : a.slice(0, c * 3),
    b: c === total ? b : b.slice(0, c * 3),
    thread: c === total ? thread : thread.slice(0, c),
    s: c === total ? s : s.slice(0, c * 2),
  };
}
