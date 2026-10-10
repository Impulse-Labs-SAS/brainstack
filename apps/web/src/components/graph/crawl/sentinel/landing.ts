// Where a claw lands on a thread that has a body — the frame round the prompt —
// pure, so it is tested without a creature.
//
// A plain thread is a line, and a claw holds the point the grip planner picked
// on it. A thread with a body is held on its surface: the claw rests a little
// out from it (`clawClearance`), on the side it reaches the thread from.
// Pinned on the centreline instead, every claw sits inside the bar and its
// talons come out of the bar's front face.
//
// The side is above, along the field's up. Every grip reaches down onto its
// thread — the planner's natural spots lie below the body, which floats over
// its threads along up — and at the frame the field's up is the perch's. So
// at the prompt's lean the claws take the top rail on its top face, hooking
// over its front edge; the bottom rail on its inner face, the bar's upper edge,
// in the room perch-geometry keeps between the bar and the box for them; and
// the side rails from behind, where up less the rail's own way is the perch's
// lean back from the viewer. Where up runs nearly along the thread — the side
// rails as the lean nears upright — it turns toward the claw's own socket, so
// the landing moves on continuously instead of being undefined.
//
// Stateless: the hold, the field and the body's pose decide it, so the same
// view gives the same pose, and at rest, up and the hold still, it does not
// move. Landed on the side its own arm comes from instead, the landing would
// move the arm and the arm the landing — a loop that needs state to settle —
// and every claw would come at the bar from behind, hidden by it.

import type { ThreadField, ThreadKey, ThreadSolid } from '../threads';
import type { Vec3 } from '../vec';

import type { Rig } from './rig';

/**
 * A claw rests this share of a claw finger further out than its tip's radius:
 * shut, a claw reaches further past the tip than the frame's bar is thick, and
 * held at the tip's radius alone its talons dip into the bar and come out of
 * its face again.
 */
const CLAW_CLEAR = 0.2;

/** How far out from a body tentacle `i`'s claw rests, world units: its tip's radius, and the claw's room. */
export function clawClearance(rig: Rig, i: number): number {
  const tip = rig.segRadius[rig.segStart[i]! + rig.segments[i]! - 1]!;
  return tip + CLAW_CLEAR * rig.clawLength[i]!;
}

/** How far along a thread its pace is read, either side, as a share of it. */
const TANGENT_STEP = 1e-3;
/**
 * Up's part square to the thread — the sine of the angle between them — below
 * which the landing turns toward the socket, eased, all the way by the second:
 * from 11.5° off the thread's own way to along it. The perch's lean puts up
 * 90° less the lean off a side rail, so at the prompt's 75° the side claws
 * land from above as every other does, and they turn only past 78.5°.
 */
const UP_ALONG_FROM = 0.2;
const UP_ALONG_TO = 0;
/** Steps the march back to the surface may take, and how close it must get, as a share of `across`. */
const MARCH_STEPS = 24;
const MARCH_CLOSE = 1e-4;

/** Scratch: called a few times a frame, it allocates nothing. */
const n: Vec3 = [0, 0, 0];
const a: Vec3 = [0, 0, 0];
const b: Vec3 = [0, 0, 0];
const t: Vec3 = [0, 0, 0];
const w: Vec3 = [0, 0, 0];

/**
 * The chord of `key` from `u − half` to `u + half`, kept within the thread,
 * into `t`; the share of the thread it spans, or 0 when the thread is gone.
 */
function chord(field: ThreadField, key: ThreadKey, u: number, half: number): number {
  const hi = Math.min(1, u + half);
  const lo = Math.max(0, u - half);
  if (!field.point(key, hi, a) || !field.point(key, lo, b)) return 0;
  t[0] = a[0] - b[0];
  t[1] = a[1] - b[1];
  t[2] = a[2] - b[2];
  return hi - lo;
}

/**
 * Where a claw holding `key` at `u` rests when that point of the thread lies
 * in `solid`, or within `clearance` of it: on its surface, `clearance` out
 * along its normal, on the side it is reached from — above along the field's
 * up, turned toward `socket` where up runs along the thread. `out` holds
 * field.point(key, u) on entry and the landing on return. False, `out`
 * untouched, when the point lies further out than that: that thread has no
 * body there. Within the clearance, not only inside: a thread on the body's
 * very face — the frame's rails with `railForward` at ±1 — lies at a distance
 * of nought give or take rounding, and a claw would land or not by the
 * rounding, a whole clearance apart from one hold to the next.
 */
