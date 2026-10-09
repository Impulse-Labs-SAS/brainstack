import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import { CLAW_FINGERS, GRIP_SLOTS, SLOT_TENTACLE, TENTACLES, TENTACLE_SPECS } from './anatomy';
import {
  CHAIN_MAX_STEPS,
  SOLID_FIRST,
  TIP_FREE,
  TIP_PINNED,
  TIP_SOFT,
  coneLimit,
  copyBodyPose,
  createBodyPose,
  createChain,
  relaxChain,
  resampleChain,
  resetChain,
  stepChain,
  tipOf,
  writeSegments,
  type BodyPose,
  type ChainDrive,
  type ChainSettings,
  type ChainState,
} from './chain';
import { springStep } from './body';
import { createPose } from './pose';
import { makeRig, type Rig } from './rig';
import { TIERS, type Tier } from './tiers';
import type { ThreadSolid } from '../threads';
import type { Vec3 } from '../vec';

const UNIT = 26;

function settings(tier: Tier = 3, over: Partial<ChainSettings> = {}): ChainSettings {
  const t = TIERS[tier];
  return {
    iterations: t.iterations,
    maxSteps: CHAIN_MAX_STEPS,
    collide: t.collide,
    restStiffness: 1,
    coneScale: 1,
    dragScale: 1,
    waveAmplitude: 1,
    waveFrequency: 1,
    waveLength: 1,
    maxStretchScale: 1,
    recoil: 1,
    ...over,
  };
}

interface Harness {
  rig: Rig;
  c: ChainState;
  d: ChainDrive;
  s: ChainSettings;
  time: number;
  /** Move the body to `p` over one frame of `dt` and step. */
  frame(dt: number, p?: Vec3): void;
}

function harness(tier: Tier = 3, over: Partial<ChainSettings> = {}, at: Vec3 = [0, 0, 0]): Harness {
  const rig = makeRig(tier, UNIT);
  const c = createChain(rig);
  const body0 = createBodyPose();
  const body1 = createBodyPose();
  body1.p = [...at];
  copyBodyPose(body1, body0);
  resetChain(c, rig, body1);
  const d: ChainDrive = {
    body0,
    body1,
    time: 0,
    dt: 0,
    mode: new Uint8Array(TENTACLES),
    target: new Float32Array(TENTACLES * 3),
    gain: new Float32Array(TENTACLES),
  };
  const h: Harness = {
    rig,
    c,
    d,
    s: settings(tier, over),
    time: 0,
    frame(dt, p) {
      copyBodyPose(d.body1, d.body0);
      if (p) d.body1.p = [...p];
      h.time += dt;
      d.time = h.time;
      d.dt = dt;
      stepChain(h.c, rig, d, h.s);
    },
  };
  return h;
}

