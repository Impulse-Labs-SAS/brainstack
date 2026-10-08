// The tentacles as chains of rigid segments, solved by position-based dynamics
// on the CPU: Verlet integration plus constraints, on flat Float32Arrays, in
// world units.
//
// A shader could wave tentacles for free, but it cannot pin a claw to a thread
// that moves with the layout, and nothing it computes can be tested. PBD can:
// the root rides its socket, a gripping tip is pinned where the replay says
// it holds, and the lag behind the body — the thing that makes them read as
// heavy — emerges from inertia and per-tentacle drag instead of being scripted.
//
// Choices, and why:
// - A fixed step of 1/120 s with an accumulator: Verlet reads velocity from
//   the last two positions, so a step that changes length from frame to frame
//   mis-scales it and jitters. Steps the frame cannot afford are dropped, and
//   the root is interpolated between the frame's two body poses so a long
//   frame never teleports it. Each step meets the root at the moment it
//   simulates, and what is drawn is carried on to the frame's own moment: on
//   a 144 Hz screen one frame in six takes no step at all, and must not show it.
// - The rest shape pulls each joint toward the one before it plus its
//   segment's rest direction — an angular spring — never toward a fixed
//   point, which would squeeze the chain into a zigzag wherever the two
//   disagree. A tentacle with a target rests on an arc that ends on it.
// - Soft joint cones (half the violation per pass), that reshape without
//   pushing: hard root, hard tip and hard cones over-constrain the chain and
//   it shivers, and a limit that kicks keeps a free arm swinging.
// - A pinned arm is finished by FABRIK both ways, within its cones: weighted
//   passes with both ends fixed converge too slowly to hold a claw on a thread.
// - The drawn chain is rebuilt from the root with every segment at exactly its
//   length, along the solved directions: rigid parts drawn with gaps or
//   overlaps read as rubber. What error is left lands at the claw, and any
//   bend the soft cones let through is clamped there.
//
// The rendered frame of each segment is carried along the arm by double
// reflection (Wang et al. 2008, a rotation-minimising frame), so the twist the
// vertebrae show is only the twist the rig gives them, never a spin from how
// the arm happens to bend.

import type { Vec3 } from '../vec';

import { CLAW_FINGERS, HULL, TENTACLES } from './anatomy';
import type { SentinelPose } from './pose';
import type { Rig } from './rig';

/** Where the body is and how it is turned: world position and its right, up and forward axes. */
export interface BodyPose {
  p: Vec3;
  s: Vec3;
  u: Vec3;
  f: Vec3;
}

export function createBodyPose(): BodyPose {
  return { p: [0, 0, 0], s: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1] };
}

export function copyBodyPose(from: BodyPose, to: BodyPose): void {
  for (let i = 0; i < 3; i++) {
    to.p[i] = from.p[i]!;
    to.s[i] = from.s[i]!;
    to.u[i] = from.u[i]!;
    to.f[i] = from.f[i]!;
  }
}

/** What a tentacle's tip does: nothing (it rests and sways), follows a target loosely, or is pinned to it. */
export const TIP_FREE = 0;
export const TIP_SOFT = 1;
export const TIP_PINNED = 2;

