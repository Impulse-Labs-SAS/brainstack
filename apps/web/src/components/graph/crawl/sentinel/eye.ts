// The Sentinel's eye: where it looks, how bright it burns, and the hum of the
// machine around it.
//
// It looks before it moves. In the last moments of a pause whose next step
// goes somewhere, it glances three times around the heading to come — quick
// saccades, a beat on each — and locks onto that heading just before the walk
// begins, so a viewer reads intent, not a puppet being dragged. The rest of
// the time it follows what the crawl attends to: the note it reads, what a
// tentacle reaches for, the thread ahead.
//
// Its light is the creature's own and the only one it has: a slow resting
// pulse, a flare when it finds a note that decays in a fraction of a second, a
// smaller one when a crossing touches the far side, a glint when a grip lands.
// Under reduced motion it neither pulses nor flares nor glances; it looks at
// what it reads and holds there.
//
// Angles are relative to the hull — yaw toward its right, pitch toward its up —
// so the eye turns with the body and its springs only carry what the eye adds.

import { seededRandom } from '@/lib/graph-brain';

import type { ReplayEvent } from '../replay-view';
import { dot, type Vec3 } from '../vec';

import { springScalar } from './body';

export interface EyeParams {
  /** Resting intensity, 0–1. */
  eyeBase: number;
  /** Its slow pulse, either way. */
  eyePulse: number;
  /** Added when it finds a note; a crossing's contact and a grip landing add fractions of it. */
  eyeFlare: number;
  /** The constant intensity under reduced motion. */
  eyeStill: number;
}

export interface EyeState {
  /** Radians from the hull's forward, toward its right and its up, and their springs' velocities. */
  yaw: number;
  pitch: number;
  vYaw: number;
  vPitch: number;
  /** Where it looks: world space, which is creature space's orientation too. Unit length. */
  dir: Vec3;
  /** What is left of the last flares. */
  flare: number;
  intensity: number;
  aperture: number;
  /** Glancing around before a move. */
  scanning: boolean;
}

export function createEye(): EyeState {
  return {
    yaw: 0,
    pitch: 0,
    vYaw: 0,
    vPitch: 0,
    dir: [0, 0, 1],
    flare: 0,
    intensity: 0.55,
    aperture: 1,
    scanning: false,
  };
}

/** One glance of a scan: offsets from the heading to come, radians, and how long it holds, seconds. */
export interface Fixation {
  yaw: number;
  pitch: number;
  hold: number;
}

const DEG = Math.PI / 180;
/** Left, right, then a smaller look left: a search, not a sweep. */
const SCAN_YAWS = [-30, 25, -12];

/** The three glances before step `stepIndex`: the same every time that step is replayed. */
export function scanFixations(seed: number, stepIndex: number): Fixation[] {
  const r = seededRandom((seed ^ 0x3c6ef372) + 7919 * stepIndex);
  return SCAN_YAWS.map((yaw) => ({
    yaw: (yaw + (r() * 2 - 1) * 5) * DEG,
    pitch: (r() * 2 - 1) * 8 * DEG,
    hold: 0.12 + 0.04 * r(),
  }));
}

/** The eye is locked on the heading this long before the walk begins… */
export const LOCK_LEAD = 0.08;
/** …having saccaded there over this long before that. */
const LOCK_SACCADE = 0.15;
/** Saccades are quick; following is smooth. */
const OMEGA_SACCADE = 25;
const OMEGA_TRACK = 9;
/** How far the eye turns in its socket. */
const MAX_YAW = 1.2;
const MAX_PITCH = 0.9;
/** Seconds for a flare to fall by e. */
const FLARE_DECAY = 0.3;
const PULSE_HZ = 0.55;

