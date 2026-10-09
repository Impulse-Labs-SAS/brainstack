// The Sentinel's body: where it floats and which way it faces, frame by frame.
//
// The replay's cursor is the authority: it says how far along the walk the
// crawl is, and it starts, cruises and stops on its own profile. The body only
// follows it — on a critically damped spring, stepped exactly so any frame
// length is stable — floating above the threads along the field's up, and
// gliding over a gap rather than sagging into it the way silk did.
//
// A spring lags a moving target, so the target is led by the cursor's own
// planned speed (feed-forward), and the lead fades as the note comes near: led
// by its own velocity instead, the spring's damping cancels and it rings (the
// review's M2), and led at full speed to the end it overshoots the note.
//
// The heading turns on its own spring; up is carried along with it and slowly
// rights itself, so a thread that goes straight up never flips the body over.
// A goal heading far round behind it is held to 60° about up from its own at
// a time, so a walk that doubles back turns round on its feet instead of
// pitching over the top. It banks into turns and leans with its acceleration,
// both bounded.

import { legPoint } from '../threads';
import type { ReplayView } from '../replay-view';
import { cross, dist, dot, finite, UP, type Vec3 } from '../vec';

export interface BodyParams {
  /** Creature units above the threads it walks. */
  hover: number;
  /** Position spring, s⁻¹. */
  omegaPos: number;
  /** Heading spring, s⁻¹. */
  omegaTurn: number;
  /** Radians, either way. */
  bankLimit: number;
  /** Hand-over-hand surge between grip landings, creature units. */
  surge: number;
  /** Most the target may be led ahead of the cursor, creature units. */
  leadMax: number;
  /** Perched while it reads: this far above the note, and this far behind it, creature units. */
  perchUp: number;
  perchBack: number;
  /** How high it glides over the middle of a gap, creature units. */
  voidLift: number;
}

export interface BodyState {
  /** World position and velocity of the spring. */
  p: Vec3;
  v: Vec3;
  /** Smoothed acceleration, for bank and lean. */
  acc: Vec3;
  /** Heading frame: forward, up, right = up × forward. */
  f: Vec3;
  u: Vec3;
  s: Vec3;
  bank: number;
  lean: number;
  /** The last finite target. */
  goal: Vec3;
  ready: boolean;
  /** The replay cursor seen last frame, and its speed in world units per second. */
  cursor: number;
  cursorStep: number;
  cursorWalking: boolean;
  speed: number;
}

export function createBody(): BodyState {
  return {
    p: [0, 0, 0],
    v: [0, 0, 0],
    acc: [0, 0, 0],
    f: [0, 0, 1],
    u: [0, 1, 0],
    s: [1, 0, 0],
    bank: 0,
    lean: 0,
    goal: [0, 0, 0],
    ready: false,
    cursor: 0,
    cursorStep: -1,
    cursorWalking: false,
    speed: 0,
  };
}

/**
 * One exact step of a critically damped spring toward a fixed target: the
 * closed-form solution over `dt`, so it is stable and never overshoots a
 * target that holds still, whatever the frame length.
 */
export function springStep(x: Vec3, v: Vec3, target: Vec3, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt);
  for (let i = 0; i < 3; i++) {
    const d = x[i]! - target[i]!;
    const k = (v[i]! + omega * d) * dt;
    v[i] = (v[i]! - omega * k) * e;
    x[i] = target[i]! + (d + k) * e;
  }
}

/** The same step on one number; writes [x, v] into `out`. */
export function springScalar(
  x: number,
  v: number,
  target: number,
  omega: number,
  dt: number,
  out: [number, number],
): void {
  const e = Math.exp(-omega * dt);
  const d = x - target;
  const k = (v + omega * d) * dt;
  out[1] = (v - omega * k) * e;
  out[0] = target + (d + k) * e;
}

const set = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
const copy = (o: Vec3, a: Vec3): Vec3 => set(o, a[0], a[1], a[2]);
const normalizeInto = (o: Vec3, a: Vec3): boolean => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 1e-9)) return false;
  set(o, a[0] / l, a[1] / l, a[2] / l);
  return true;
};

/** Rotate unit vector `v` toward unit vector `to` by `k` of the angle between them, in place. */
export function turnToward(v: Vec3, to: Vec3, k: number, fallbackAxis: Vec3): void {
  const c = Math.max(-1, Math.min(1, dot(v, to)));
  const angle = Math.acos(c) * k;
  if (angle < 1e-7) return;
  let axis = cross(v, to);
  if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) axis = fallbackAxis;
  const a: Vec3 = [0, 0, 0];
  if (!normalizeInto(a, axis)) return;
  // Rodrigues, with v ⊥ axis up to rounding.
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const ad = dot(a, v);
  const ax = cross(a, v);
  const r: Vec3 = [
    v[0] * cs + ax[0] * sn + a[0] * ad * (1 - cs),
    v[1] * cs + ax[1] * sn + a[1] * ad * (1 - cs),
    v[2] * cs + ax[2] * sn + a[2] * ad * (1 - cs),
  ];
  normalizeInto(v, r);
}

