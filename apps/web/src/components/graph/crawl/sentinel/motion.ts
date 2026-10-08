// The Sentinel in motion: everything that turns a replay into one frame of the
// creature. It reads the replay through ReplayView — where the walk is, what
// each grip slot holds, what it reaches for — and writes a SentinelPose, the
// only thing the renderer reads.
//
// It decides nothing the crawl shows elsewhere. Which threads are held and lit
// is the replay's; here a gripper only goes where its slot says, an explorer
// leads where the walk goes, and the light on a tentacle is only the fresh
// light of the thread it holds. Two runs of the same replay, at any frame rate
// and at any tier, light the same threads whether this is drawn or not.
//
// Each tentacle has one duty a frame:
// - The six grippers follow their slots: pinned where it holds, swinging on an
//   arc to the next hold, hanging toward the slot's natural point when free.
// - The two explorers lead along the walk, the first a little ahead of the
//   cursor, the second a beat behind; across a gap they feel for the far note,
//   tapping, and once they touch it they hold on and are hauled across. While
//   it pauses they point at where it goes next.
// - Reaches go to the free crown tentacle that faces the note best; a named
//   note is tapped from two sides.
// - The rest of the crown rests and sways.
//
// Under reduced motion ("still") nothing animates: no wave, hum, breath or
// pulse, the body sits at its goal and the chains are only re-settled, a few
// passes a frame, so tips stay on threads the layout is still moving.

import { hash01 } from '@/lib/graph-model';

import type { Hold, ReplayEvent, ReplayView, Swing } from '../replay-view';
import { legPoint } from '../threads';
import { cross, dist, dot, type Vec3 } from '../vec';

import {
  BODY_SCALE,
  EYE,
  GRIP_SLOTS,
  HOVER,
  HULL,
  SLOT_TENTACLE,
  TENTACLES,
  TENTACLE_SPECS,
} from './anatomy';
import {
  bodyGoal,
  createBody,
  createGoal,
  hullAxes,
  snapBody,
  stepBody,
  trackCursor,
  type BodyParams,
} from './body';
import {
  CHAIN_MAX_STEPS,
  TIP_FREE,
  TIP_PINNED,
  TIP_SOFT,
  copyBodyPose,
  createBodyPose,
  createChain,
  relaxChain,
  resampleChain,
  resetChain,
  stepChain,
  writeSegments,
  type ChainDrive,
  type ChainSettings,
  type ChainState,
} from './chain';
import { createEye, hum, stepEye, type EyeCue, type EyeParams } from './eye';
import { PERCH_BACK, PERCH_UP } from './grips';
import { createPose, type SentinelPose } from './pose';
import { SENTINEL_SEED, makeRig, type Rig } from './rig';
import { MAX_SEGMENTS, TIERS, type Tier } from './tiers';

/** Everything the lab tunes. Distances are in creature units (multiples of the vault's typical link). */
export interface MotionParams extends BodyParams, EyeParams {
  /**
   * The hull and its collar against the tentacles: 1 is the anatomy as
   * written. Above it the body reads as the mass the crown hangs from, not a
   * knot where the legs meet.
   */
  bodyScale: number;
  /** Scale the tentacles' travelling wave. */
  waveAmplitude: number;
  waveFrequency: number;
  waveLength: number;
  /** Scales every tentacle's drag time: more lag behind the body. */
  dragScale: number;
  /** Scales how firmly tentacles return to their rest shape. */
  restStiffness: number;
  /** Scales every joint's cone. */
  coneLimitScale: number;
  /** Scales how far any tentacle telescopes. */
  maxStretchScale: number;
  /** How far ahead of the cursor the leading explorer reaches. */
  explorerLead: number;
  /** Scales the kick, roll and stiffening of a tentacle letting go. */
  recoil: number;
  /** The machine's hum on the body, creature units. */
  humAmplitude: number;
  /** Plate expansion of the slow breath, creature units, and the body's slow bob. */
  breathing: number;
  bob: number;
  /** The camera follows from this many units away. */
  followDistance: number;
}

