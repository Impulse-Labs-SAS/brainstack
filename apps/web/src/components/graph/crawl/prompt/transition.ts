// The way from the prompt to the crawl and back, as levels on a clock: how
// much of each part of the scene shows `t` seconds into a transition — the
// input and its frame, the side panel, the cluster — and how far along its
// way the camera is. Pure, so it is tested, and the DOM and the stage read
// the same numbers in the same frame.
//
// Levels are eased from wherever the last transition left them, so turning
// round midway never jumps. Reduced motion collapses every span to nothing:
// each change is a cut.
//
// The creature's crossing between the frame and the cluster is the replay's
// (crawl-replay.ts): paced by its length, so it never moves faster than the
// body can follow. Whatever the crossing takes, the camera's way ends as it
// lands, and so does the frame's return on the way back: the overview holds
// still while the creature lands on its first note, and the frame is whole
// before its claws close on it.

import type { Camera } from '@/lib/graph-camera';

import type { CrossingPace } from '../crawl-replay';

export type SceneName = 'prompt' | 'crawl';

/** How much of each part shows, 0 to 1: the input and its frame, the side panel, the cluster. */
export interface Levels {
  prompt: number;
  panel: number;
  cluster: number;
}

export const AT_PROMPT: Readonly<Levels> = { prompt: 1, panel: 0, cluster: 0 };
export const AT_CRAWL: Readonly<Levels> = { prompt: 0, panel: 1, cluster: 1 };

/** Seconds from the transition's start. */
export interface Span {
  start: number;
  duration: number;
}

export interface DirectionTimes {
  prompt: Span;
  panel: Span;
  cluster: Span;
  camera: Span;
  /** How the crossing between the frame and the crawl is paced by its length. */
  crossing: CrossingPace;
}

export interface TransitionTimes {
  enter: DirectionTimes;
  leave: DirectionTimes;
  /**
   * Seconds over which the timeline hands the camera to whatever follows the
   * walk, once at the crawl: blended, so the follow's own ease never sets off
   * at full speed.
   */
  handoff: number;
}

/**
 * Entering, the input goes once the claws have let go (the replay's release),
 * the panel slides in, the cluster wakes and the camera backs out to the
 * overview as the creature crosses — 14 units a second, 2 to 4 s. Going back,
 * the panel and the cluster go first, and the creature is back on its frame
 * — 24 units a second, 1.2 to 2.4 s — as the camera reaches the perch shot
 * and the input is whole.
 */
export function defaultTimes(): TransitionTimes {
  return {
    enter: {
      prompt: { start: 0.3, duration: 0.35 },
      panel: { start: 0.1, duration: 0.45 },
      cluster: { start: 0.25, duration: 1.1 },
      camera: { start: 0.15, duration: 1.8 },
      crossing: { speed: 14, min: 2, max: 4 },
    },
    leave: {
      panel: { start: 0, duration: 0.35 },
      cluster: { start: 0, duration: 0.8 },
      camera: { start: 0, duration: 1.5 },
      prompt: { start: 0.9, duration: 0.5 },
      crossing: { speed: 24, min: 1.2, max: 2.4 },
    },
    handoff: 0.5,
  };
}

/**
 * A direction's spans alone. The crossing's pace is not a transition's: the
 * replay is handed it as the crossing sets out, and paces it from then on.
 */
export type Spans = Omit<DirectionTimes, 'crossing'>;

export interface Transition {
  to: SceneName;
  /** The levels it set out from. */
  from: Levels;
  /** Its spans, the camera's (and going back, the input's) ending as the crossing does; all zero under reduced motion. */
  times: Spans;
  handoff: number;
}

const span = (s: Span): Span => ({
  start: Math.max(0, s.start),
  duration: Math.max(0, s.duration),
});
/** `s` ending at `end`: its start kept, or moved to `end` when that comes first. */
const endingAt = (s: Span, end: number): Span => {
  const start = Math.min(Math.max(0, s.start), end);
  return { start, duration: Math.max(0, end - start) };
};
const CUT: Span = { start: 0, duration: 0 };

/**
 * A transition to `to` from the levels `from`. `arrive` is when the
 * creature's crossing lands, seconds from now, when it is crossing: the
 * camera's span ends then, and going back the input's too. Under reduced
 * motion every span is zero, so its first frame shows its end.
 */