/** What the eye is asked to do this frame. */
export interface EyeCue {
  /** The hull's axes, world space: right, up, forward. */
  s: Vec3;
  u: Vec3;
  f: Vec3;
  /** The way to look when nothing else calls, world space; null looks straight ahead. */
  look: Vec3 | null;
  /** The heading of the walk to come, while a pause has one; null otherwise. */
  next: Vec3 | null;
  /** Seconds of the pause left, and the stretch of it at its end given to scanning. */
  untilBegin: number;
  window: number;
  stepIndex: number;
  /** An explorer touched the note ahead this frame. */
  touch: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Yaw and pitch, relative to the hull, of a world direction. */
function anglesOf(d: Vec3, cue: EyeCue, out: [number, number]): void {
  out[0] = clamp(Math.atan2(dot(d, cue.s), dot(d, cue.f)), -MAX_YAW, MAX_YAW);
  out[1] = clamp(Math.asin(clamp(dot(d, cue.u), -1, 1)), -MAX_PITCH, MAX_PITCH);
}

const spring: [number, number] = [0, 0];
const angles: [number, number] = [0, 0];

/** Advance the eye one frame. Time is real seconds, the pulse's clock. */
export function stepEye(
  e: EyeState,
  cue: EyeCue,
  events: readonly ReplayEvent[],
  params: EyeParams,
  seed: number,
  time: number,
  dt: number,
  still: boolean,
): void {
  // Where to look.
  let yaw = 0;
  let pitch = 0;
  let omega = OMEGA_TRACK;
  e.scanning = false;
  if (!still && cue.next && cue.untilBegin <= cue.window) {
    anglesOf(cue.next, cue, angles);
    yaw = angles[0];
    pitch = angles[1];
    omega = OMEGA_SACCADE;
    const glancing = cue.window - LOCK_LEAD - LOCK_SACCADE;
    const elapsed = cue.window - cue.untilBegin;
    if (cue.untilBegin > LOCK_LEAD + LOCK_SACCADE && glancing > 0) {
      e.scanning = true;
      const fixations = scanFixations(seed, cue.stepIndex);
      const total = fixations.reduce((s, x) => s + x.hold, 0);
      const fit = Math.min(1, glancing / total);
      let at = 0;
      for (const fx of fixations) {
        at += fx.hold * fit;
        if (elapsed < at) {
          yaw = clamp(yaw + fx.yaw, -MAX_YAW, MAX_YAW);
          pitch = clamp(pitch + fx.pitch, -MAX_PITCH, MAX_PITCH);
          break;
        }
      }
    }
  } else if (cue.look) {
    anglesOf(cue.look, cue, angles);
    yaw = angles[0];
    pitch = angles[1];
  }
  if (still || !(dt > 0)) {
    if (still) {
      e.yaw = yaw;
      e.pitch = pitch;
      e.vYaw = 0;
      e.vPitch = 0;
    }
  } else {
    springScalar(e.yaw, e.vYaw, yaw, omega, dt, spring);
    e.yaw = spring[0];
    e.vYaw = spring[1];
    springScalar(e.pitch, e.vPitch, pitch, omega, dt, spring);
    e.pitch = spring[0];
    e.vPitch = spring[1];
  }
  const cp = Math.cos(e.pitch);
  const cy = Math.cos(e.yaw) * cp;
  const sy = Math.sin(e.yaw) * cp;
  const sp = Math.sin(e.pitch);
  for (let i = 0; i < 3; i++) e.dir[i] = cue.f[i]! * cy + cue.s[i]! * sy + cue.u[i]! * sp;

  // How bright.
  if (still) {
    e.flare = 0;
    e.intensity = params.eyeStill;
    e.aperture = 1;
    return;
  }
  e.flare *= Math.exp(-Math.max(0, dt) / FLARE_DECAY);
  for (const ev of events) {
    if (ev.kind === 'found') e.flare += params.eyeFlare;
    else if (ev.kind === 'contact') e.flare += 0.6 * params.eyeFlare;
    else if (ev.kind === 'grip') e.flare += 0.08 * params.eyeFlare;
  }
  if (cue.touch) e.flare += 0.25 * params.eyeFlare;
  e.flare = Math.min(e.flare, 2 * Math.max(1, params.eyeFlare));
  const phase = draws(seed ^ 0x2545f491)[0]! * Math.PI * 2;
  const pulse = params.eyePulse * Math.sin(2 * Math.PI * PULSE_HZ * time + phase);
  e.intensity = params.eyeBase + pulse + (e.scanning ? 0.2 : 0) + e.flare;
  // The iris narrows while it searches, and opens again to see.
  const ka = 1 - Math.exp(-10 * Math.max(0, dt));
  e.aperture += ((e.scanning ? 0.85 : 1) - e.aperture) * ka;
}

/**
 * The machine's hum: three incommensurate tones between 7 and 17 Hz, below
 * the frame rate's Nyquist limit, summing to at most 1. Each seed is its own
 * voice, so the three axes of the body never shake in step.
 */
export function hum(t: number, seed: number): number {
  const r = draws(seed);
  return (
    0.5 * Math.sin(2 * Math.PI * 7.3 * t + r[0]! * 6.283) +
    0.3 * Math.sin(2 * Math.PI * 11.9 * t + r[1]! * 6.283) +
    0.2 * Math.sin(2 * Math.PI * 17.3 * t + r[2]! * 6.283)
  );
}

// The first three draws of each seed, kept: the hum and the pulse ask for the
// same few seeds' phases every frame, and drawing them anew allocates each time.
const drawn = new Map<number, readonly number[]>();

function draws(seed: number): readonly number[] {
  let d = drawn.get(seed);
  if (!d) {
    if (drawn.size >= 64) drawn.clear();
    const r = seededRandom(seed);
    d = [r(), r(), r()];
    drawn.set(seed, d);
  }
  return d;
}