export const DEFAULT_MOTION: MotionParams = {
  hover: HOVER,
  omegaPos: 12,
  omegaTurn: 7,
  bankLimit: 0.42,
  surge: 0.03,
  leadMax: 0.9,
  perchUp: PERCH_UP,
  perchBack: PERCH_BACK,
  voidLift: 0.25,
  // Tuned in the lab ("option A"): a lighter body under a crown that sways
  // wide and slow, trails loosely and goes limp between grips, which is what
  // made the tentacles read as alive rather than animated. Body scale and
  // telescoping were tuned with them and live in anatomy.ts, where the grip
  // planner reads them too.
  bodyScale: BODY_SCALE,
  waveAmplitude: 1.95,
  waveFrequency: 0.65,
  waveLength: 1,
  dragScale: 0.25,
  restStiffness: 0.1,
  coneLimitScale: 1.45,
  maxStretchScale: 1,
  explorerLead: 1.5,
  recoil: 1.6,
  humAmplitude: 0,
  breathing: 0,
  bob: 0,
  eyeBase: 0.55,
  eyePulse: 0.07,
  eyeFlare: 1,
  eyeStill: 0.7,
  followDistance: 8,
};

/** The two explorers. */
const EXPLORER_A = 12;
const EXPLORER_B = 13;
/** Crown tentacles that serve no grip slot: the ones that reach and rest. */
const FREE_CROWN = TENTACLE_SPECS.flatMap((t, i) => (t.role === 'crown' ? [i] : []));
/** A reach stretches out over this long, then holds its note until this long after it set out. */
const REACH_OUT = 0.4;
const REACH_HOLD = 1.4;
/** Swings lift off the thread this high at their middle, creature units. */
const SWING_LIFT = 0.25;
/** Palpating a gap: a tap this long, creature units, this often, seconds. */
const TAP = 0.15;
const TAP_EVERY = 0.25;
const DEG = Math.PI / 180;

const v3 = (): Vec3 => [0, 0, 0];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

export class SentinelMotion {
  params: MotionParams;
  readonly pose: SentinelPose = createPose();
  /** The body's world position: what the camera follows. */
  readonly bodyWorld: Vec3 = [0, 0, 0];
  /** For the lab's overlay, in creature space like the pose: every drawn joint, and each tentacle's target. */
  readonly debug = {
    joints: new Float32Array((MAX_SEGMENTS + TENTACLES) * 3),
    jointCount: 0,
    targets: new Float32Array(TENTACLES * 3),
  };

  private readonly seed: number;
  private tier: Tier = 2;
  private rig: Rig | null = null;
  private chain: ChainState | null = null;
  private readonly body = createBody();
  private readonly goal = createGoal();
  private readonly eye = createEye();
  /** The hull's pose last frame and this frame, hum and breath included: the roots ride it. */
  private readonly before = createBodyPose();
  private readonly now = createBodyPose();
  private readonly drive: ChainDrive = {
    body0: this.before,
    body1: this.now,
    time: 0,
    dt: 0,
    mode: new Uint8Array(TENTACLES),
    target: new Float32Array(TENTACLES * 3),
    gain: new Float32Array(TENTACLES),
  };
  private readonly settings: ChainSettings = {
    iterations: 1,
    maxSteps: 1,
    collide: false,
    restStiffness: 1,
    coneScale: 1,
    dragScale: 1,
    waveAmplitude: 1,
    waveFrequency: 1,
    waveLength: 1,
    maxStretchScale: 1,
    recoil: 1,
  };
  /** What the current leg or pause has settled: kept until the replay moves on. */
  private phase = '';
  private contactClock: number | null = null;
  private touched = false;
  private touchNow = false;
  private reachers: Array<number[] | undefined> = [];
  /** Where the eye is drawn this frame, world space; null looks ahead. */
  private lookAt: Vec3 | null = null;
  private readonly lookPoint = v3();

  constructor(params: Partial<MotionParams> = {}, seed = SENTINEL_SEED) {
    this.params = { ...DEFAULT_MOTION, ...params };
    this.seed = seed;
  }