/** Steepest the body points its nose along a thread, radians. */
const MAX_ELEVATION = (35 * Math.PI) / 180;
/** A thread this close to vertical has no heading of its own: the body keeps its own. */
const VERTICAL = Math.sin((10 * Math.PI) / 180);

/**
 * The heading to face along a tangent: its climb clamped to ±35°, and the
 * current heading's yaw kept when the tangent is within 10° of `up`.
 */
export function headingFrom(tangent: Vec3, up: Vec3, current: Vec3, out: Vec3): Vec3 {
  const pick = (t: Vec3): boolean => {
    const tv = dot(t, up);
    const hx = t[0] - up[0] * tv;
    const hy = t[1] - up[1] * tv;
    const hz = t[2] - up[2] * tv;
    const hl = Math.hypot(hx, hy, hz);
    if (!(hl > VERTICAL)) return false;
    const el = Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, Math.atan2(tv, hl)));
    const c = Math.cos(el) / hl;
    const s = Math.sin(el);
    set(out, hx * c + up[0] * s, hy * c + up[1] * s, hz * c + up[2] * s);
    return true;
  };
  if (finite(tangent) && pick(tangent)) return out;
  if (pick(current)) return out;
  // Facing straight up or down with nothing to go on: any horizontal will do.
  const side = Math.abs(up[2]) < 0.9 ? ([0, 0, 1] as Vec3) : ([1, 0, 0] as Vec3);
  return pick(side) ? out : set(out, 0, 0, 1);
}

/** The most a goal heading may turn round about up from the body's own, radians: 60°. */
const YAW_MOST = Math.PI / 3;

/**
 * `heading`, in place, turned back toward `f` about unit `up` until it is at
 * most `max` radians round from it, its climb kept. Exactly behind, the
 * rounding picks a side, and the frames after keep to it because the held
 * heading is then never behind. A heading with no level way of its own —
 * within 10° of up, which `headingFrom` ignores anyway — or an `f` with none,
 * or anything not finite, is left as it is.
 */
export function yawAtMost(heading: Vec3, f: Vec3, up: Vec3, max: number): void {
  const eh = dot(heading, up);
  const ef = dot(f, up);
  const hx = heading[0] - up[0] * eh;
  const hy = heading[1] - up[1] * eh;
  const hz = heading[2] - up[2] * eh;
  let gx = f[0] - up[0] * ef;
  let gy = f[1] - up[1] * ef;
  let gz = f[2] - up[2] * ef;
  const lh = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const lg = Math.sqrt(gx * gx + gy * gy + gz * gz);
  const hl = Math.sqrt(dot(heading, heading));
  // `!(… > …)` is also true of NaN.
  if (!(lh > VERTICAL * hl) || !(lg > 1e-6)) return;
  // Signed about up, from the body's level way to the goal's.
  const sin =
    up[0] * (gy * hz - gz * hy) + up[1] * (gz * hx - gx * hz) + up[2] * (gx * hy - gy * hx);
  const yaw = Math.atan2(sin, gx * hx + gy * hy + gz * hz);
  if (!(Math.abs(yaw) > max)) return;
  gx /= lg;
  gy /= lg;
  gz /= lg;
  // The body's level way turned `max` toward the goal's: g·cos + (up × g)·sin, as g ⊥ up.
  const turn = yaw < 0 ? -max : max;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  set(
    heading,
    (gx * c + (up[1] * gz - up[2] * gy) * s) * lh + up[0] * eh,
    (gy * c + (up[2] * gx - up[0] * gz) * s) * lh + up[1] * eh,
    (gz * c + (up[0] * gy - up[1] * gx) * s) * lh + up[2] * eh,
  );
}

/** Put the body at `p`, at rest, facing `forward` (any steepness), upright on `up`. */
export function snapBody(b: BodyState, p: Vec3, forward: Vec3, up: Vec3): void {
  copy(b.p, p);
  copy(b.goal, p);
  set(b.v, 0, 0, 0);
  set(b.acc, 0, 0, 0);
  headingFrom(forward, up, b.f, b.f);
  frameFrom(b, up);
  b.bank = 0;
  b.lean = 0;
  b.ready = true;
}