/** A body-frame point, creature units, in the world for a pose. */
function world(pose: BodyPose, v: readonly number[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = pose.p[i]! + (pose.s[i]! * v[0]! + pose.u[i]! * v[1]! + pose.f[i]! * v[2]!) * UNIT;
  }
  return out;
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

function setTarget(d: ChainDrive, i: number, mode: number, p: Vec3, gain = 0.3) {
  d.mode[i] = mode;
  d.target.set(p, i * 3);
  d.gain[i] = gain;
}

/** Pin every gripper below the body, explorers reaching ahead: a busy pose. */
function busy(h: Harness) {
  GRIP_SLOTS.forEach((slot, s) => {
    setTarget(h.d, SLOT_TENTACLE[s]!, TIP_PINNED, world(h.d.body1, slot.natural));
  });
  setTarget(h.d, 12, TIP_SOFT, world(h.d.body1, [-0.4, -0.5, 1.8]));
  setTarget(h.d, 13, TIP_SOFT, world(h.d.body1, [0.4, -0.5, 2.6]));
}

/** A ball `radius` round `centre`, as a body. */
function ball(centre: Vec3, radius: number): ThreadSolid {
  return {
    across: 2 * radius,
    distance(x, y, z, n) {
      const d = [x - centre[0], y - centre[1], z - centre[2]];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      n[0] = d[0]! / l;
      n[1] = d[1]! / l;
      n[2] = d[2]! / l;
      return l - radius;
    },
  };
}

/** A box of half extents `half` about `centre`, square to the world's axes, its edges rounded by `round`. */
function bar(centre: Vec3, half: Vec3, round: number): ThreadSolid {
  return {
    across: 2 * Math.hypot(half[1], half[2]),
    distance(x, y, z, n) {
      const p = [x - centre[0], y - centre[1], z - centre[2]];
      const q = p.map((v, k) => Math.abs(v) - (half[k]! - round));
      const o = q.map((v) => Math.max(v, 0));
      const out = Math.hypot(o[0]!, o[1]!, o[2]!);
      if (out > 0) {
        for (let k = 0; k < 3; k++) n[k] = (Math.sign(p[k]!) * o[k]!) / out;
        return out - round;
      }
      const k = q.indexOf(Math.max(...q));
      n[0] = n[1] = n[2] = 0;
      n[k] = p[k]! < 0 ? -1 : 1;
      return q[k]! - round;
    },
  };
}

function segmentAngles(c: ChainState, rig: Rig, i: number): number[] {
  const out: number[] = [];
  const j0 = rig.jointStart[i]!;
  for (let j = 1; j < rig.segments[i]!; j++) {
    const a = (j0 + j - 1) * 3;
    const b = a + 3;
    const e = b + 3;
    const u: Vec3 = [c.xr[b]! - c.xr[a]!, c.xr[b + 1]! - c.xr[a + 1]!, c.xr[b + 2]! - c.xr[a + 2]!];
    const v: Vec3 = [c.xr[e]! - c.xr[b]!, c.xr[e + 1]! - c.xr[b + 1]!, c.xr[e + 2]! - c.xr[b + 2]!];
    const cos =
      (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) /
      (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]));
    out.push(Math.acos(Math.max(-1, Math.min(1, cos))));
  }
  return out;
}