export function landOnSolid(
  field: ThreadField,
  solid: ThreadSolid,
  key: ThreadKey,
  u: number,
  socket: Vec3,
  clearance: number,
  out: Vec3,
): boolean {
  const cx = out[0];
  const cy = out[1];
  const cz = out[2];
  const dc = solid.distance(cx, cy, cz, n);
  // `!(… < …)` is also true of NaN: no body to land on.
  if (!(dc < clearance)) return false;
  const ncx = n[0];
  const ncy = n[1];
  const ncz = n[2];

  // The thread's way here, to take out of every direction: the claw lands
  // across the thread, never along it. Read over a section's width of it,
  // not at the point: a thread drawn as a polyline — the frame's corners are
  // arcs of a few chords — turns in steps at its vertices, and where up runs
  // nearly along it, each step would swing the landing round the section. A
  // chord moves on continuously as `u` does, and along an arc it is the arc's
  // own way at its middle.
  let tx = 0;
  let ty = 0;
  let tz = 0;
  const span = chord(field, key, u, TANGENT_STEP);
  if (span > 0) {
    // World units of thread per share of it, here: a section's width in shares.
    const speed = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]) / span;
    const half = solid.across / 2 / speed;
    if (half > TANGENT_STEP && Number.isFinite(half)) chord(field, key, u, Math.min(0.5, half));
    const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
    if (tl > 1e-12) {
      tx = t[0] / tl;
      ty = t[1] / tl;
      tz = t[2] / tl;
    }
  }

  // Up, square to the thread; and the way to the socket, square to it too.
  field.up(out, w);
  let k = w[0] * tx + w[1] * ty + w[2] * tz;
  const wx = w[0] - tx * k;
  const wy = w[1] - ty * k;
  const wz = w[2] - tz * k;
  const g = Math.sqrt(wx * wx + wy * wy + wz * wz);
  let sx = socket[0] - cx;
  let sy = socket[1] - cy;
  let sz = socket[2] - cz;
  k = sx * tx + sy * ty + sz * tz;
  sx -= tx * k;
  sy -= ty * k;
  sz -= tz * k;
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sl > 1e-12) {
    sx /= sl;
    sy /= sl;
    sz /= sl;
  } else sx = sy = sz = 0;
  // Turned from up's way toward the socket's at an even pace, along the arc
  // between them: up's part is short there, and the socket's way added to it
  // would take nearly the whole turn in the first degree of lean, the claw
  // sliding round the bar's corner at once.
  const f = Math.max(0, Math.min(1, (UP_ALONG_FROM - g) / (UP_ALONG_FROM - UP_ALONG_TO)));
  const toward = f * f * (3 - 2 * f);
  let dx = sx;
  let dy = sy;
  let dz = sz;
  if (g > 1e-12) {
    const ux = wx / g;
    const uy = wy / g;
    const uz = wz / g;
    const cos = Math.max(-1, Math.min(1, ux * sx + uy * sy + uz * sz));
    const turn = Math.acos(cos);
    const sin = Math.sin(turn);
    // No socket, or one straight along up or against it: no arc to turn along, so up's way.
    const arc = sl > 1e-12 && sin > 1e-6;
    const p = arc ? Math.sin((1 - toward) * turn) / sin : 1;
    const q = arc ? Math.sin(toward * turn) / sin : 0;
    dx = ux * p + sx * q;
    dy = uy * p + sy * q;
    dz = uz * p + sz * q;
  }
  let dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dl > 1e-9)) {
    // Up along the thread and the socket on it: the nearest way out, across the thread.
    k = ncx * tx + ncy * ty + ncz * tz;
    dx = ncx - tx * k;
    dy = ncy - ty * k;
    dz = ncz - tz * k;
    dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  }
  dx /= dl;
  dy /= dl;
  dz /= dl;

  // From a section's width out along that way — outside whatever the section
  // is — march back toward the thread by the distance itself: a step that
  // long never crosses the surface, so it stops on the side it came from.
  const across = solid.across;
  let px = cx + dx * across;
  let py = cy + dy * across;
  let pz = cz + dz * across;
  let d = solid.distance(px, py, pz, n);
  if (!(d > 0)) {
    // Still inside, which no section `across` wide allows: the nearest surface
    // point (the point itself, give or take, where it lies on the surface).
    px = cx - ncx * dc;
    py = cy - ncy * dc;
    pz = cz - ncz * dc;
    d = solid.distance(px, py, pz, n);
  } else {
    for (let step = 0; step < MARCH_STEPS && d >= MARCH_CLOSE * across; step++) {
      px -= dx * d;
      py -= dy * d;
      pz -= dz * d;
      d = solid.distance(px, py, pz, n);
    }
  }
  // Whatever of the march is left, `d` out along the normal there, and the clearance on top.
  out[0] = px + n[0] * (clearance - d);
  out[1] = py + n[1] * (clearance - d);
  out[2] = pz + n[2] * (clearance - d);
  return true;
}