/** Up made perpendicular to the heading, and right from both. */
function frameFrom(b: BodyState, up: Vec3): void {
  const k = dot(up, b.f);
  if (!normalizeInto(b.u, [up[0] - b.f[0] * k, up[1] - b.f[1] * k, up[2] - b.f[2] * k])) {
    copy(b.u, UP);
  }
  normalizeInto(b.s, cross(b.u, b.f));
  copy(b.u, cross(b.f, b.s));
}

/** Where the body is headed this frame, and how. */
export interface BodyGoal {
  /** World point to float at. */
  p: Vec3;
  /** The way to face: a path tangent, or the walk's heading while perched. */
  heading: Vec3;
  /** Up at that point, from the field. */
  up: Vec3;
  /** Multiplies the heading spring: slower while it turns to scan before moving. */
  turn: number;
  /** The note it perches over, when dwelling: the eye looks at it. */
  perch: boolean;
}

export function createGoal(): BodyGoal {
  return { p: [0, 0, 0], heading: [0, 0, 1], up: [0, 1, 0], turn: 1, perch: false };
}

/**
 * Follow the replay's cursor: its speed, in world units per real second, from
 * how far it moved since the last frame. Zero while paused, and on the frame a
 * new leg starts, so nothing is led past where the replay is.
 */
export function trackCursor(b: BodyState, view: ReplayView, dt: number): void {
  const walk = view.mode === 'walk' ? view.walk : null;
  const travelled = walk ? walk.travelled : 0;
  if (walk && b.cursorWalking && b.cursorStep === view.stepIndex && dt > 0) {
    b.speed = Math.max(0, (travelled - b.cursor) / dt);
  } else b.speed = 0;
  b.cursor = travelled;
  b.cursorStep = view.stepIndex;
  b.cursorWalking = !!walk;
}

/**
 * The hand-over-hand surge: the fraction of the way from the last grip landing
 * to the next, as a gentle sine — zero at every landing and wherever no
 * landing is planned, so it never moves an arrival.
 */
export function surgePhase(view: ReplayView): number {
  const clock = view.clock;
  let prev = -Infinity;
  let next = Infinity;
  for (const h of view.holds) if (h && h.since <= clock && h.since > prev) prev = h.since;
  for (const sw of view.swings) {
    if (sw.land <= clock) prev = Math.max(prev, sw.land);
    else next = Math.min(next, sw.land);
  }
  if (!Number.isFinite(prev) || !Number.isFinite(next) || next - prev < 1e-6) return 0;
  return Math.sin(2 * Math.PI * ((clock - prev) / (next - prev)));
}

/** Perched while it reads: above and behind the note, so the eye looks at it instead of covering it. */
function perchAt(view: ReplayView, b: BodyState, params: BodyParams, out: BodyGoal): boolean {
  const unit = view.unit;
  const note: Vec3 = [0, 0, 0];
  if (!view.hereId || !view.field.node(view.hereId, note)) return false;
  view.field.up(note, out.up);
  const f: Vec3 = [0, 0, 0];
  headingFrom(view.dir, out.up, b.f, f);
  // Back off along the heading's level part, so a steep arrival does not perch underneath.
  const k = dot(f, out.up);
  const level: Vec3 = [f[0] - out.up[0] * k, f[1] - out.up[1] * k, f[2] - out.up[2] * k];
  if (!normalizeInto(level, level)) copy(level, f);
  for (let i = 0; i < 3; i++) {
    out.p[i] = note[i]! + out.up[i]! * params.perchUp * unit - level[i]! * params.perchBack * unit;
  }
  copy(out.heading, f);
  out.perch = true;
  out.turn = 1;
  return true;
}

/**
 * Where the body should be this frame. Walking, it is the point the cursor
 * has reached — surged, and led by the cursor's speed until the note is
 * near — floated `hover` above the thread; across a gap the line bows up
 * instead of sagging. Otherwise it perches over the note it stands on.
 * False when the notes it needs are gone: keep the last goal.
 */
export function bodyGoal(
  view: ReplayView,
  b: BodyState,
  params: BodyParams,
  out: BodyGoal,
): boolean {
  const walk = view.mode === 'walk' ? view.walk : null;
  if (!walk || walk.segments.length === 0) return perchAt(view, b, params, out);
  const unit = view.unit;
  const s = Math.min(walk.travelled, walk.total);
  const remaining = walk.total - s;
  const env = Math.max(0, Math.min(1, s / unit, remaining / unit));
  const surged = s + params.surge * unit * surgePhase(view) * env;
  // Feed-forward: a critically damped spring trails a steady target by 2v/ω.
  // Faded with the distance left, so the target never runs past the note and
  // the body slows into it instead of arriving at full speed.
  const lead = Math.min(
    params.leadMax * unit,
    (2 * b.speed) / params.omegaPos,
    Math.max(0, remaining),
  );
  const sag = -params.voidLift * unit;
  if (!legPoint(walk.segments, surged + lead, view.field, sag, out.p)) return false;
  view.field.up(out.p, out.up);
  const tangent: Vec3 = [0, 0, 0];
  const ahead: Vec3 = [0, 0, 0];
  copy(tangent, view.dir);
  legPoint(
    walk.segments,
    Math.min(walk.total, surged + 0.6 * unit),
    view.field,
    sag,
    ahead,
    tangent,
  );
  copy(out.heading, tangent);
  for (let i = 0; i < 3; i++) out.p[i] = out.p[i]! + out.up[i]! * params.hover * unit;
  out.perch = false;
  out.turn = 1;
  return true;
}