describe('the Sentinel’s chains', () => {
  it('keeps every segment exactly its length after the final pass', () => {
    const h = harness();
    busy(h);
    const pose = createPose();
    let length = 0;
    let gap = 0;
    for (let f = 0; f < 120; f++) {
      h.frame(1 / 60, [f * 0.05 * UNIT, Math.sin(f / 9) * 0.3 * UNIT, 0]);
      writeSegments(h.c, h.rig, h.d.body1.p, pose);
      for (let i = 0; i < TENTACLES; i++) {
        const j0 = h.rig.jointStart[i]!;
        for (let j = 0; j < h.rig.segments[i]!; j++) {
          const a = (j0 + j) * 3;
          const l = dist(h.c.xr.subarray(a, a + 3), h.c.xr.subarray(a + 3, a + 6));
          const want = h.rig.segLength[h.rig.segStart[i]! + j]! * h.c.stretch[i]!;
          length = Math.max(length, Math.abs(l - want) / UNIT);
          // Drawn rigid: each segment ends where the next begins.
          if (j + 1 < h.rig.segments[i]!) {
            const o = (h.rig.segStart[i]! + j) * 16;
            const m = pose.segmentMatrices;
            for (let k = 0; k < 3; k++) {
              gap = Math.max(gap, Math.abs(m[o + 12 + k]! + m[o + 4 + k]! - m[o + 16 + 12 + k]!));
            }
          }
        }
      }
    }
    expect(length).toBeLessThan(1e-3);
    expect(gap).toBeLessThan(1e-3);
  });

  it('holds the tip on a grip while the body moves', () => {
    const h = harness();
    const i = SLOT_TENTACLE[3]!;
    const grip = world(h.d.body1, GRIP_SLOTS[3]!.natural);
    setTarget(h.d, i, TIP_PINNED, grip);
    // Landed: a moment for the arm to settle on the thread, then the body moves on.
    for (let f = 0; f < 15; f++) h.frame(1 / 60);
    let worst = 0;
    for (let f = 0; f < 90; f++) {
      h.frame(1 / 60, [f * 0.006 * UNIT, 0, f * 0.004 * UNIT]);
      worst = Math.max(worst, dist(tipOf(h.c, h.rig, i, [0, 0, 0]), grip));
    }
    expect(worst / UNIT).toBeLessThan(0.02);
  });

  it('never bends a joint past its soft limit by more than a little', () => {
    const h = harness();
    busy(h);
    for (let f = 0; f < 30; f++) h.frame(1 / 60);
    // The body darts between points around its grips on the spring it really
    // moves on, a new point every 0.3 s.
    const p: Vec3 = [0, 0, 0];
    const v: Vec3 = [0, 0, 0];
    const random = seededRandom(5);
    let goal: Vec3 = [0, 0, 0];
    let worst = 0;
    for (let f = 0; f < 360; f++) {
      if (f % 18 === 0) goal = [0, 1, 2].map(() => (random() - 0.5) * 1.2 * UNIT) as Vec3;
      springStep(p, v, goal, 12, 1 / 60);
      h.frame(1 / 60, p);
      for (let i = 0; i < TENTACLES; i++) {
        const limit = coneLimit(h.rig.segments[i]!);
        for (const a of segmentAngles(h.c, h.rig, i)) worst = Math.max(worst, a - limit);
      }
    }
    expect(worst).toBeLessThan((6 * Math.PI) / 180);
  });

  it('trails behind a moving body and catches up when it stops', () => {
    const h = harness(3, { waveAmplitude: 0 });
    const i = 2; // a crown tentacle that is not a gripper
    expect(TENTACLE_SPECS[i]!.role).toBe('crown');
    const restTip = (): Vec3 => {
      const t = tipOf(h.c, h.rig, i, [0, 0, 0]);
      return [t[0] - h.d.body1.p[0], t[1] - h.d.body1.p[1], t[2] - h.d.body1.p[2]];
    };
    for (let f = 0; f < 60; f++) h.frame(1 / 60);
    const atRest = restTip();
    let lagged = 0;
    let z = 0;
    for (let f = 0; f < 60; f++) {
      z += (4.5 * UNIT) / 60;
      h.frame(1 / 60, [0, 0, z]);
      lagged = Math.max(lagged, atRest[2] - restTip()[2]);
    }
    for (let f = 0; f < 150; f++) h.frame(1 / 60);
    expect(lagged / UNIT).toBeGreaterThan(0.05);
    expect(dist(restTip(), atRest) / UNIT).toBeLessThan(0.02);
  });

  it('draws an arm as smoothly at 125 and 144 Hz as at 60, though some frames take no step', () => {
    /**
     * How sharply a free tip's drawn path bends from frame to frame while the
     * body walks steadily, scaled to a 60 Hz frame: a smooth path bends with
     * the square of the frame's length.
     */
    const bend = (hz: number) => {
      const h = harness();
      const tips: Vec3[] = [];
      let idle = 0;
      let z = 0;
      for (let f = 0; f < 3 * hz; f++) {
        z += (4.5 * UNIT) / hz;
        const before = h.c.acc;
        h.frame(1 / hz, [0, 0, z]);
        // No step this frame: the time only went into the accumulator.
        if (Math.abs(h.c.acc - before - 1 / hz) < 1e-9) idle++;
        tips.push(tipOf(h.c, h.rig, 2, [0, 0, 0]));
      }
      let sum = 0;
      let n = 0;
      // From the second second on, once the arm trails at a steady distance.
      for (let f = hz; f + 1 < tips.length; f++) {
        const [a, b, c] = [tips[f - 1]!, tips[f]!, tips[f + 1]!];
        sum += Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]);
        n++;
      }
      return { bend: (sum / n / UNIT) * (hz / 60) ** 2, idle };
    };
    const steady = bend(60).bend;
    for (const hz of [125, 144]) {
      const { bend: b, idle } = bend(hz);
      expect(idle).toBeGreaterThan(5);
      expect(b).toBeLessThan(2 * steady);
    }
  });

  it('keeps the tentacles in real time at 30 frames a second, at every tier', () => {
    // Steps a frame cannot take are dropped, and a dropped step slows the arm
    // down: it would trail a moving body further than at 60.
    const lag = (tier: Tier, fps: number) => {
      const h = harness(tier, { waveAmplitude: 0 });
      const i = 2;
      for (let f = 0; f < fps; f++) h.frame(1 / fps);
      const rest = tipOf(h.c, h.rig, i, [0, 0, 0])[2];
      let z = 0;
      let worst = 0;
      for (let f = 0; f < fps; f++) {
        z += (4.5 * UNIT) / fps;
        h.frame(1 / fps, [0, 0, z]);
        worst = Math.max(worst, rest + z - tipOf(h.c, h.rig, i, [0, 0, 0])[2]);
      }
      return worst / UNIT;
    };
    for (const tier of [0, 3] as const) {
      expect(lag(tier, 30)).toBeLessThan(1.2 * lag(tier, 60));
    }
  });

  it('stays finite after a 64 ms frame and after the body jumps', () => {
    const h = harness();
    busy(h);
    for (let f = 0; f < 30; f++) h.frame(0.064, [f * 0.4 * UNIT, 0, 0]);
    h.frame(0.064, [5000, -3000, 800]);
    for (let f = 0; f < 10; f++) h.frame(0.064, [5000, -3000, 800]);
    expect(h.c.xr.every(Number.isFinite)).toBe(true);
    expect(h.c.x.every(Number.isFinite)).toBe(true);
    const pose = createPose();
    writeSegments(h.c, h.rig, h.d.body1.p, pose);
    expect(pose.segmentMatrices.every(Number.isFinite)).toBe(true);
    expect(pose.bounds.every(Number.isFinite)).toBe(true);
  });

  it('moves no two tentacles alike', () => {
    const h = harness();
    const tracks: number[][] = Array.from({ length: TENTACLES }, () => []);
    for (let f = 0; f < 600; f++) {
      h.frame(1 / 60, [Math.sin(f / 50) * 0.2 * UNIT, 0, 0]);
      if (f < 60) continue;
      for (let i = 0; i < TENTACLES; i++) {
        const t = tipOf(h.c, h.rig, i, [0, 0, 0]);
        tracks[i]!.push(t[0] - h.d.body1.p[0], t[1] - h.d.body1.p[1], t[2] - h.d.body1.p[2]);
      }
    }
    const centred = tracks.map((tr) => {
      const mean = [0, 1, 2].map(
        (k) => tr.filter((_, n) => n % 3 === k).reduce((a, b) => a + b, 0) / (tr.length / 3),
      );
      return tr.map((v, n) => v - mean[n % 3]!);
    });
    let most = -1;
    for (let a = 0; a < TENTACLES; a++) {
      for (let b = a + 1; b < TENTACLES; b++) {
        const A = centred[a]!;
        const B = centred[b]!;
        let ab = 0;
        let aa = 0;
        let bb = 0;
        for (let n = 0; n < A.length; n++) {
          ab += A[n]! * B[n]!;
          aa += A[n]! * A[n]!;
          bb += B[n]! * B[n]!;
        }
        most = Math.max(most, ab / Math.sqrt(aa * bb));
      }
    }
    expect(most).toBeLessThan(0.9);
  });

  it('telescopes to reach a far target, in clicks, never past its limit', () => {
    const h = harness();
    const explorer = 12;
    const crown = SLOT_TENTACLE[0]!;
    setTarget(h.d, explorer, TIP_SOFT, world(h.d.body1, [0, -0.5, 4]));
    setTarget(h.d, crown, TIP_PINNED, world(h.d.body1, [-3, -0.5, 0]));
    let most = 0;
    for (let f = 0; f < 120; f++) {
      h.frame(1 / 60);
      for (const i of [explorer, crown]) {
        expect(h.c.stretch[i]!).toBeLessThanOrEqual(h.rig.maxStretch[i]! + 1e-6);
        const clicks = (h.c.stretchGoal[i]! - 1) / 0.04;
        expect(
          Math.abs(clicks - Math.round(clicks)) < 1e-4 ||
            h.c.stretchGoal[i] === h.rig.maxStretch[i],
        ).toBe(true);
      }
      most = Math.max(most, h.c.stretch[explorer]!);
    }
    // The far target is out of reach: the explorer slides all the way out.
    expect(most).toBeCloseTo(h.rig.maxStretch[explorer]!, 3);
    expect(h.c.stretch[crown]!).toBeCloseTo(h.rig.maxStretch[crown]!, 3);
  });

  it('writes matrices three.js reads the same way', () => {
    const h = harness();
    busy(h);
    for (let f = 0; f < 30; f++) h.frame(1 / 60, [f * 0.03 * UNIT, 0, 0]);
    const pose = createPose();
    const anchor: Vec3 = [...h.d.body1.p];
    writeSegments(h.c, h.rig, anchor, pose);
    const check = (m: Float32Array, o: number) => {
      const col = (k: number) => new Vector3(m[o + k * 4]!, m[o + k * 4 + 1]!, m[o + k * 4 + 2]!);
      const [x, y, z] = [col(0), col(1), col(2)];
      const scale = new Vector3(x.length(), y.length(), z.length());
      const basis = new Matrix4().makeBasis(
        x.clone().normalize(),
        y.clone().normalize(),
        z.clone().normalize(),
      );
      const q = new Quaternion().setFromRotationMatrix(basis);
      const composed = new Matrix4().compose(
        new Vector3(m[o + 12], m[o + 13], m[o + 14]),
        q,
        scale,
      );
      for (let k = 0; k < 16; k++)
        expect(Math.abs(composed.elements[k]! - m[o + k]!)).toBeLessThan(1e-5);
    };
    for (let s = 0; s < pose.segments; s += 7) check(pose.segmentMatrices, s * 16);
    for (let f = 0; f < pose.claws; f += 5) check(pose.clawMatrices, f * 16);
    // The first segment of a tentacle starts at its socket, in creature space.
    const i = 4;
    const o = h.rig.segStart[i]! * 16;
    const socket = world(h.d.body1, Array.from(h.rig.socket.subarray(i * 3, i * 3 + 3)));
    for (let k = 0; k < 3; k++) {
      expect(pose.segmentMatrices[o + 12 + k]!).toBeCloseTo((socket[k]! - anchor[k]!) / UNIT, 4);
    }
  });

  it('turns every claw finger to hook in toward its arm', () => {
    const h = harness();
    busy(h);
    for (let f = 0; f < 30; f++) h.frame(1 / 60, [f * 0.03 * UNIT, 0, 0]);
    const pose = createPose();
    writeSegments(h.c, h.rig, h.d.body1.p, pose);
    const m = pose.segmentMatrices;
    const cm = pose.clawMatrices;
    const unit = (x: number, y: number, z: number): Vec3 => {
      const l = Math.hypot(x, y, z);
      return [x / l, y / l, z / l];
    };
    let worst = 1;
    for (let i = 0; i < TENTACLES; i++) {
      const last = (h.rig.segStart[i]! + h.rig.segments[i]! - 1) * 16;
      const along = unit(m[last + 4]!, m[last + 5]!, m[last + 6]!);
      const base: Vec3 = [m[last + 12]!, m[last + 13]!, m[last + 14]!];
      for (let k = 0; k < CLAW_FINGERS; k++) {
        const o = (i * CLAW_FINGERS + k) * 16;
        // Out from the arm's axis to the finger's hinge.
        const r: Vec3 = [cm[o + 12]! - base[0], cm[o + 13]! - base[1], cm[o + 14]! - base[2]];
        const t = r[0] * along[0] + r[1] * along[1] + r[2] * along[2];
        const out = unit(r[0] - along[0] * t, r[1] - along[1] * t, r[2] - along[2] * t);
        // The talon hooks toward its −x (geometry.ts): x must point away from the axis.
        const x = unit(cm[o]!, cm[o + 1]!, cm[o + 2]!);
        worst = Math.min(worst, x[0] * out[0] + x[1] * out[1] + x[2] * out[2]);
      }
    }
    expect(worst).toBeGreaterThan(0.8);
  });

  it('gives the same still pose for the same input, whatever came before', () => {
    const settle = (history: boolean) => {
      const h = harness(3, {}, [100, 20, -40]);
      if (history) {
        busy(h);
        for (let f = 0; f < 50; f++) h.frame(1 / 60, [100 + f, 20, -40]);
        h.d.body1.p = [100, 20, -40];
        resetChain(h.c, h.rig, h.d.body1);
      }
      h.d.mode.fill(TIP_FREE);
      busy(h);
      h.d.time = history ? 123 : 0;
      relaxChain(h.c, h.rig, h.d, h.s, 40);
      return h.c.xr;
    };
    const a = settle(false);
    const b = settle(true);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('moves exactly as it would without a body when it meets none', () => {
    const far = ball([1e6, 1e6, 1e6], UNIT);
    for (const fps of [24, 60, 144]) {
      const run = (solid: ThreadSolid | null | 'absent') => {
        const h = harness();
        busy(h);
        if (solid !== 'absent') h.d.solid = solid;
        for (let f = 0; f < 3 * fps; f++) {
          const t = f / fps;
          h.frame(1 / fps, [Math.sin(t) * 0.4 * UNIT, 0, t * 0.5 * UNIT]);
        }
        const stepped = [Array.from(h.c.x), Array.from(h.c.xp), Array.from(h.c.xr)];
        relaxChain(h.c, h.rig, h.d, h.s, 8);
        return [...stepped, Array.from(h.c.x), Array.from(h.c.xr)];
      };
      const plain = run('absent');
      expect(run(null)).toEqual(plain);
      expect(run(far)).toEqual(plain);
    }
  });

  it('keeps every arm out of a body: pressed on it and swept across it, every segment its length', () => {
    // A bar across the body's underside, along its right, where the middle
    // arms hang through it: the right one pinned on its top, a claw's
    // clearance out, the left one hanging, while the body is lowered onto it
    // from where no arm reaches it, then sways over it and bobs.
    const top = -0.405 * UNIT;
    const solid = bar(
      [0, -0.45 * UNIT, 0],
      [1.4 * UNIT, 0.045 * UNIT, 0.035 * UNIT],
      0.0175 * UNIT,
    );
    const n: Vec3 = [0, 0, 0];
    const away = (x: Float32Array, q: number) => solid.distance(x[q]!, x[q + 1]!, x[q + 2]!, n);
    const pinned = SLOT_TENTACLE[1]!;
    const run = (fps: number, withSolid: boolean) => {
      const h = harness(3, {}, [0, 1.2 * UNIT, 0]);
      if (withSolid) h.d.solid = solid;
      const target: Vec3 = [GRIP_SLOTS[1]!.natural[0] * UNIT, top + 0.042 * UNIT, 0];
      setTarget(h.d, pinned, TIP_PINNED, target);
      // As shares of each joint's tube: the solved and the drawn joints the
      // body keeps out, and the centre of every drawn joint but the claw's.
      let solved = Infinity;
      let drawn = Infinity;
      let centre = Infinity;
      let pin = 0;
      let length = 0;
      let finite = true;
      for (let f = 0; f < 4 * fps; f++) {
        const t = f / fps;
        const p: Vec3 = [
          Math.sin(1.3 * t) * 0.15 * UNIT,
          (Math.sin(2.9 * t) * 0.04 + Math.max(0, 1 - t) * 1.2) * UNIT,
          Math.sin(1.7 * t) * 0.15 * UNIT,
        ];
        h.frame(1 / fps, p);
        finite &&= h.c.x.every(Number.isFinite) && h.c.xr.every(Number.isFinite);
        for (let i = 0; i < TENTACLES; i++) {
          const M = h.rig.segments[i]!;
          const j0 = h.rig.jointStart[i]!;
          const sg0 = h.rig.segStart[i]!;
          const last = i === pinned ? M - 2 : M;
          for (let j = 1; j <= M; j++) {
            const q = (j0 + j) * 3;
            const r = h.rig.segRadius[sg0 + j - 1]!;
            if (j >= SOLID_FIRST && j <= last) {
              solved = Math.min(solved, away(h.c.x, q) / r);
              drawn = Math.min(drawn, away(h.c.xr, q) / r);
            }
            if (j <= last) centre = Math.min(centre, away(h.c.xr, q) / r);
            const a = q - 3;
            const l = dist(h.c.xr.subarray(a, a + 3), h.c.xr.subarray(q, q + 3));
            const want = h.rig.segLength[sg0 + j - 1]! * h.c.stretch[i]!;
            length = Math.max(length, Math.abs(l / want - 1));
          }
        }
        // Once the body has come down and the arm has taken the bar.
        if (t >= 1.5) {
          pin = Math.max(pin, dist(tipOf(h.c, h.rig, pinned, [0, 0, 0]), target) / UNIT);
        }
      }
      return { solved, drawn, centre, pin, length, finite };
    };
    for (const fps of [24, 60, 144]) {
      const free = run(fps, false);
      // Without it, the arms would pass through it: the check means something.
      expect(free.solved).toBeLessThan(-0.5);
      const kept = run(fps, true);
      expect(kept.finite).toBe(true);
      expect(kept.solved).toBeGreaterThan(0.8);
      expect(kept.drawn).toBeGreaterThan(0.8);
      expect(kept.centre).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(0.01);
      // The claw on the bar's surface holds as well as it does with nothing there.
      expect(kept.pin).toBeLessThan(free.pin + 1e-3);
    }
  });

  it('draws an arm that runs straight into a body turned out of it, every segment its length', () => {
    // The solved arm straight along its socket's axis, into a slab square to
    // it: the drawn chain follows it in. Pushed out along the slab's normal —
    // back along the segment — and put back at its length, a joint lands
    // where it was; it must turn about the joint before instead.
    const h = harness(3);
    const { rig, c, d } = h;
    const i = 12;
    const M = rig.segments[i]!;
    const j0 = rig.jointStart[i]!;
    const sg0 = rig.segStart[i]!;
    const k3 = i * 3;
    const axis: Vec3 = [c.axis[k3]!, c.axis[k3 + 1]!, c.axis[k3 + 2]!];
    const along: number[] = [0];
    for (let j = 0; j < M; j++) along.push(along[j]! + rig.segLength[sg0 + j]!);
    for (let j = 0; j <= M; j++) {
      for (let e = 0; e < 3; e++) c.x[(j0 + j) * 3 + e] = c.root[k3 + e]! + axis[e]! * along[j]!;
    }
    c.xp.set(c.x);
    // Its near face a tube and a fifth past joint 7: joint 8 lies well inside.
    const near = along[7]! + 1.2 * rig.segRadius[sg0 + 6]!;
    const deep = UNIT;
    const middle = [0, 1, 2].map((e) => c.root[k3 + e]! + axis[e]! * (near + deep / 2));
    const slab: ThreadSolid = {
      across: deep,
      distance(x, y, z, n) {
        const s =
          (x - middle[0]!) * axis[0] + (y - middle[1]!) * axis[1] + (z - middle[2]!) * axis[2];
        for (let e = 0; e < 3; e++) n[e] = (s < 0 ? -1 : 1) * axis[e]!;
        return Math.abs(s) - deep / 2;
      },
    };
    d.solid = slab;
    d.dt = 0;
    // No step: only the drawn chain is built, from the solved one as it lies.
    stepChain(c, rig, d, h.s);
    const n: Vec3 = [0, 0, 0];
    for (let j = 1; j <= M; j++) {
      const q = (j0 + j) * 3;
      const l = dist(c.xr.subarray(q - 3, q), c.xr.subarray(q, q + 3));
      expect(
        Math.abs(l / (rig.segLength[sg0 + j - 1]! * c.stretch[i]!) - 1),
        `segment ${j}`,
      ).toBeLessThan(1e-5);
      if (j < SOLID_FIRST) continue;
      const out = slab.distance(c.xr[q]!, c.xr[q + 1]!, c.xr[q + 2]!, n);
      expect(out / rig.segRadius[sg0 + j - 1]!, `joint ${j}`).toBeGreaterThan(0.99);
    }
  });

  it('changes tier without a pop', () => {
    const h = harness(3);
    busy(h);
    for (let f = 0; f < 30; f++) h.frame(1 / 60);
    const before = Array.from({ length: TENTACLES }, (_, i) => tipOf(h.c, h.rig, i, [0, 0, 0]));
    const rig = makeRig(0, UNIT);
    const c = resampleChain(h.c, h.rig, rig);
    expect(c.x.length).toBe(rig.joints * 3);
    for (let i = 0; i < TENTACLES; i++) {
      expect(dist(tipOf(c, rig, i, [0, 0, 0]), before[i]!) / UNIT).toBeLessThan(0.02);
    }
  });
});