  /** Change the detail; the chains are re-cut by arc length, so nothing jumps. */
  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    if (!this.rig || !this.chain) return;
    const rig = makeRig(tier, this.rig.unit, this.seed, this.rig.bodyScale);
    this.chain = resampleChain(this.chain, this.rig, rig);
    this.rig = rig;
  }

  /** One frame. `dt` and `time` are real seconds: the creature lives on while the replay is paused. */
  step(
    view: ReplayView,
    events: readonly ReplayEvent[],
    dt: number,
    time: number,
    still: boolean,
  ): void {
    if (!(view.unit > 0)) return;
    const frame = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    const { rig, chain } = this.ensureRig(view.unit);
    this.follow(view);
    for (const ev of events) if (ev.kind === 'contact') this.contactClock = ev.clock;

    trackCursor(this.body, view, frame);
    this.aimBody(view, still);
    // Still, the body is placed at its goal every frame; only a real jump starts the chains over.
    const far = !this.body.ready || dist(this.goal.p, this.body.goal) > 3 * view.unit;
    const snapped = stepBody(this.body, this.goal, view.unit, frame, this.params, still);
    const jumped = still ? far : snapped;
    this.place(time, view.unit, still);
    if (jumped) {
      copyBodyPose(this.now, this.before);
      resetChain(chain, rig, this.now);
    }

    this.duties(view, time, still);
    this.refreshSettings();
    this.drive.time = time;
    this.drive.dt = frame;
    if (still) relaxChain(chain, rig, this.drive, this.settings, jumped ? 40 : 4);
    else stepChain(chain, rig, this.drive, this.settings);

    stepEye(this.eye, this.eyeCue(view), events, this.params, this.seed, time, frame, still);
    this.write(rig, chain, time, still);
    copyBodyPose(this.now, this.before);
  }

  /**
   * The reduced-motion pose: the body perched over where the replay stands,
   * upright, grips pinned, reaches retracted, chains settled for 40 passes
   * with no wave, hum, breath or pulse. The same view gives the same pose,
   * whatever came before.
   */
  finalPose(view: ReplayView): void {
    if (!(view.unit > 0)) return;
    const { rig, chain } = this.ensureRig(view.unit);
    // Nothing the frames before it settled may leak into it.
    this.phase = '';
    this.follow(view);
    this.settle(view, rig, chain, 0, true, 40);
  }

  /** Jump to where the replay is — a replay restarted, a graph rebuilt — at rest, without animating there. */
  snap(view: ReplayView): void {
    if (!(view.unit > 0)) return;
    const { rig, chain } = this.ensureRig(view.unit);
    this.follow(view);
    this.settle(view, rig, chain, 0, false, 8);
  }

  // -- Body ------------------------------------------------------------------------

  private ensureRig(unit: number): { rig: Rig; chain: ChainState } {
    const scale = this.params.bodyScale;
    if (
      !this.rig ||
      !this.chain ||
      Math.abs(this.rig.unit - unit) > unit * 1e-6 ||
      this.rig.bodyScale !== scale
    ) {
      this.rig = makeRig(this.tier, unit, this.seed, scale);
      this.chain = createChain(this.rig);
      this.body.ready = false;
    }
    return { rig: this.rig, chain: this.chain };
  }

  /** A new leg or pause: forget what the last one settled. */
  private follow(view: ReplayView): void {
    const phase = `${view.stepIndex}:${view.mode}`;
    if (phase === this.phase) return;
    this.phase = phase;
    this.contactClock = null;
    this.touched = false;
    this.reachers = [];
  }

  /** The body's goal, and — while it glances before moving — its turn toward where it goes. */
  private aimBody(view: ReplayView, still: boolean): void {
    if (!bodyGoal(view, this.body, this.params, this.goal)) {
      // The notes it needs are gone: hold the last goal.
      for (let i = 0; i < 3; i++) this.goal.p[i] = this.body.goal[i]!;
    }
    const next = this.nextHeading(view);
    if (!still && next && view.dwell) {
      const left = view.dwell.duration - view.dwell.t;
      if (left <= scanWindow(view.dwell.duration)) {
        this.goal.heading = next;
        this.goal.turn = 0.6;
      }
    }
  }

  /** The hull this frame: the body's frame, leaned and banked, plus the hum and a slow bob. */
  private place(time: number, unit: number, still: boolean): void {
    const n = this.now;
    hullAxes(this.body, n.s, n.u, n.f);
    const p = this.params;
    const h = still ? 0 : p.humAmplitude * unit;
    const bob = still ? 0 : p.bob * unit * Math.sin(2 * Math.PI * 0.3 * time + this.seed);
    const hs = h * hum(time, this.seed + 1);
    const hu = h * hum(time, this.seed + 2) + bob;
    const hf = h * 0.5 * hum(time, this.seed + 3);
    for (let i = 0; i < 3; i++) {
      n.p[i] = this.body.p[i]! + n.s[i]! * hs + n.u[i]! * hu + n.f[i]! * hf;
    }
  }

  /** Snap to the view and settle there: the reduced-motion pose, or a fresh start. */
  private settle(
    view: ReplayView,
    rig: Rig,
    chain: ChainState,
    time: number,
    still: boolean,
    passes: number,
  ): void {
    if (!bodyGoal(view, this.body, this.params, this.goal)) {
      for (let i = 0; i < 3; i++) this.goal.p[i] = this.body.goal[i]!;
    }
    snapBody(this.body, this.goal.p, this.goal.heading, this.goal.up);
    this.place(time, view.unit, true);
    copyBodyPose(this.now, this.before);
    resetChain(chain, rig, this.now);
    this.duties(view, time, true);
    this.refreshSettings();
    this.drive.time = time;
    this.drive.dt = 0;
    relaxChain(chain, rig, this.drive, this.settings, passes);
    const eye = this.eyeCue(view);
    if (!still) {
      // Start the eye where it will look, at rest.
      Object.assign(this.eye, createEye());
    }
    stepEye(this.eye, eye, [], this.params, this.seed, time, 0, true);
    if (!still) this.eye.intensity = this.params.eyeBase;
    this.write(rig, chain, time, true);
  }

  // -- Tentacles -------------------------------------------------------------------

  private refreshSettings(): void {
    const t = TIERS[this.tier];
    const p = this.params;
    const s = this.settings;
    s.iterations = t.iterations;
    s.maxSteps = CHAIN_MAX_STEPS;
    s.collide = t.collide;
    s.restStiffness = p.restStiffness;
    s.coneScale = p.coneLimitScale;
    s.dragScale = p.dragScale;
    s.waveAmplitude = p.waveAmplitude;
    s.waveFrequency = p.waveFrequency;
    s.waveLength = p.waveLength;
    s.maxStretchScale = p.maxStretchScale;
    s.recoil = p.recoil;
  }

  /** What every tentacle does this frame, and what glows. */
  private duties(view: ReplayView, time: number, still: boolean): void {
    const chain = this.chain!;
    const d = this.drive;
    d.mode.fill(TIP_FREE);
    d.gain.fill(0);
    chain.glow.fill(0);
    chain.glowFront.fill(0);
    this.touchNow = false;
    this.lookAt = null;

    this.grippers(view);
    const walk =
      view.mode === 'walk' && view.walk && view.walk.segments.length > 0 ? view.walk : null;
    if (walk && walk.void) this.palpate(view, time, still);
    else if (walk) this.lead(view, time, still);
    else if (view.mode === 'dwell' || view.mode === 'walk') this.pointAhead(view, time, still);
    if (!still) this.reach(view, time);
    if (!this.lookAt) this.lookFor(view);
  }

  private set(i: number, mode: number, p: Vec3, gain = 0): void {
    this.drive.mode[i] = mode;
    this.drive.target[i * 3] = p[0];
    this.drive.target[i * 3 + 1] = p[1];
    this.drive.target[i * 3 + 2] = p[2];
    this.drive.gain[i] = gain;
  }

  /** A body-frame point, creature units, in the world. */
  private world(v: readonly number[], out: Vec3): Vec3 {
    const n = this.now;
    const u = this.rig!.unit;
    for (let i = 0; i < 3; i++) {
      out[i] = n.p[i]! + (n.s[i]! * v[0]! + n.u[i]! * v[1]! + n.f[i]! * v[2]!) * u;
    }
    return out;
  }

  private holdPoint(view: ReplayView, hold: Hold | null, out: Vec3): boolean {
    return !!hold && view.field.point(hold.key, hold.u, out);
  }

  /** Grippers: pinned where their slot holds, swinging to the next hold, or hanging free. */
  private grippers(view: ReplayView): void {
    const clock = view.clock;
    const unit = view.unit;
    const chain = this.chain!;
    const from = v3();
    const to = v3();
    for (let s = 0; s < GRIP_SLOTS.length; s++) {
      const i = SLOT_TENTACLE[s]!;
      // The hold now: the slot's, or a swing's that has landed since.
      let held: Hold | null = view.holds[s] ?? null;
      let since = held ? held.since : -Infinity;
      let swing: Swing | null = null;
      for (const sw of view.swings) {
        if (sw.slot !== s || clock < sw.start) continue;
        if (clock < sw.land) {
          if (!swing || sw.start > swing.start) swing = sw;
        } else if (sw.land >= since) {
          held = sw.to;
          since = sw.land;
        }
      }
      const natural = GRIP_SLOTS[s]!.natural;
      if (swing) {
        if (!this.holdPoint(view, swing.from, from)) this.world(natural, from);
        if (!this.holdPoint(view, swing.to, to)) this.world(natural, to);
        const f = clamp01((clock - swing.start) / Math.max(1e-6, swing.land - swing.start));
        const e = 1 - (1 - f) * (1 - f);
        const lift = Math.sin(Math.PI * e) * SWING_LIFT * unit;
        const p: Vec3 = [0, 0, 0];
        for (let k = 0; k < 3; k++)
          p[k] = from[k]! + (to[k]! - from[k]!) * e + this.now.u[k]! * lift;
        this.set(i, TIP_SOFT, p, 0.5);
      } else if (held && this.holdPoint(view, held, to)) {
        this.set(i, TIP_PINNED, to);
        // Only fresh light climbs the arm: what the thread glows above the floor it keeps.
        const lit = view.lit.get(held.key);
        chain.glow[i] = lit ? clamp01((lit.glow - lit.floor) / 1.2) : 0;
        chain.glowFront[i] = (clock - since) / 0.2;
      } else {
        this.set(i, TIP_SOFT, this.world(natural, to), 0.08);
      }
    }
  }

  /** The explorer leading this leg, and the other: rotated from leg to leg by the seed. */
  private explorers(view: ReplayView): [number, number] {
    return hash01(`${this.seed}:${view.stepIndex}`) < 0.5
      ? [EXPLORER_A, EXPLORER_B]
      : [EXPLORER_B, EXPLORER_A];
  }

  /** Walking along threads: the explorers lead, touching the next note first. */
  private lead(view: ReplayView, time: number, still: boolean): void {
    const walk = view.walk!;
    const unit = view.unit;
    const [first, second] = this.explorers(view);
    const ahead = this.params.explorerLead * unit;
    const n = this.now;
    const p = v3();
    const remaining = walk.total - walk.travelled;
    // Steadier, and closer together, as the note comes within reach: both touch it.
    const near = clamp01(remaining / ahead);
    // The second a beat (0.35 s of walking) behind the first, but never less than halfway out.
    const behind = Math.max(0.5 * ahead, ahead - 0.35 * this.body.speed);
    for (const [i, reach, sideways] of [
      [first, ahead, 0],
      [second, behind, 0.4],
    ] as const) {
      const s = walk.travelled + Math.min(reach, remaining);
      if (!legPoint(walk.segments, s, view.field, 0, p)) continue;
      const side = TENTACLE_SPECS[i]!.socket[0] < 0 ? -1 : 1;
      const w = still ? 0 : 0.3 * unit * near;
      const ph = this.seed + i * 1.7;
      const across = sideways * unit * near * side + w * Math.sin(2 * Math.PI * 0.6 * time + ph);
      const up = w * 0.5 * Math.sin(2 * Math.PI * 0.9 * time + ph * 1.3);
      for (let k = 0; k < 3; k++) p[k] = p[k]! + n.s[k]! * across + n.u[k]! * up;
      this.set(i, TIP_SOFT, p, 0.3);
      if (i === first) {
        // A copy: the second explorer's turn reuses `p`.
        for (let k = 0; k < 3; k++) this.lookPoint[k] = p[k]!;
        this.lookAt = this.lookPoint;
        if (remaining <= ahead && !this.touched) {
          // The leading explorer reaches the note ahead: the eye notices.
          this.touched = true;
          this.touchNow = true;
        }
      }
    }
  }

  /** Paused: the explorers point where it goes next, or at the note it reads. */
  private pointAhead(view: ReplayView, time: number, still: boolean): void {
    const field = view.field;
    const at = v3();
    const toward = this.nextNote(view, at) || (view.hereId ? field.node(view.hereId, at) : false);
    if (!toward) return;
    const n = this.now;
    const unit = view.unit;
    const dir = v3();
    for (let k = 0; k < 3; k++) dir[k] = at[k]! - n.p[k]!;
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(l > 1e-9)) return;
    const reach = Math.min(1.3 * unit, l);
    for (const i of [EXPLORER_A, EXPLORER_B]) {
      const side = TENTACLE_SPECS[i]!.socket[0] < 0 ? -1 : 1;
      const sway = still ? 0 : 0.05 * unit * Math.sin(2 * Math.PI * 0.4 * time + i);
      const p = v3();
      for (let k = 0; k < 3; k++) {
        p[k] =
          n.p[k]! +
          n.f[k]! * 0.3 * unit +
          (dir[k]! / l) * reach +
          n.s[k]! * (side * 0.25 * unit + sway) -
          n.u[k]! * 0.15 * unit;
      }
      this.set(i, TIP_SOFT, p, 0.12);
    }
  }

  /**
   * Across a gap: one to three tentacles — explorers first, then the crown
   * tentacle facing the far note — feel for it, tapping; once the crossing
   * touches it they hold on, each a beat after the last, and the body is
   * hauled across on them.
   */
  private palpate(view: ReplayView, time: number, still: boolean): void {
    const walk = view.walk!;
    const unit = view.unit;
    const last = walk.segments[walk.segments.length - 1]!;
    const far = v3();
    if (!view.field.node(last.toId, far)) return;
    const gap = walk.total / unit;
    const count = gap <= 2 ? 1 : gap <= 5 ? 2 : 3;
    const [first, second] = this.explorers(view);
    const n = this.now;
    const toFar = v3();
    for (let k = 0; k < 3; k++) toFar[k] = far[k]! - n.p[k]!;
    const d = Math.hypot(toFar[0], toFar[1], toFar[2]);
    if (!(d > 1e-9)) return;
    const dir: Vec3 = [toFar[0] / d, toFar[1] / d, toFar[2] / d];
    const crown = this.facing(far, new Set());
    const feelers = [first, second, crown].slice(0, count);
    const rig = this.rig!;
    this.lookAt = far;
    feelers.forEach((i, k) => {
      if (i < 0) return;
      const fan = [0, 25, -25][k]! * DEG;
      const dk = rotateAbout(dir, n.u, fan);
      const p = v3();
      const contact = this.contactClock;
      if (contact !== null && view.clock >= contact + 0.15 * k) {
        const off = [0, 0.1, -0.1][k]! * unit;
        for (let c = 0; c < 3; c++) p[c] = far[c]! - dir[c]! * 0.12 * unit + n.s[c]! * off;
        this.set(i, TIP_PINNED, p);
        return;
      }
      const reach = rig.length[i]! * rig.maxStretch[i]! * this.params.maxStretchScale;
      const out = Math.min(reach - TAP * unit, d);
      const phase = (time / TAP_EVERY) % 1;
      const tap = still || phase > 0.4 ? 0 : TAP * unit * Math.sin((Math.PI * phase) / 0.4);
      // Feeling about while the note is out of reach; steadier as it comes near.
      const w = still ? 0 : 0.35 * unit * clamp01((d - out) / unit);
      const ph = this.seed + i * 2.3;
      const across = w * Math.sin(2 * Math.PI * 0.7 * time + ph);
      const up = w * 0.6 * Math.sin(2 * Math.PI * 1.1 * time + ph);
      for (let c = 0; c < 3; c++) {
        p[c] = n.p[c]! + dk[c]! * (out + tap) + n.s[c]! * across + n.u[c]! * up;
      }
      this.set(i, TIP_SOFT, p, 0.3);
    });
  }

  /**
   * Reaching for what it reads: each reach goes to the free crown tentacle
   * whose socket faces it best, chosen once when it sets out, in the order the
   * replay lists them. A named note is tapped from two sides.
   */
  private reach(view: ReplayView, time: number): void {
    const clock = view.clock;
    const unit = view.unit;
    const chain = this.chain!;
    const busy = new Set<number>();
    view.reaches.forEach((r, k) => {
      const age = clock - r.start;
      if (age >= 0 && age <= REACH_HOLD) for (const i of this.reachers[k] ?? []) busy.add(i);
    });
    const n = this.now;
    let latest = -Infinity;
    view.reaches.forEach((r, k) => {
      const age = clock - r.start;
      if (age < 0 || age > REACH_HOLD) return;
      const at = v3();
      if (r.nodeId ? !view.field.node(r.nodeId, at) : !r.point) return;
      if (!r.nodeId && r.point) for (let c = 0; c < 3; c++) at[c] = r.point[c]!;
      let who = this.reachers[k];
      if (!who) {
        const count = r.kind === 'named' ? 2 : 1;
        who = [];
        for (let m = 0; m < count; m++) {
          const i = this.facing(at, busy);
          if (i < 0) break;
          who.push(i);
          busy.add(i);
        }
        this.reachers[k] = who;
      }
      const out = smooth(age / REACH_OUT);
      const glow = age < REACH_OUT ? age / REACH_OUT : Math.exp(-(age - REACH_OUT) / 0.35);
      who.forEach((i, m) => {
        const start = v3();
        const k3 = i * 3;
        const length = this.rig!.length[i]!;
        for (let c = 0; c < 3; c++)
          start[c] = chain.root[k3 + c]! + chain.axis[k3 + c]! * length * 0.6;
        const p = v3();
        // Two taps on a named note, from either side, lifting off and coming down.
        const side = who.length > 1 ? (m === 0 ? -1 : 1) * 0.12 * unit : 0;
        const tap =
          who.length > 1
            ? 0.05 * unit * Math.max(0, Math.sin(2 * Math.PI * 2.5 * time + m * Math.PI))
            : 0;
        for (let c = 0; c < 3; c++) {
          const goal = at[c]! + n.s[c]! * side + n.u[c]! * tap;
          p[c] = start[c]! + (goal - start[c]!) * out;
        }
        this.set(i, TIP_SOFT, p, 0.35);
        chain.glow[i] = glow;
        chain.glowFront[i] = age / 0.2;
      });
      if (r.start > latest) {
        latest = r.start;
        for (let c = 0; c < 3; c++) this.lookPoint[c] = at[c]!;
        this.lookAt = this.lookPoint;
      }
    });
  }

  /** The crown tentacle not in `busy` whose socket faces `at` best; or, all busy, the best of all; -1 if none. */
  private facing(at: Vec3, busy: ReadonlySet<number>): number {
    const chain = this.chain!;
    let best = -1;
    let bestScore = -Infinity;
    let fallback = -1;
    let fallbackScore = -Infinity;
    for (const i of FREE_CROWN) {
      const k3 = i * 3;
      const dx = at[0] - chain.root[k3]!;
      const dy = at[1] - chain.root[k3 + 1]!;
      const dz = at[2] - chain.root[k3 + 2]!;
      const l = Math.hypot(dx, dy, dz) || 1;
      const score =
        (chain.axis[k3]! * dx + chain.axis[k3 + 1]! * dy + chain.axis[k3 + 2]! * dz) / l;
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = i;
      }
      if (!busy.has(i) && score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best >= 0 ? best : fallback;
  }

  // -- Eye -------------------------------------------------------------------------

  /** Where the next leg goes, world space, while a pause has one that moves. */
  private nextNote(view: ReplayView, out: Vec3): boolean {
    return !!view.nextId && view.nextId !== view.hereId && view.field.node(view.nextId, out);
  }

  private nextHeading(view: ReplayView): Vec3 | null {
    const next = v3();
    const here = v3();
    if (!this.nextNote(view, next) || !view.hereId || !view.field.node(view.hereId, here)) {
      return null;
    }
    const d: Vec3 = [next[0] - here[0], next[1] - here[1], next[2] - here[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return l > 1e-9 ? [d[0] / l, d[1] / l, d[2] / l] : null;
  }

  /** Nothing else to watch: the note it stands on, or the way it walks. */
  private lookFor(view: ReplayView): void {
    if (view.mode !== 'walk' && view.hereId && view.field.node(view.hereId, this.lookPoint)) {
      this.lookAt = this.lookPoint;
    }
  }

  private eyeCue(view: ReplayView): EyeCue {
    const n = this.now;
    let look: Vec3 | null = null;
    if (this.lookAt) {
      // From the lens, not the body's centre: close things are looked at, not past.
      const lens = this.world(
        EYE.position.map((v) => v * this.params.bodyScale),
        v3(),
      );
      const d: Vec3 = [
        this.lookAt[0] - lens[0],
        this.lookAt[1] - lens[1],
        this.lookAt[2] - lens[2],
      ];
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l > 1e-9) look = [d[0] / l, d[1] / l, d[2] / l];
    }
    const dwell = view.mode === 'dwell' ? view.dwell : null;
    return {
      s: n.s,
      u: n.u,
      f: n.f,
      look,
      next: dwell ? this.nextHeading(view) : null,
      untilBegin: dwell ? dwell.duration - dwell.t : Infinity,
      window: dwell ? scanWindow(dwell.duration) : 0,
      stepIndex: view.stepIndex,
      touch: this.touchNow,
    };
  }

  // -- Output ----------------------------------------------------------------------

  private write(rig: Rig, chain: ChainState, time: number, still: boolean): void {
    const pose = this.pose;
    const unit = rig.unit;
    const anchor = this.body.p;
    for (let i = 0; i < 3; i++) {
      pose.anchor[i] = anchor[i]!;
      this.bodyWorld[i] = anchor[i]!;
    }
    pose.unit = unit;
    writeSegments(chain, rig, anchor, pose, still ? 0 : this.params.recoil);

    // The hull: its axes, breathing, and the hum's offset from the anchor.
    const n = this.now;
    const scale = rig.bodyScale;
    const breath =
      scale *
      (still
        ? 1
        : 1 +
          (this.params.breathing / ((HULL.width / 2) * scale)) *
            Math.sin(2 * Math.PI * 0.22 * time + this.seed));
    const h = pose.hull;
    for (let i = 0; i < 3; i++) {
      h[i] = n.s[i]! * breath;
      h[4 + i] = n.u[i]! * breath;
      h[8 + i] = n.f[i]! * breath;
      h[12 + i] = (n.p[i]! - anchor[i]!) / unit;
    }
    h[3] = 0;
    h[7] = 0;
    h[11] = 0;
    h[15] = 1;

    pose.eye.dir[0] = this.eye.dir[0];
    pose.eye.dir[1] = this.eye.dir[1];
    pose.eye.dir[2] = this.eye.dir[2];
    pose.eye.intensity = this.eye.intensity;
    pose.eye.aperture = this.eye.aperture;

    const dbg = this.debug;
    dbg.jointCount = rig.joints;
    for (let q = 0; q < rig.joints * 3; q += 3) {
      dbg.joints[q] = (chain.xr[q]! - anchor[0]) / unit;
      dbg.joints[q + 1] = (chain.xr[q + 1]! - anchor[1]) / unit;
      dbg.joints[q + 2] = (chain.xr[q + 2]! - anchor[2]) / unit;
    }
    const d = this.drive;
    for (let i = 0; i < TENTACLES; i++) {
      const k = i * 3;
      const tip = (rig.jointStart[i]! + rig.segments[i]!) * 3;
      const src = d.mode[i] === TIP_FREE ? chain.xr : d.target;
      const o = d.mode[i] === TIP_FREE ? tip : k;
      dbg.targets[k] = (src[o]! - anchor[0]) / unit;
      dbg.targets[k + 1] = (src[o + 1]! - anchor[1]) / unit;
      dbg.targets[k + 2] = (src[o + 2]! - anchor[2]) / unit;
    }
  }
}

/** The stretch at the end of a pause given to glancing about before the walk. */
function scanWindow(duration: number): number {
  return Math.min(0.6, 0.45 * duration);
}

/** `v` turned about unit `axis` by `angle`. */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [
    v[0] * c + x[0] * s + axis[0] * k,
    v[1] * c + x[1] * s + axis[1] * k,
    v[2] * c + x[2] * s + axis[2] * k,
  ];
}