export function transition(
  to: SceneName,
  from: Levels,
  times: TransitionTimes,
  still: boolean,
  arrive: number | null = null,
): Transition {
  const t = to === 'crawl' ? times.enter : times.leave;
  if (still) {
    return {
      to,
      from: { ...from },
      times: { prompt: CUT, panel: CUT, cluster: CUT, camera: CUT },
      handoff: 0,
    };
  }
  const lands = arrive !== null && Number.isFinite(arrive) && arrive > 0;
  return {
    to,
    from: { ...from },
    times: {
      prompt: lands && to === 'prompt' ? endingAt(t.prompt, arrive) : span(t.prompt),
      panel: span(t.panel),
      cluster: span(t.cluster),
      camera: lands ? endingAt(t.camera, arrive) : span(t.camera),
    },
    handoff: to === 'crawl' ? Math.max(0, times.handoff) : 0,
  };
}

export interface TransitionAt {
  levels: Levels;
  /** 0–1 along the camera's way, eased. */
  camera: number;
  cameraDone: boolean;
  /**
   * Entering, once the camera's way is done: how far the hand-off to the
   * follow camera has gone, 0–1 and eased. Null before and after it, and
   * going back.
   */
  handoff: number | null;
  done: boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (f: number) => f * f * (3 - 2 * f);
const easeOut = (f: number) => 1 - (1 - f) ** 3;
/** The cubic in-out graph-camera's `interpolate` eases with. */
const easeInOut = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);

/** How far through `s` a moment `t` is, 0–1: a span of no length is done once it starts. */
function through(s: Span, t: number): number {
  if (!(s.duration > 0)) return t >= s.start ? 1 : 0;
  return clamp01((t - s.start) / s.duration);
}

const end = (s: Span) => s.start + s.duration;

/** Seconds until the last span ends, hand-off included: 0 under reduced motion. */
export function transitionLength(tr: Transition): number {
  const { prompt, panel, cluster, camera } = tr.times;
  return Math.max(end(prompt), end(panel), end(cluster), end(camera) + tr.handoff);
}

/** Where a transition is `t` seconds after it started. */
export function transitionAt(tr: Transition, t: number): TransitionAt {
  const target = tr.to === 'crawl' ? AT_CRAWL : AT_PROMPT;
  const { times, from } = tr;
  const level = (c: keyof Levels, ease: (f: number) => number) =>
    from[c] + (target[c] - from[c]) * ease(through(times[c], t));
  const cameraEnd = end(times.camera);
  const handing = tr.handoff > 0 && t >= cameraEnd && t < cameraEnd + tr.handoff;
  return {
    levels: {
      prompt: level('prompt', smoothstep),
      panel: level('panel', easeOut),
      cluster: level('cluster', smoothstep),
    },
    camera: easeInOut(through(times.camera, t)),
    cameraDone: t >= cameraEnd,
    handoff: handing ? smoothstep(clamp01((t - cameraEnd) / tr.handoff)) : null,
    done: t >= transitionLength(tr),
  };
}

/**
 * The camera `e` of the way from `a` to `b`, `e` already eased: target, yaw
 * (the short way round), pitch and distance all linear. Not graph-camera's
 * `interpolate`, whose geometric distance makes a camera backing out along
 * the axis its target runs on lunge forward first: from the perch shot to
 * the overview the target runs deep into the cluster while the distance
 * grows, and a distance that grows slowly at first leaves the camera
 * chasing its target.
 */
export function cameraBetween(a: Camera, b: Camera, e: number): Camera {
  // Exactly on either end, not a rounding away: the shot it ends on is the one the frame is fitted to.
  if (e <= 0) return { ...a };
  if (e >= 1) return { ...b };
  let yaw = b.yaw;
  while (yaw - a.yaw > Math.PI) yaw -= 2 * Math.PI;
  while (yaw - a.yaw < -Math.PI) yaw += 2 * Math.PI;
  return {
    tx: a.tx + (b.tx - a.tx) * e,
    ty: a.ty + (b.ty - a.ty) * e,
    tz: a.tz + (b.tz - a.tz) * e,
    yaw: a.yaw + (yaw - a.yaw) * e,
    pitch: a.pitch + (b.pitch - a.pitch) * e,
    dist: a.dist + (b.dist - a.dist) * e,
  };
}