/** How far the body may lean with its acceleration, radians. */
const LEAN_LIMIT = 0.15;

/**
 * Advance the body one frame toward `goal`. Snaps instead — returning true —
 * on the first frame, under reduced motion (geometry, not animation), and
 * when the goal jumps more than 3 units (a replay, a rebuilt graph); a
 * non-finite goal keeps the last finite one.
 */
export function stepBody(
  b: BodyState,
  goal: BodyGoal,
  unit: number,
  dt: number,
  params: BodyParams,
  still: boolean,
): boolean {
  const target: Vec3 = finite(goal.p) ? goal.p : b.goal;
  const up: Vec3 = finite(goal.up) ? goal.up : UP;
  if (!b.ready || still || dist(target, b.goal) > 3 * unit) {
    snapBody(b, target, finite(goal.heading) ? goal.heading : b.f, up);
    return true;
  }
  copy(b.goal, target);
  if (!(dt > 0)) return false;

  const vx = b.v[0];
  const vy = b.v[1];
  const vz = b.v[2];
  springStep(b.p, b.v, target, params.omegaPos, dt);
  const ka = 1 - Math.exp(-dt * 20);
  b.acc[0] += ((b.v[0] - vx) / dt - b.acc[0]) * ka;
  b.acc[1] += ((b.v[1] - vy) / dt - b.acc[1]) * ka;
  b.acc[2] += ((b.v[2] - vz) / dt - b.acc[2]) * ka;

  // A walk that turns straight back wants the shortest turn, and with any
  // climb in it that is a pitch over the top: a somersault. Held to 60° about
  // up at a time, the body turns round on its feet instead. The brain had the
  // same latent flip; a turn about to snap, or under reduced motion, never
  // gets here.
  const aim: Vec3 = [goal.heading[0], goal.heading[1], goal.heading[2]];
  yawAtMost(aim, b.f, up, YAW_MOST);
  const want: Vec3 = [0, 0, 0];
  headingFrom(aim, up, b.f, want);
  turnToward(b.f, want, 1 - Math.exp(-params.omegaTurn * goal.turn * dt), b.u);

  // Up is carried along with the heading, then rights itself toward the field's up.
  const k = dot(b.u, b.f);
  if (!normalizeInto(b.u, [b.u[0] - b.f[0] * k, b.u[1] - b.f[1] * k, b.u[2] - b.f[2] * k])) {
    copy(b.u, up);
  }
  const ku = dot(up, b.f);
  const upright: Vec3 = [up[0] - b.f[0] * ku, up[1] - b.f[1] * ku, up[2] - b.f[2] * ku];
  if (normalizeInto(upright, upright)) turnToward(b.u, upright, 1 - Math.exp(-3 * dt), b.f);
  frameFrom(b, b.u);

  const kb = 1 - Math.exp(-8 * dt);
  const bankGoal = Math.max(
    -params.bankLimit,
    Math.min(params.bankLimit, (0.035 * dot(b.acc, b.s)) / unit),
  );
  const leanGoal = Math.max(-LEAN_LIMIT, Math.min(LEAN_LIMIT, (-0.02 * dot(b.acc, b.f)) / unit));
  b.bank += (bankGoal - b.bank) * kb;
  b.lean += (leanGoal - b.lean) * kb;
  return false;
}

/**
 * The hull's axes: the heading frame leaned about right (positive lifts the
 * nose) and banked about forward (positive tips up toward right, into a turn
 * to the right). Columns x = right, y = up, z = forward.
 */
export function hullAxes(b: BodyState, s: Vec3, u: Vec3, f: Vec3): void {
  const cl = Math.cos(b.lean);
  const sl = Math.sin(b.lean);
  const cb = Math.cos(b.bank);
  const sb = Math.sin(b.bank);
  for (let i = 0; i < 3; i++) {
    const fi = b.f[i]! * cl + b.u[i]! * sl;
    const ui = b.u[i]! * cl - b.f[i]! * sl;
    f[i] = fi;
    u[i] = ui * cb + b.s[i]! * sb;
    s[i] = b.s[i]! * cb - ui * sb;
  }
}