/** Length of a vector: Math.hypot is several times slower in the hot loops. */
function mag(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Seconds per physics step. */
export const CHAIN_STEP = 1 / 120;
/**
 * Most steps a frame takes, at every tier: real time down to 30 fps. A tier
 * that took fewer would not save its frames, only slow its tentacles down on
 * the machines already slow; tiers save on iterations and segments instead.
 */
export const CHAIN_MAX_STEPS = 4;

/** Telescoping moves in clicks of this much stretch, so it reads as mechanical. */
const RATCHET = 0.04;
/** Most an aimed arc turns, either side of its chord: a tentacle far longer than its reach coils no tighter. */
const MAX_ARC_HALF = 0.8 * Math.PI;
/** Soft targets pull at least this hard while relaxing. */
const RELAX_GAIN = 0.3;
/** The drawn chain clamps any bend this far past its cone: the solver's soft cones steer, this guarantees. */
const DRAWN_SLACK = 1.2;
/** A socket swings this many times as far as a joint along the arm bends. */
const ROOT_SWING = 2.5;
/** Fraction of a cone violation corrected per pass. */
const CONE_STIFFNESS = 0.5;
/** Most a joint may move in one step, in creature units: a guard against a wild frame, not a speed limit. */
const MAX_STEP_MOVE = 0.25;
/** A tentacle reaches for a target 0.9 of its length away before it starts to telescope. */
const REACH_BEFORE_STRETCH = 0.9;

export interface ChainSettings {
  /** Constraint passes per step. */
  iterations: number;
  /** Steps a frame may run; the rest of a long frame is dropped. */
  maxSteps: number;
  /** Push joints out of the hull. */
  collide: boolean;
  /** Scales how firmly every tentacle returns to its rest shape. */
  restStiffness: number;
  /** Scales the joint cone, θmax = clamp(560°/M, 18°, 45°). */
  coneScale: number;
  /** Scales every tentacle's drag time. */
  dragScale: number;
  /** Scale the travelling wave: 0 holds every tentacle at its rest shape. */
  waveAmplitude: number;
  waveFrequency: number;
  waveLength: number;
  /** Scales how far any tentacle may telescope. */
  maxStretchScale: number;
  /** Scales the kick, roll and stiffening of a tentacle letting go. */
  recoil: number;
}

/** Inputs to one frame of the chains. */
export interface ChainDrive {
  /** The body at the start and the end of the frame: roots are interpolated between them. */
  body0: BodyPose;
  body1: BodyPose;
  /** Seconds, at the end of the frame: the wave's clock. */
  time: number;
  dt: number;
  /** Per tentacle: TIP_FREE, TIP_SOFT or TIP_PINNED. */
  mode: Uint8Array;
  /** Per tentacle, world xyz. */
  target: Float32Array;
  /** Per tentacle, for TIP_SOFT: the fraction of the way to its target the tip moves per pass. */
  gain: Float32Array;
}

export interface ChainState {
  /** Per joint, world xyz: positions now and a step ago (Verlet). */
  x: Float32Array;
  xp: Float32Array;
  /** Per joint, world xyz: what is drawn, every segment exactly its length. */
  xr: Float32Array;
  /** Per segment (at its root joint's index), world xyz: where its end rests from its root, wave included. */
  rest: Float32Array;
  /** Per tentacle: telescoping, its spring's velocity, and the click it is heading for. */
  stretch: Float32Array;
  stretchV: Float32Array;
  stretchGoal: Float32Array;
  /** Per tentacle, eased 0–1: how much it holds on — the wave dies near a grip. */
  grip: Float32Array;
  /** Per tentacle, eased 0–1: how much its rest shape bends toward its target. */
  aim: Float32Array;
  /** Per tentacle: whether its tip was pinned last frame. */
  held: Uint8Array;
  /** Per tentacle: seconds since it let go (large when it has not). */
  recoil: Float32Array;
  /** Per tentacle: claw closure, 0 open – 1 biting. */
  closure: Float32Array;
  /** Per tentacle, set by the caller: glow 0–1 and how far it has travelled up from the tip, 0–1. */
  glow: Float32Array;
  glowFront: Float32Array;
  /** Per tentacle, world: the root, and its socket's axis and normal, at the frame's end. */
  root: Float32Array;
  axis: Float32Array;
  normal: Float32Array;
  /** Seconds not yet stepped. */
  acc: number;
}

const NO_RECOIL = 1e3;

export function createChain(rig: Rig): ChainState {
  const T = rig.tentacles;
  return {
    x: new Float32Array(rig.joints * 3),
    xp: new Float32Array(rig.joints * 3),
    xr: new Float32Array(rig.joints * 3),
    rest: new Float32Array(rig.joints * 3),
    stretch: new Float32Array(T).fill(1),
    stretchV: new Float32Array(T),
    stretchGoal: new Float32Array(T).fill(1),
    grip: new Float32Array(T),
    aim: new Float32Array(T),
    held: new Uint8Array(T),
    recoil: new Float32Array(T).fill(NO_RECOIL),
    closure: new Float32Array(T),
    glow: new Float32Array(T),
    glowFront: new Float32Array(T),
    root: new Float32Array(T * 3),
    axis: new Float32Array(T * 3),
    normal: new Float32Array(T * 3),
    acc: 0,
  };
}

/** θmax for a tentacle cut into `segments`, in radians. */
export function coneLimit(segments: number, scale = 1): number {
  const deg = Math.max(18, Math.min(45, 560 / Math.max(1, segments))) * scale;
  return (Math.min(170, deg) * Math.PI) / 180;
}

const scratchPose = createBodyPose();

function lerpPose(a: BodyPose, b: BodyPose, t: number, out: BodyPose): void {
  for (let i = 0; i < 3; i++) {
    out.p[i] = a.p[i]! + (b.p[i]! - a.p[i]!) * t;
    out.u[i] = a.u[i]! + (b.u[i]! - a.u[i]!) * t;
    out.f[i] = a.f[i]! + (b.f[i]! - a.f[i]!) * t;
  }
  // Re-orthonormalise: forward first, up made perpendicular, right from both.
  const f = out.f;
  const u = out.u;
  const fl = mag(f[0], f[1], f[2]) || 1;
  f[0] /= fl;
  f[1] /= fl;
  f[2] /= fl;
  const k = u[0] * f[0] + u[1] * f[1] + u[2] * f[2];
  u[0] -= f[0] * k;
  u[1] -= f[1] * k;
  u[2] -= f[2] * k;
  const ul = mag(u[0], u[1], u[2]) || 1;
  u[0] /= ul;
  u[1] /= ul;
  u[2] /= ul;
  out.s[0] = u[1] * f[2] - u[2] * f[1];
  out.s[1] = u[2] * f[0] - u[0] * f[2];
  out.s[2] = u[0] * f[1] - u[1] * f[0];
}

/** Roots, socket axes and normals in world space for a body pose. */
function placeRoots(c: ChainState, rig: Rig, pose: BodyPose): void {
  const { p, s, u, f } = pose;
  const unit = rig.unit;
  for (let i = 0; i < rig.tentacles; i++) {
    const k = i * 3;
    const sx = rig.socket[k]! * unit;
    const sy = rig.socket[k + 1]! * unit;
    const sz = rig.socket[k + 2]! * unit;
    const ax = rig.axis[k]!;
    const ay = rig.axis[k + 1]!;
    const az = rig.axis[k + 2]!;
    const nx = rig.normal[k]!;
    const ny = rig.normal[k + 1]!;
    const nz = rig.normal[k + 2]!;
    for (let d = 0; d < 3; d++) {
      c.root[k + d] = p[d]! + s[d]! * sx + u[d]! * sy + f[d]! * sz;
      c.axis[k + d] = s[d]! * ax + u[d]! * ay + f[d]! * az;
      c.normal[k + d] = s[d]! * nx + u[d]! * ny + f[d]! * nz;
    }
  }
}

/**
 * The rest shape of one tentacle, as the way each segment should point: the
 * rig's curl turned with the body and telescoped, bent by a travelling wave
 * along its normal and half as much a quarter-turn behind along its binormal
 * (a helical sway), growing toward the tip and dying near a grip. `rest`
 * holds, per segment, the vector from its root joint to where its end should
 * be.
 *
 * Directions, not positions: pulling joints toward absolute positions fights
 * the segment lengths wherever those positions are spaced differently, and a
 * chain squeezed that way buckles into a zigzag. A pull toward "the joint
 * before, plus this segment along its direction" is an angular spring, and
 * never asks a segment to be another length.
 *
 * A tentacle with a target bends its rest shape toward it, as much as its
 * `aim`: along a curve that leaves the socket on its axis and arrives at the
 * target, so a pinned tip and the rest shape agree instead of fighting.
 */
function placeRest(
  c: ChainState,
  rig: Rig,
  i: number,
  pose: BodyPose,
  time: number,
  s: ChainSettings,
  target: Float32Array | null,
): void {
  const { p, s: S, u: U, f: F } = pose;
  const unit = rig.unit;
  const M = rig.segments[i]!;
  const j0 = rig.jointStart[i]!;
  const sg0 = rig.segStart[i]!;
  const stretch = c.stretch[i]!;
  const k3 = i * 3;
  // The aimed shape: a circular arc from the root to the target, as long as
  // the arm, bulging toward the side the socket points to. An arc is its own
  // arc-length parameter, so the shape built from its directions ends on the
  // target, and its bend is even, well inside any joint cone.
  const aim = target ? c.aim[i]! : 0;
  let ex0 = 0;
  let ey0 = 0;
  let ez0 = 0;
  let qx = 0;
  let qy = 0;
  let qz = 0;
  let half = 0;
  if (aim > 0 && target) {
    const sx = rig.socket[k3]!;
    const sy = rig.socket[k3 + 1]!;
    const sz = rig.socket[k3 + 2]!;
    ex0 = target[k3]! - (p[0] + (S[0] * sx + U[0] * sy + F[0] * sz) * unit);
    ey0 = target[k3 + 1]! - (p[1] + (S[1] * sx + U[1] * sy + F[1] * sz) * unit);
    ez0 = target[k3 + 2]! - (p[2] + (S[2] * sx + U[2] * sy + F[2] * sz) * unit);
    const D = mag(ex0, ey0, ez0);
    if (D > 1e-9) {
      ex0 /= D;
      ey0 /= D;
      ez0 /= D;
      // The side to bulge toward: the socket's axis, less its part along the chord.
      const ax = S[0] * rig.axis[k3]! + U[0] * rig.axis[k3 + 1]! + F[0] * rig.axis[k3 + 2]!;
      const ay = S[1] * rig.axis[k3]! + U[1] * rig.axis[k3 + 1]! + F[1] * rig.axis[k3 + 2]!;
      const az = S[2] * rig.axis[k3]! + U[2] * rig.axis[k3 + 1]! + F[2] * rig.axis[k3 + 2]!;
      let ka = ax * ex0 + ay * ey0 + az * ez0;
      qx = ax - ex0 * ka;
      qy = ay - ey0 * ka;
      qz = az - ez0 * ka;
      let ql = mag(qx, qy, qz);
      if (ql < 1e-4) {
        // Pointing straight at it, or straight away: bulge along the socket's normal.
        qx = S[0] * rig.normal[k3]! + U[0] * rig.normal[k3 + 1]! + F[0] * rig.normal[k3 + 2]!;
        qy = S[1] * rig.normal[k3]! + U[1] * rig.normal[k3 + 1]! + F[1] * rig.normal[k3 + 2]!;
        qz = S[2] * rig.normal[k3]! + U[2] * rig.normal[k3 + 1]! + F[2] * rig.normal[k3 + 2]!;
        ka = qx * ex0 + qy * ey0 + qz * ez0;
        qx -= ex0 * ka;
        qy -= ey0 * ka;
        qz -= ez0 * ka;
        ql = mag(qx, qy, qz) || 1;
      }
      qx /= ql;
      qy /= ql;
      qz /= ql;
      // An arc turning through 2x spans a chord of length·sin(x)/x: find x.
      const ratio = Math.min(1, D / Math.max(1e-9, rig.length[i]! * stretch));
      let lo = 0;
      let hi = MAX_ARC_HALF;
      for (let n = 0; n < 14; n++) {
        const mid = (lo + hi) / 2;
        if (Math.sin(mid) / mid > ratio) lo = mid;
        else hi = mid;
      }
      half = lo;
    }
  }
  const along = 1 / Math.max(1e-9, rig.length[i]!);
  let walked = 0;
  const nx = S[0] * rig.normal[k3]! + U[0] * rig.normal[k3 + 1]! + F[0] * rig.normal[k3 + 2]!;
  const ny = S[1] * rig.normal[k3]! + U[1] * rig.normal[k3 + 1]! + F[1] * rig.normal[k3 + 2]!;
  const nz = S[2] * rig.normal[k3]! + U[2] * rig.normal[k3 + 1]! + F[2] * rig.normal[k3 + 2]!;
  const amp = rig.amplitude[i]! * s.waveAmplitude;
  const omega = 2 * Math.PI * rig.frequency[i]! * s.waveFrequency * time + rig.phase[i]!;
  const perJoint = (2 * Math.PI) / (M * Math.max(0.05, rig.wavelength[i]! * s.waveLength));
  const g = c.grip[i]!;
  // The wave's offset at the segment's root joint, carried from one segment to the next.
  let wx = 0;
  let wy = 0;
  let wz = 0;
  for (let j = 0; j < M; j++) {
    const k = (j0 + j) * 3;
    const L = rig.segLength[sg0 + j]! * stretch;
    // The rig's curl, in the world.
    let ex = rig.rest[k + 3]! - rig.rest[k]!;
    let ey = rig.rest[k + 4]! - rig.rest[k + 1]!;
    let ez = rig.rest[k + 5]! - rig.rest[k + 2]!;
    let dx = S[0] * ex + U[0] * ey + F[0] * ez;
    let dy = S[1] * ex + U[1] * ey + F[1] * ez;
    let dz = S[2] * ex + U[2] * ey + F[2] * ez;
    let dl = mag(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    if (aim > 0) {
      // Along the arc: from leaning half its turn toward the bulge, to half away.
      const t = Math.min(1, (walked + 0.5 * rig.segLength[sg0 + j]!) * along);
      const phi = half * (1 - 2 * t);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      dx += (ex0 * cp + qx * sp - dx) * aim;
      dy += (ey0 * cp + qy * sp - dy) * aim;
      dz += (ez0 * cp + qz * sp - dz) * aim;
      dl = mag(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
    }
    if (amp > 0) {
      // The offset at the segment's end; the segment bends by the change across it.
      const t = (j + 1) / M;
      const fade = 1 - g * smoothstep(0.4, 0.9, t);
      const a = amp * Math.pow(t, 1.5) * fade;
      const ph = omega - perJoint * (j + 1);
      const an = a * Math.sin(ph);
      const ab = 0.5 * a * Math.cos(ph);
      const q = k + 3;
      ex = rig.restBinormal[q]!;
      ey = rig.restBinormal[q + 1]!;
      ez = rig.restBinormal[q + 2]!;
      const vx = nx * an + (S[0] * ex + U[0] * ey + F[0] * ez) * ab;
      const vy = ny * an + (S[1] * ex + U[1] * ey + F[1] * ez) * ab;
      const vz = nz * an + (S[2] * ex + U[2] * ey + F[2] * ez) * ab;
      dx += (vx - wx) / L;
      dy += (vy - wy) / L;
      dz += (vz - wz) / L;
      dl = mag(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      wx = vx;
      wy = vy;
      wz = vz;
    }
    c.rest[k] = dx * L;
    c.rest[k + 1] = dy * L;
    c.rest[k + 2] = dz * L;
    walked += rig.segLength[sg0 + j]!;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The click of telescoping a tentacle is heading for: its target's distance over its reach, in steps. */
function aimStretch(c: ChainState, rig: Rig, d: ChainDrive, s: ChainSettings, i: number): void {
  const max = Math.max(1, rig.maxStretch[i]! * s.maxStretchScale);
  let want = 1;
  if (d.mode[i] !== TIP_FREE) {
    const k = i * 3;
    const dx = d.target[k]! - c.root[k]!;
    const dy = d.target[k + 1]! - c.root[k + 1]!;
    const dz = d.target[k + 2]! - c.root[k + 2]!;
    want = mag(dx, dy, dz) / (REACH_BEFORE_STRETCH * rig.length[i]!);
    if (!Number.isFinite(want)) want = 1;
  }
  want = Math.max(1, Math.min(max, want));
  // Hysteresis: only move to another click when clearly past it, so it never chatters.
  if (Math.abs(want - c.stretchGoal[i]!) > RATCHET * 0.75) {
    c.stretchGoal[i] = Math.min(max, 1 + Math.round((want - 1) / RATCHET) * RATCHET);
  }
}

/** Inverse mass of joint j: the root is fixed, the first few are heavier, a pinned tip is fixed. */
function invMass(j: number, M: number, pinned: boolean): number {
  if (j === 0) return 0;
  if (j === M && pinned) return 0;
  return j <= 3 ? 0.6 : 1;
}

function solveDistance(
  x: Float32Array,
  a: number,
  b: number,
  rest: number,
  wa: number,
  wb: number,
): void {
  const ws = wa + wb;
  if (ws <= 0) return;
  const dx = x[b]! - x[a]!;
  const dy = x[b + 1]! - x[a + 1]!;
  const dz = x[b + 2]! - x[a + 2]!;
  const d = mag(dx, dy, dz);
  if (d < 1e-9) return;
  const k = (d - rest) / (d * ws);
  x[a] = x[a]! + dx * k * wa;
  x[a + 1] = x[a + 1]! + dy * k * wa;
  x[a + 2] = x[a + 2]! + dz * k * wa;
  x[b] = x[b]! - dx * k * wb;
  x[b + 1] = x[b + 1]! - dy * k * wb;
  x[b + 2] = x[b + 2]! - dz * k * wb;
}

/**
 * Hold the bend at joint `a` — between the way in (unit e) and the segment
 * from `a` to `b` — to its cone, by moving `b` part of the way back onto it.
 *
 * The previous position moves with it, so the correction reshapes the arm
 * without pushing it: Verlet reads any other move as velocity, and a limit
 * that kicks every time it engages keeps a free arm swinging forever.
 */
function bend(
  x: Float32Array,
  xp: Float32Array,
  a: number,
  b: number,
  ex: number,
  ey: number,
  ez: number,
  cosMax: number,
  sinMax: number,
): void {
  const sx = x[b]! - x[a]!;
  const sy = x[b + 1]! - x[a + 1]!;
  const sz = x[b + 2]! - x[a + 2]!;
  const l = mag(sx, sy, sz);
  if (l < 1e-9) return;
  const cosA = (ex * sx + ey * sy + ez * sz) / l;
  if (cosA >= cosMax) return;
  let px = sx / l - ex * cosA;
  let py = sy / l - ey * cosA;
  let pz = sz / l - ez * cosA;
  const pl = mag(px, py, pz);
  if (pl < 1e-9) return;
  px /= pl;
  py /= pl;
  pz /= pl;
  const mx = (x[a]! + (ex * cosMax + px * sinMax) * l - x[b]!) * CONE_STIFFNESS;
  const my = (x[a + 1]! + (ey * cosMax + py * sinMax) * l - x[b + 1]!) * CONE_STIFFNESS;
  const mz = (x[a + 2]! + (ez * cosMax + pz * sinMax) * l - x[b + 2]!) * CONE_STIFFNESS;
  x[b] = x[b]! + mx;
  x[b + 1] = x[b + 1]! + my;
  x[b + 2] = x[b + 2]! + mz;
  xp[b] = xp[b]! + mx;
  xp[b + 1] = xp[b + 1]! + my;
  xp[b + 2] = xp[b + 2]! + mz;
}

/**
 * Put joint `b` at `length` from joint `a`, moving only `b`: along the line
 * between them, turned back into the cone around the way in from joint `prev`
 * (none when it is negative).
 */
function place(
  x: Float32Array,
  a: number,
  b: number,
  length: number,
  prev: number,
  cosMax: number,
  sinMax: number,
): void {
  let dx = x[b]! - x[a]!;
  let dy = x[b + 1]! - x[a + 1]!;
  let dz = x[b + 2]! - x[a + 2]!;
  const d = mag(dx, dy, dz);
  if (d < 1e-9) return;
  dx /= d;
  dy /= d;
  dz /= d;
  if (prev >= 0) {
    let ex = x[a]! - x[prev]!;
    let ey = x[a + 1]! - x[prev + 1]!;
    let ez = x[a + 2]! - x[prev + 2]!;
    const el = mag(ex, ey, ez);
    if (el > 1e-9) {
      ex /= el;
      ey /= el;
      ez /= el;
      const cosA = ex * dx + ey * dy + ez * dz;
      if (cosA < cosMax) {
        let px = dx - ex * cosA;
        let py = dy - ey * cosA;
        let pz = dz - ez * cosA;
        const pl = mag(px, py, pz);
        if (pl > 1e-9) {
          px /= pl;
          py /= pl;
          pz /= pl;
          dx = ex * cosMax + px * sinMax;
          dy = ey * cosMax + py * sinMax;
          dz = ez * cosMax + pz * sinMax;
        }
      }
    }
  }
  x[b] = x[a]! + dx * length;
  x[b + 1] = x[a + 1]! + dy * length;
  x[b + 2] = x[a + 2]! + dz * length;
}

/**
 * The constraint passes of one step (or of a relaxation), for one tentacle.
 * `minGain` firms up soft targets and finishes them with FABRIK like pins: a
 * relaxation has no motion to keep, only a pose to reach in a few passes, and
 * a tip's pull otherwise travels back up the arm one joint per pass.
 */
function solve(
  c: ChainState,
  rig: Rig,
  d: ChainDrive,
  s: ChainSettings,
  i: number,
  pose: BodyPose,
  iterations: number,
  minGain = 0,
): void {
  const x = c.x;
  const M = rig.segments[i]!;
  const j0 = rig.jointStart[i]!;
  const sg0 = rig.segStart[i]!;
  const k3 = i * 3;
  const mode = d.mode[i]!;
  const pinned = mode === TIP_PINNED;
  const reaching = pinned || (minGain > 0 && mode === TIP_SOFT);
  const stretch = c.stretch[i]!;
  const tip = (j0 + M) * 3;
  const r0 = j0 * 3;
  const limit = coneLimit(M, s.coneScale);
  const cosMax = Math.cos(limit);
  const sinMax = Math.sin(limit);
  const rootLimit = Math.min(Math.PI * 0.6, limit * ROOT_SWING);
  const cosRoot = Math.cos(rootLimit);
  const sinRoot = Math.sin(rootLimit);
  const recoilBoost = 1 + 2 * s.recoil * Math.exp(-c.recoil[i]! / 0.35);
  const kRest = rig.stiffness[i]! * s.restStiffness * recoilBoost;
  const tx = d.target[k3]!;
  const ty = d.target[k3 + 1]!;
  const tz = d.target[k3 + 2]!;
  const gain = Math.max(minGain, Math.min(1, d.gain[i]!));
  // The hull as a capsule along forward, for the push-out.
  const unit = rig.unit * rig.bodyScale;
  const hullR = ((HULL.width + HULL.height) / 4) * unit;
  const hullH = Math.max(0, HULL.length / 2 - (HULL.width + HULL.height) / 4) * unit;

  for (let it = 0; it < iterations; it++) {
    // a. The root rides its socket.
    x[r0] = c.root[k3]!;
    x[r0 + 1] = c.root[k3 + 1]!;
    x[r0 + 2] = c.root[k3 + 2]!;

    // b. Each joint is drawn toward where its segment's rest direction puts
    //    it from the joint before: firmly at the root, barely at the tip.
    for (let j = 1; j <= M; j++) {
      if (j === M && pinned) continue;
      const t = 1 - j / M;
      const k = Math.min(1, kRest * (0.3 * t * t + 0.03));
      const q = (j0 + j) * 3;
      const r = q - 3;
      x[q] = x[q]! + (x[r]! + c.rest[r]! - x[q]!) * k;
      x[q + 1] = x[q + 1]! + (x[r + 1]! + c.rest[r + 1]! - x[q + 1]!) * k;
      x[q + 2] = x[q + 2]! + (x[r + 2]! + c.rest[r + 2]! - x[q + 2]!) * k;
    }

    // c. Segment lengths, root to tip, after the pull: lengths have the last word.
    for (let j = 0; j < M; j++) {
      solveDistance(
        x,
        (j0 + j) * 3,
        (j0 + j + 1) * 3,
        rig.segLength[sg0 + j]! * stretch,
        invMass(j, M, pinned),
        invMass(j + 1, M, pinned),
      );
    }

    // d. The tip: pinned to its hold, or drawn toward its target — before the
    //    cones, so they see the bend that makes.
    if (pinned) {
      x[tip] = tx;
      x[tip + 1] = ty;
      x[tip + 2] = tz;
    } else if (mode === TIP_SOFT && gain > 0) {
      // The last joints follow the tip a little, so the pull is not one sharp bend.
      const dx = (tx - x[tip]!) * gain;
      const dy = (ty - x[tip + 1]!) * gain;
      const dz = (tz - x[tip + 2]!) * gain;
      for (let n = 0, w = 1; n < 3 && n < M; n++, w *= 0.5) {
        const q = tip - n * 3;
        x[q] = x[q]! + dx * w;
        x[q + 1] = x[q + 1]! + dy * w;
        x[q + 2] = x[q + 2]! + dz * w;
      }
    }

    // e. Soft joint cones, root to tip; the socket's axis stands in for the
    //    segment before the root, with the wider swing of a ball socket.
    for (let j = 0; j < M; j++) {
      if (j + 1 === M && pinned) continue;
      const a = (j0 + j) * 3;
      if (j === 0) {
        bend(x, c.xp, a, a + 3, c.axis[k3]!, c.axis[k3 + 1]!, c.axis[k3 + 2]!, cosRoot, sinRoot);
      } else {
        const ex = x[a]! - x[a - 3]!;
        const ey = x[a + 1]! - x[a - 2]!;
        const ez = x[a + 2]! - x[a - 1]!;
        const el = mag(ex, ey, ez);
        if (el > 1e-9) bend(x, c.xp, a, a + 3, ex / el, ey / el, ez / el, cosMax, sinMax);
      }
    }

    if (reaching) {
      // f. The joints next to a pinned tip are held to their cones from its
      //    side, since the pass above cannot move the tip to correct them.
      for (let j = M - 1; j >= 2; j--) {
        const a = (j0 + j) * 3;
        const ex = x[a]! - x[a + 3]!;
        const ey = x[a + 1]! - x[a + 4]!;
        const ez = x[a + 2]! - x[a + 5]!;
        const el = mag(ex, ey, ez);
        if (el > 1e-9) bend(x, c.xp, a, a - 3, ex / el, ey / el, ez / el, cosMax, sinMax);
      }
      //    Then FABRIK both ways, with joint limits: from the pin back to the
      //    root, each joint put at its segment's length from the one after it
      //    and within its cone, then out again from the root. Weighted passes
      //    with both ends fixed converge too slowly, and Verlet turns every
      //    correction they leave into a wobble.
      for (let j = M - 1; j >= 1; j--) {
        const b = (j0 + j + 1) * 3;
        const after = j + 1 < M ? b + 3 : -1;
        place(x, b, (j0 + j) * 3, rig.segLength[sg0 + j]! * stretch, after, cosMax, sinMax);
      }
      // A pin keeps its tip; a soft target's tip lands where the arm reaches.
      for (let j = 1; j < (pinned ? M : M + 1); j++) {
        const a = (j0 + j - 1) * 3;
        place(
          x,
          a,
          a + 3,
          rig.segLength[sg0 + j - 1]! * stretch,
          j > 1 ? a - 3 : -1,
          cosMax,
          sinMax,
        );
      }
    }

    // g. Out of the hull. The first joints sit in the collar and are left alone.
    if (s.collide) {
      const { p, f } = pose;
      for (let j = 3; j <= M; j++) {
        if (j === M && pinned) continue;
        const q = (j0 + j) * 3;
        const qx = x[q]! - p[0];
        const qy = x[q + 1]! - p[1];
        const qz = x[q + 2]! - p[2];
        const along = Math.max(-hullH, Math.min(hullH, qx * f[0] + qy * f[1] + qz * f[2]));
        const cx = qx - f[0] * along;
        const cy = qy - f[1] * along;
        const cz = qz - f[2] * along;
        const dl = mag(cx, cy, cz);
        if (dl >= hullR || dl < 1e-9) continue;
        const push = hullR / dl - 1;
        x[q] = x[q]! + cx * push;
        x[q + 1] = x[q + 1]! + cy * push;
        x[q + 2] = x[q + 2]! + cz * push;
      }
    }
  }
}

/** Telescoping springs toward its click (critically damped, ω = 16), within its limit. */
function stepStretch(c: ChainState, rig: Rig, s: ChainSettings, i: number, h: number): void {
  const omega = 16;
  const e = Math.exp(-omega * h);
  const goal = c.stretchGoal[i]!;
  const dx = c.stretch[i]! - goal;
  const k = (c.stretchV[i]! + omega * dx) * h;
  c.stretchV[i] = (c.stretchV[i]! - omega * k) * e;
  const max = Math.max(1, rig.maxStretch[i]! * s.maxStretchScale);
  c.stretch[i] = Math.max(1, Math.min(max, goal + (dx + k) * e));
}

/** One Verlet step of h seconds for every tentacle, at `pose`. */
function substep(
  c: ChainState,
  rig: Rig,
  d: ChainDrive,
  s: ChainSettings,
  pose: BodyPose,
  time: number,
  h: number,
): void {
  placeRoots(c, rig, pose);
  const x = c.x;
  const xp = c.xp;
  const maxMove = MAX_STEP_MOVE * rig.unit;
  for (let i = 0; i < rig.tentacles; i++) {
    aimStretch(c, rig, d, s, i);
    stepStretch(c, rig, s, i, h);
    placeRest(c, rig, i, pose, time, s, d.target);
    const M = rig.segments[i]!;
    const j0 = rig.jointStart[i]!;
    const damp = Math.exp(-h / Math.max(0.02, rig.drag[i]! * s.dragScale));
    for (let j = 1; j <= M; j++) {
      const q = (j0 + j) * 3;
      let vx = (x[q]! - xp[q]!) * damp;
      let vy = (x[q + 1]! - xp[q + 1]!) * damp;
      let vz = (x[q + 2]! - xp[q + 2]!) * damp;
      const v = mag(vx, vy, vz);
      if (v > maxMove) {
        const k = maxMove / v;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      xp[q] = x[q]!;
      xp[q + 1] = x[q + 1]!;
      xp[q + 2] = x[q + 2]!;
      x[q] = x[q]! + vx;
      x[q + 1] = x[q + 1]! + vy;
      x[q + 2] = x[q + 2]! + vz;
    }
    solve(c, rig, d, s, i, pose, s.iterations);
  }
}

/** Put one tentacle back at its rest shape, at rest. */
function resetTentacle(c: ChainState, rig: Rig, i: number): void {
  const j0 = rig.jointStart[i]!;
  let q = j0 * 3;
  for (let d = 0; d < 3; d++) c.x[q + d] = c.root[i * 3 + d]!;
  for (let j = 0; j < rig.segments[i]!; j++, q += 3) {
    for (let d = 0; d < 3; d++) c.x[q + 3 + d] = c.x[q + d]! + c.rest[q + d]!;
  }
  const from = j0 * 3;
  c.xp.set(c.x.subarray(from, q + 3), from);
}

/**
 * Advance the chains one frame: steps of 1/120 s while the accumulator
 * holds them (at most `maxSteps`, the rest dropped), each at the body pose
 * interpolated to its moment; then the rigid pass that is drawn.
 */
export function stepChain(c: ChainState, rig: Rig, d: ChainDrive, s: ChainSettings): void {
  const dt = Number.isFinite(d.dt) && d.dt > 0 ? d.dt : 0;
  placeRoots(c, rig, d.body1);
  letGo(c, rig, d, s, dt);

  const owed = c.acc;
  c.acc += dt;
  let n = Math.floor(c.acc / CHAIN_STEP + 1e-9);
  const dropped = n > s.maxSteps;
  if (dropped) {
    n = s.maxSteps;
    c.acc = c.acc % CHAIN_STEP;
  } else c.acc = Math.max(0, c.acc - n * CHAIN_STEP);
  for (let k = 0; k < n; k++) {
    // Each step at the moment of the frame it simulates: the time owed from
    // the last frame comes first. Spread evenly instead, a frame of two steps
    // after one of none would move the root as far as two frames should. A
    // frame that drops steps spreads the ones it keeps, so the root never jumps.
    const a =
      dropped || !(dt > 0)
        ? (k + 1) / n
        : Math.max(0, Math.min(1, ((k + 1) * CHAIN_STEP - owed) / dt));
    lerpPose(d.body0, d.body1, a, scratchPose);
    substep(c, rig, d, s, scratchPose, d.time - dt * (1 - a), CHAIN_STEP);
  }
  guard(c, rig, d, s);
  finish(c, rig, d.body1, s, d);
}

/**
 * Settle the chains at `body1` without inertia or wave: constraint passes
 * only, telescoping straight to its click. The reduced-motion pose, and the
 * re-seating when the threads under a still pose move.
 */
export function relaxChain(
  c: ChainState,
  rig: Rig,
  d: ChainDrive,
  s: ChainSettings,
  iterations: number,
): void {
  // No wave; and firmer, since there is no motion to keep, only a shape to
  // reach. Never softer than the default: a loose tuning that reads as alive
  // in motion would leave the still pose unsettled after its passes, and the
  // same view must give the same pose.
  const still = Object.assign(STILL, s);
  still.waveAmplitude = 0;
  still.restStiffness = Math.max(1, s.restStiffness) * 3;
  placeRoots(c, rig, d.body1);
  for (let i = 0; i < rig.tentacles; i++) {
    aimStretch(c, rig, d, still, i);
    c.stretch[i] = c.stretchGoal[i]!;
    c.stretchV[i] = 0;
    c.grip[i] = d.mode[i] === TIP_PINNED ? 1 : 0;
    c.aim[i] = aimOf(d, i);
    c.closure[i] = d.mode[i] === TIP_PINNED ? 1 : 0;
    c.recoil[i] = NO_RECOIL;
    c.held[i] = d.mode[i] === TIP_PINNED ? 1 : 0;
    placeRest(c, rig, i, d.body1, d.time, still, d.target);
    solve(c, rig, d, still, i, d.body1, iterations, RELAX_GAIN);
  }
  c.xp.set(c.x);
  c.acc = 0;
  guard(c, rig, d, still);
  finish(c, rig, d.body1, s, d);
}

/** Every tentacle at its rest shape around `body`, at rest: the start, and after a jump. */
export function resetChain(c: ChainState, rig: Rig, body: BodyPose): void {
  placeRoots(c, rig, body);
  c.stretch.fill(1);
  c.stretchV.fill(0);
  c.stretchGoal.fill(1);
  c.grip.fill(0);
  c.aim.fill(0);
  c.held.fill(0);
  c.recoil.fill(NO_RECOIL);
  c.closure.fill(0);
  c.acc = 0;
  for (let i = 0; i < rig.tentacles; i++) {
    placeRest(c, rig, i, body, 0, RESTING, null);
    resetTentacle(c, rig, i);
  }
  finish(c, rig, body, RESTING, null);
}

const RESTING: ChainSettings = {
  iterations: 0,
  maxSteps: 0,
  collide: false,
  restStiffness: 1,
  coneScale: 1,
  dragScale: 1,
  waveAmplitude: 0,
  waveFrequency: 1,
  waveLength: 1,
  maxStretchScale: 1,
  recoil: 0,
};

/** relaxChain's settings, rewritten on every call: it runs every frame under reduced motion. */
const STILL: ChainSettings = { ...RESTING };

/** A tentacle with anything non-finite in it starts over at its rest shape. */
function guard(c: ChainState, rig: Rig, d: ChainDrive, s: ChainSettings): void {
  for (let i = 0; i < rig.tentacles; i++) {
    const j0 = rig.jointStart[i]! * 3;
    const end = j0 + (rig.segments[i]! + 1) * 3;
    let ok = Number.isFinite(c.stretch[i]!) && Number.isFinite(c.stretchV[i]!);
    for (let q = j0; ok && q < end; q++) ok = Number.isFinite(c.x[q]!) && Number.isFinite(c.xp[q]!);
    if (ok) continue;
    c.stretch[i] = 1;
    c.stretchV[i] = 0;
    c.stretchGoal[i] = 1;
    c.aim[i] = 0;
    placeRest(c, rig, i, d.body1, d.time, { ...s, waveAmplitude: 0 }, null);
    resetTentacle(c, rig, i);
  }
}

/**
 * Grips that end kick the tip back toward its socket, start a roll wave down
 * the arm and stiffen it for a moment; grips that start close the claw.
 */
function letGo(c: ChainState, rig: Rig, d: ChainDrive, s: ChainSettings, dt: number): void {
  for (let i = 0; i < rig.tentacles; i++) {
    const pinned = d.mode[i] === TIP_PINNED;
    c.recoil[i] = Math.min(NO_RECOIL, c.recoil[i]! + dt);
    if (c.held[i] && !pinned && s.recoil > 0) {
      c.recoil[i] = 0;
      const M = rig.segments[i]!;
      const tip = (rig.jointStart[i]! + M) * 3;
      const k3 = i * 3;
      let bx = c.root[k3]! - c.x[tip]!;
      let by = c.root[k3 + 1]! - c.x[tip + 1]!;
      let bz = c.root[k3 + 2]! - c.x[tip + 2]!;
      const bl = mag(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;
      // Sideways too, each tentacle its own way, so a release never looks like a retraction.
      const side = Math.sin(rig.phase[i]!) >= 0 ? 1 : -1;
      const u = d.body1.u;
      let lx = by * u[2] - bz * u[1];
      let ly = bz * u[0] - bx * u[2];
      let lz = bx * u[1] - by * u[0];
      const ll = mag(lx, ly, lz) || 1;
      lx = (lx / ll) * side;
      ly = (ly / ll) * side;
      lz = (lz / ll) * side;
      // Through the previous position: one step's worth of velocity.
      const kick = 0.04 * rig.unit * s.recoil;
      for (const [q, w] of [
        [tip, 1],
        [tip - 3, 0.5],
      ] as const) {
        c.xp[q] = c.xp[q]! - (bx + lx * 0.5) * kick * w;
        c.xp[q + 1] = c.xp[q + 1]! - (by + ly * 0.5) * kick * w;
        c.xp[q + 2] = c.xp[q + 2]! - (bz + lz * 0.5) * kick * w;
      }
    }
    c.held[i] = pinned ? 1 : 0;
    const grip = pinned ? 1 : d.mode[i] === TIP_SOFT && d.gain[i]! >= 0.3 ? 0.5 : 0;
    c.grip[i] = c.grip[i]! + (grip - c.grip[i]!) * (1 - Math.exp(-dt / 0.15));
    // A pin is immediate, so the shape follows it quickly; letting go relaxes slower.
    const aim = aimOf(d, i);
    c.aim[i] = c.aim[i]! + (aim - c.aim[i]!) * (1 - Math.exp(-dt / (aim > c.aim[i]! ? 0.05 : 0.2)));
    const bite = pinned ? 1 : 0;
    const rate = bite > c.closure[i]! ? 25 : 6;
    c.closure[i] = c.closure[i]! + (bite - c.closure[i]!) * (1 - Math.exp(-rate * dt));
  }
}

/** How far a tentacle's rest shape bends toward its target: all the way when pinned. */
function aimOf(d: ChainDrive, i: number): number {
  const m = d.mode[i];
  return m === TIP_PINNED ? 1 : m === TIP_SOFT ? 0.85 : 0;
}

/** A joint coordinate carried `ahead` of a step on along its Verlet velocity. */
function carried(x: Float32Array, xp: Float32Array, k: number, ahead: number): number {
  return x[k]! + (x[k]! - xp[k]!) * ahead;
}

/**
 * What is drawn: from the root, each segment at exactly its length, along the
 * direction the solver gave it. Aiming each one at the next solved joint
 * instead folds the drawn chain wherever the solved one is compressed.
 */
function finish(
  c: ChainState,
  rig: Rig,
  body: BodyPose,
  s: ChainSettings,
  d: ChainDrive | null,
): void {
  placeRoots(c, rig, body);
  const x = c.x;
  const xp = c.xp;
  const xr = c.xr;
  // The last step ended `acc` seconds before the frame does: its joints are
  // carried on at their own velocity to the frame's moment, as the root is.
  // Drawn as they were, a frame with no step would show the arm frozen while
  // the body moves, and the next would catch up twice as far.
  const ahead = c.acc / CHAIN_STEP;
  for (let i = 0; i < rig.tentacles; i++) {
    const M = rig.segments[i]!;
    const j0 = rig.jointStart[i]!;
    const sg0 = rig.segStart[i]!;
    const k3 = i * 3;
    const stretch = c.stretch[i]!;
    const limit = coneLimit(M, s.coneScale) * DRAWN_SLACK;
    const cosMax = Math.cos(limit);
    const sinMax = Math.sin(limit);
    const rootLimit = Math.min(Math.PI * 0.6, limit * ROOT_SWING);
    const cosRoot = Math.cos(rootLimit);
    const sinRoot = Math.sin(rootLimit);
    let q = j0 * 3;
    xr[q] = c.root[k3]!;
    xr[q + 1] = c.root[k3 + 1]!;
    xr[q + 2] = c.root[k3 + 2]!;
    let dx = c.axis[k3]!;
    let dy = c.axis[k3 + 1]!;
    let dz = c.axis[k3 + 2]!;
    for (let j = 0; j < M; j++) {
      const n = q + 3;
      // Along the solved segment itself — from the root as it is now for the
      // first — so the drawn chain bends exactly as the solved one does.
      const ex = carried(x, xp, n, ahead) - (j === 0 ? xr[q]! : carried(x, xp, q, ahead));
      const ey =
        carried(x, xp, n + 1, ahead) - (j === 0 ? xr[q + 1]! : carried(x, xp, q + 1, ahead));
      const ez =
        carried(x, xp, n + 2, ahead) - (j === 0 ? xr[q + 2]! : carried(x, xp, q + 2, ahead));
      const el = mag(ex, ey, ez);
      if (el > 1e-9) {
        // Never drawn folded: a bend the soft cones let through is clamped here.
        const px = dx;
        const py = dy;
        const pz = dz;
        dx = ex / el;
        dy = ey / el;
        dz = ez / el;
        const cm = j === 0 ? cosRoot : cosMax;
        const cosA = px * dx + py * dy + pz * dz;
        if (cosA < cm) {
          let ox = dx - px * cosA;
          let oy = dy - py * cosA;
          let oz = dz - pz * cosA;
          const ol = mag(ox, oy, oz);
          if (ol > 1e-9) {
            const sm = j === 0 ? sinRoot : sinMax;
            ox /= ol;
            oy /= ol;
            oz /= ol;
            dx = px * cm + ox * sm;
            dy = py * cm + oy * sm;
            dz = pz * cm + oz * sm;
          }
        }
      }
      const l = rig.segLength[sg0 + j]! * stretch;
      xr[n] = xr[q]! + dx * l;
      xr[n + 1] = xr[q + 1]! + dy * l;
      xr[n + 2] = xr[q + 2]! + dz * l;
      q = n;
    }
    // A claw that holds is drawn on its thread: what the solver left between
    // them is closed by two FABRIK passes over the drawn joints themselves,
    // which keep every segment its length and every bend within its cone.
    if (d && d.mode[i] === TIP_PINNED) {
      const tip = (j0 + M) * 3;
      const gx = d.target[k3]!;
      const gy = d.target[k3 + 1]!;
      const gz = d.target[k3 + 2]!;
      if (mag(xr[tip]! - gx, xr[tip + 1]! - gy, xr[tip + 2]! - gz) > 1e-6 * rig.unit) {
        for (let pass = 0; pass < 2; pass++) {
          xr[tip] = gx;
          xr[tip + 1] = gy;
          xr[tip + 2] = gz;
          for (let j = M - 1; j >= 1; j--) {
            const b = (j0 + j + 1) * 3;
            place(
              xr,
              b,
              b - 3,
              rig.segLength[sg0 + j]! * stretch,
              j + 1 < M ? b + 3 : -1,
              cosMax,
              sinMax,
            );
          }
          for (let j = 1; j <= M; j++) {
            const a = (j0 + j - 1) * 3;
            place(
              xr,
              a,
              a + 3,
              rig.segLength[sg0 + j - 1]! * stretch,
              j > 1 ? a - 3 : -1,
              cosMax,
              sinMax,
            );
          }
        }
      }
    }
  }
}

/**
 * The same chains cut into another tier's segment count, by arc length — a
 * tier change never pops. Velocities survive: the previous positions are
 * resampled the same way.
 */
export function resampleChain(c: ChainState, from: Rig, to: Rig): ChainState {
  const out = createChain(to);
  for (const k of [
    'stretch',
    'stretchV',
    'stretchGoal',
    'grip',
    'aim',
    'recoil',
    'closure',
    'glow',
    'glowFront',
    'root',
    'axis',
    'normal',
  ] as const) {
    out[k].set(c[k]);
  }
  out.held.set(c.held);
  out.acc = c.acc;
  for (let i = 0; i < from.tentacles; i++) {
    for (const key of ['x', 'xp', 'xr'] as const) {
      resampleOne(
        c[key],
        from.jointStart[i]!,
        from.segments[i]!,
        out[key],
        to.jointStart[i]!,
        to.segments[i]!,
      );
    }
  }
  return out;
}

function resampleOne(
  src: Float32Array,
  j0: number,
  M: number,
  dst: Float32Array,
  k0: number,
  N: number,
): void {
  const cum = new Float64Array(M + 1);
  for (let j = 1; j <= M; j++) {
    const a = (j0 + j - 1) * 3;
    const b = a + 3;
    cum[j] =
      cum[j - 1]! + mag(src[b]! - src[a]!, src[b + 1]! - src[a + 1]!, src[b + 2]! - src[a + 2]!);
  }
  const total = cum[M]!;
  let j = 0;
  for (let n = 0; n <= N; n++) {
    const want = (total * n) / N;
    while (j < M - 1 && cum[j + 1]! < want) j++;
    const span = cum[j + 1]! - cum[j]!;
    const f = span > 1e-12 ? Math.max(0, Math.min(1, (want - cum[j]!) / span)) : 0;
    const a = (j0 + j) * 3;
    const o = (k0 + n) * 3;
    for (let d = 0; d < 3; d++) dst[o + d] = src[a + d]! + (src[a + 3 + d]! - src[a + d]!) * f;
  }
}

/** World position of a tentacle's drawn tip. */
export function tipOf(c: ChainState, rig: Rig, i: number, out: Vec3): Vec3 {
  const q = (rig.jointStart[i]! + rig.segments[i]!) * 3;
  out[0] = c.xr[q]!;
  out[1] = c.xr[q + 1]!;
  out[2] = c.xr[q + 2]!;
  return out;
}

/** How far a claw opens and closes about the arm's axis, radians. */
const CLAW_OPEN = 0.55;
const CLAW_SHUT = -0.15;
/** Seconds for a roll wave to travel one segment root-ward, and to die away. */
const ROLL_SPEED = 12;
const ROLL_DECAY = 0.3;
const ROLL_ANGLE = (6 * Math.PI) / 180;

/**
 * Write the drawn chains into the pose, in creature space ((world − anchor) /
 * unit): one matrix per segment, columns x = normal·radius, y = tangent·length,
 * z = binormal·radius, then its root; its attributes (glow, wear, position
 * along the arm, tentacle); three claw fingers per tip — x away from the arm's
 * axis, y along the finger, z around the arm — closing as the claw bites; and a
 * bounding sphere around all of it and the hull. The talon geometry hooks
 * toward its −x (geometry.ts), so with x pointing out the three hook in onto
 * what they grip.
 */
export function writeSegments(
  c: ChainState,
  rig: Rig,
  anchor: Vec3,
  pose: SentinelPose,
  recoilScale = 1,
): void {
  const xr = c.xr;
  const inv = 1 / rig.unit;
  const m = pose.segmentMatrices;
  const attrs = pose.segmentAttrs;
  const cm = pose.clawMatrices;
  const ca = pose.clawAttrs;
  let minX = -0.5;
  let minY = -0.5;
  let minZ = -0.5;
  let maxX = 0.5;
  let maxY = 0.5;
  let maxZ = 0.5;

  for (let i = 0; i < rig.tentacles; i++) {
    const M = rig.segments[i]!;
    const j0 = rig.jointStart[i]!;
    const sg0 = rig.segStart[i]!;
    const k3 = i * 3;
    const twist = rig.twist[i]!;
    const stretch = c.stretch[i]!;
    const rollAge = c.recoil[i]!;
    const roll = ROLL_ANGLE * recoilScale * Math.exp(-rollAge / ROLL_DECAY);
    const rollFront = M - ROLL_SPEED * rollAge;
    const glow = c.glow[i]!;
    const front = 3 * Math.max(0, Math.min(1, c.glowFront[i]!));
    // The frame carried from the socket.
    let px = c.root[k3]!;
    let py = c.root[k3 + 1]!;
    let pz = c.root[k3 + 2]!;
    let tx = c.axis[k3]!;
    let ty = c.axis[k3 + 1]!;
    let tz = c.axis[k3 + 2]!;
    let rx = c.normal[k3]!;
    let ry = c.normal[k3 + 1]!;
    let rz = c.normal[k3 + 2]!;
    let Nx = rx;
    let Ny = ry;
    let Nz = rz;
    let Bx = 0;
    let By = 0;
    let Bz = 1;
    for (let j = 0; j < M; j++) {
      const a = (j0 + j) * 3;
      const ax = xr[a]!;
      const ay = xr[a + 1]!;
      const az = xr[a + 2]!;
      let Tx = xr[a + 3]! - ax;
      let Ty = xr[a + 4]! - ay;
      let Tz = xr[a + 5]! - az;
      const L = mag(Tx, Ty, Tz) || 1e-9;
      Tx /= L;
      Ty /= L;
      Tz /= L;
      const mx = ax + Tx * L * 0.5;
      const my = ay + Ty * L * 0.5;
      const mz = az + Tz * L * 0.5;
      // Double reflection: across the plane between the two frame points, then across the one between the tangents.
      const v1x = mx - px;
      const v1y = my - py;
      const v1z = mz - pz;
      const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
      let rLx = rx;
      let rLy = ry;
      let rLz = rz;
      let tLx = tx;
      let tLy = ty;
      let tLz = tz;
      if (c1 > 1e-18) {
        const kr = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
        rLx -= kr * v1x;
        rLy -= kr * v1y;
        rLz -= kr * v1z;
        const kt = (2 / c1) * (v1x * tx + v1y * ty + v1z * tz);
        tLx -= kt * v1x;
        tLy -= kt * v1y;
        tLz -= kt * v1z;
      }
      const v2x = Tx - tLx;
      const v2y = Ty - tLy;
      const v2z = Tz - tLz;
      const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      if (c2 > 1e-18) {
        const k = (2 / c2) * (v2x * rLx + v2y * rLy + v2z * rLz);
        rLx -= k * v2x;
        rLy -= k * v2y;
        rLz -= k * v2z;
      }
      // Clear the rounding: perpendicular to the tangent, unit length.
      const kd = rLx * Tx + rLy * Ty + rLz * Tz;
      rLx -= Tx * kd;
      rLy -= Ty * kd;
      rLz -= Tz * kd;
      let rl = mag(rLx, rLy, rLz);
      if (rl < 1e-9) {
        // Degenerate: any perpendicular will do.
        rLx = Math.abs(Tx) < 0.9 ? 0 : 1;
        rLy = Math.abs(Tx) < 0.9 ? -Tz : 0;
        rLz = Math.abs(Tx) < 0.9 ? Ty : -Tx;
        rl = mag(rLx, rLy, rLz) || 1;
      }
      rx = rLx / rl;
      ry = rLy / rl;
      rz = rLz / rl;
      px = mx;
      py = my;
      pz = mz;
      tx = Tx;
      ty = Ty;
      tz = Tz;

      // Rolled about the tangent: the rig's twist, plus a release's roll wave passing by.
      const dj = j - rollFront;
      const th = j * twist + roll * Math.exp(-dj * dj * 0.5);
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // T × r
      const qx = Ty * rz - Tz * ry;
      const qy = Tz * rx - Tx * rz;
      const qz = Tx * ry - Ty * rx;
      Nx = rx * cs + qx * sn;
      Ny = ry * cs + qy * sn;
      Nz = rz * cs + qz * sn;
      // B = N × T
      Bx = Ny * Tz - Nz * Ty;
      By = Nz * Tx - Nx * Tz;
      Bz = Nx * Ty - Ny * Tx;

      const s = sg0 + j;
      const r = rig.segRadius[s]! * inv;
      const l = rig.segLength[s]! * stretch * inv;
      const o = s * 16;
      const cx = (ax - anchor[0]) * inv;
      const cy = (ay - anchor[1]) * inv;
      const cz = (az - anchor[2]) * inv;
      m[o] = Nx * r;
      m[o + 1] = Ny * r;
      m[o + 2] = Nz * r;
      m[o + 3] = 0;
      m[o + 4] = Tx * l;
      m[o + 5] = Ty * l;
      m[o + 6] = Tz * l;
      m[o + 7] = 0;
      m[o + 8] = Bx * r;
      m[o + 9] = By * r;
      m[o + 10] = Bz * r;
      m[o + 11] = 0;
      m[o + 12] = cx;
      m[o + 13] = cy;
      m[o + 14] = cz;
      m[o + 15] = 1;
      // Glow on the last three segments, creeping root-ward from the tip.
      const fromTip = M - 1 - j;
      const g = fromTip < 3 ? glow * Math.max(0, Math.min(1, front - fromTip)) : 0;
      attrs[s * 4] = g;
      attrs[s * 4 + 1] = rig.wear[s]!;
      attrs[s * 4 + 2] = M > 1 ? j / (M - 1) : 0;
      attrs[s * 4 + 3] = i;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cz < minZ) minZ = cz;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      if (cz > maxZ) maxZ = cz;
    }

    // The claw, at the tip, in the last segment's frame.
    const t = (j0 + M) * 3;
    const tipX = xr[t]!;
    const tipY = xr[t + 1]!;
    const tipZ = xr[t + 2]!;
    const spread = CLAW_OPEN + (CLAW_SHUT - CLAW_OPEN) * Math.max(0, Math.min(1, c.closure[i]!));
    const cs = Math.cos(spread);
    const sn = Math.sin(spread);
    const fl = rig.clawLength[i]! * inv;
    const fr = rig.clawRadius[i]! * inv;
    const rim = rig.segRadius[sg0 + M - 1]! * 0.8;
    const baseBack = rig.clawLength[i]! * 0.3;
    for (let k = 0; k < CLAW_FINGERS; k++) {
      const psi = (2 * Math.PI * k) / CLAW_FINGERS;
      const cp = Math.cos(psi);
      const sp = Math.sin(psi);
      // Out from the axis, and around it.
      const ox = Nx * cp + Bx * sp;
      const oy = Ny * cp + By * sp;
      const oz = Nz * cp + Bz * sp;
      const ax = -Nx * sp + Bx * cp;
      const ay = -Ny * sp + By * cp;
      const az = -Nz * sp + Bz * cp;
      const dx = tx * cs + ox * sn;
      const dy = ty * cs + oy * sn;
      const dz = tz * cs + oz * sn;
      // Away from the axis, square to the finger: along turned a right angle
      // outward. (out, along, around) is right-handed, so normals stay outward.
      const ex = ox * cs - tx * sn;
      const ey = oy * cs - ty * sn;
      const ez = oz * cs - tz * sn;
      const f = (i * CLAW_FINGERS + k) * 16;
      cm[f] = ex * fr;
      cm[f + 1] = ey * fr;
      cm[f + 2] = ez * fr;
      cm[f + 3] = 0;
      cm[f + 4] = dx * fl;
      cm[f + 5] = dy * fl;
      cm[f + 6] = dz * fl;
      cm[f + 7] = 0;
      cm[f + 8] = ax * fr;
      cm[f + 9] = ay * fr;
      cm[f + 10] = az * fr;
      cm[f + 11] = 0;
      cm[f + 12] = (tipX - tx * baseBack + ox * rim - anchor[0]) * inv;
      cm[f + 13] = (tipY - ty * baseBack + oy * rim - anchor[1]) * inv;
      cm[f + 14] = (tipZ - tz * baseBack + oz * rim - anchor[2]) * inv;
      cm[f + 15] = 1;
      const a4 = (i * CLAW_FINGERS + k) * 4;
      ca[a4] = glow * Math.max(0, Math.min(1, front));
      ca[a4 + 1] = rig.wear[sg0 + M - 1]!;
      ca[a4 + 2] = c.closure[i]!;
      ca[a4 + 3] = i;
    }
    const ex = (tipX - anchor[0]) * inv;
    const ey = (tipY - anchor[1]) * inv;
    const ez = (tipZ - anchor[2]) * inv;
    if (ex < minX) minX = ex;
    if (ey < minY) minY = ey;
    if (ez < minZ) minZ = ez;
    if (ex > maxX) maxX = ex;
    if (ey > maxY) maxY = ey;
    if (ez > maxZ) maxZ = ez;
  }
  pose.segments = rig.totalSegments;
  pose.claws = TENTACLES * CLAW_FINGERS;

  // A sphere around the box, padded for radii and claws.
  const bx = (minX + maxX) / 2;
  const by = (minY + maxY) / 2;
  const bz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let q = 0; q < rig.joints * 3; q += 3) {
    const dx = (xr[q]! - anchor[0]) * inv - bx;
    const dy = (xr[q + 1]! - anchor[1]) * inv - by;
    const dz = (xr[q + 2]! - anchor[2]) * inv - bz;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  // The hull lies within half a unit of the anchor.
  const hull = mag(bx, by, bz) + 0.5;
  pose.bounds[0] = bx;
  pose.bounds[1] = by;
  pose.bounds[2] = bz;
  pose.bounds[3] = Math.max(Math.sqrt(r2), hull) + 0.15;
}
