// The prompt scene, and the way from it to the crawl and back, apart from
// anything that draws: where the frame round the input is, who holds the
// camera, how much of each part shows, and what the replay is told. The lab
// and Crawl drive the same tested object; each draws it its own way.
//
// At the prompt the Sentinel rests on the frame round the input (the replay's
// `rest` over the space's field with the frame in it), and the scene holds
// the camera on the perch shot: nothing may orbit it, or the frame would leave
// the box. A prompt sent — or a recent crawl touched — loads the crawl from
// the perch: the creature lets go and crosses to its first note while the
// camera backs out to the overview, then hands it to whatever follows the
// walk. "New search" calls the walk back to the frame from wherever it is,
// and the camera returns to the perch shot from wherever it was.
//
// The perch lives in the space's own world, a fixed gap in front of the
// cluster (perch-geometry.ts), so the creature crosses one field all the way:
// one object per space, the frame moved in place as the box moves, so a
// replay holding it sees every change.
//
// The scene's clock — the `now` its calls take — is the replay's: seconds
// added up from exactly the steps the host hands `replay.update`, capped,
// at its playback speed, none while paused. Never wall time: the camera's way
// is timed to end as the crossing lands, and on any other clock a slow
// frame, a slow speed or a pause would part the two.

import type { Camera, Viewport } from '@/lib/graph-camera';
import type { GraphModel } from '@/lib/graph-model';

import type { CrawlResult } from '../crawl-plan';
import type { CrawlReplay, ReplayPerch } from '../crawl-replay';
import type { MotionParams } from '../sentinel/motion';
import type { SpaceBuild } from '../space/space';
import type { ThreadField } from '../threads';
import type { Vec3 } from '../vec';

import { replayPerch, withPerch, type PerchedField } from './perch-field';
import {
  DEFAULT_PERCH,
  perchShot,
  type PerchKnobs,
  type PerchShot,
  type ScreenRect,
} from './perch-geometry';
import {
  AT_CRAWL,
  AT_PROMPT,
  cameraBetween,
  defaultTimes,
  transition,
  transitionAt,
  type Levels,
  type SceneName,
  type Transition,
  type TransitionTimes,
} from './transition';

/** Where the eye rests at the prompt: the viewer, the box the question is typed in, or the motion's own choice. */
export type Gaze = 'viewer' | 'box' | 'perch';
export const GAZES: readonly Gaze[] = ['viewer', 'box', 'perch'];

/**
 * The body's idle life while it clings to the frame, as MotionParams names
 * them — breath, hum and a slow bob — blended in with the prompt's level, so
 * the walk's own values stay as they were tuned. The tentacles are left
 * alone: waiting at the prompt they move exactly as they move on the walk.
 */
export type IdleLife = Pick<MotionParams, 'breathing' | 'humAmplitude' | 'bob'>;

export interface PromptKnobs extends PerchKnobs {
  gaze: Gaze;
  /** The grip planner's reach for the frame, creature units: a thread's is 0.93. */
  frameReach: number;
  /** Seconds it holds still on the frame, letting go, before it crosses: it is seen to let go. */
  release: number;
  idle: IdleLife;
  times: TransitionTimes;
}

/** A fresh, deep copy: the lab tunes it in place. */
export function defaultPromptKnobs(): PromptKnobs {
  return {
    ...DEFAULT_PERCH,
    gaze: 'viewer',
    frameReach: 1,
    release: 0.35,
    // No hum: on a creature at rest it read as a tremor. Breath and bob are slow.
    idle: { breathing: 0.008, humAmplitude: 0, bob: 0.02 },
    times: defaultTimes(),
  };
}

/** What the scene is laid out against: the stage, the box on it, and the space's overview. */
export interface PromptLayout {
  vp: Viewport;
  rect: ScreenRect;
  overview: Camera;
  /** How far the notes reach from the overview's target, world units (stage/overview.ts `notesReach`). */
  radius: number;
}

export interface PromptFrame {
  scene: SceneName;
  /** A transition is under way, to `scene`. */
  moving: boolean;
  levels: Levels;
  /**
   * The camera this frame when the scene holds it — the perch shot, or the
   * way between it and the overview — else null: the follow camera's, or the
   * user's.
   */
  camera: Camera | null;
  /**
   * Handing the camera over at the crawl: the camera the scene held, and how
   * far the hand-off has gone, 0–1 and eased. The host shows
   * `cameraBetween(camera, its own, k)`. Null otherwise.
   */
  handoff: { camera: Camera; k: number } | null;
  /** The input takes text and a send: the prompt, settled, the creature resting on the frame. */
  interactive: boolean;
  /** Resting on the frame with nothing under way: the cluster need not be drawn. */
  atRest: boolean;
  /** Where the eye rests, while the scene is (or goes back to) the prompt; null otherwise. */
  gaze: Vec3 | null;
}

interface Running {
  tr: Transition;
  /** Seconds, on the clock `frame` is handed. */
  start: number;
  /** The camera it eases from. */
  from: Camera;
  /** The timeline still holds the camera: a drag takes it. */
  camera: boolean;
}

export class PromptScene {
  readonly knobs: PromptKnobs;
  private build: SpaceBuild | null = null;
  private model: GraphModel | null = null;
  private perched: PerchedField | null = null;
  private last: PromptLayout | null = null;
  private current: PerchShot | null = null;
  private scene: SceneName = 'crawl';
  private running: Running | null = null;
  private levels: Levels = { ...AT_CRAWL };
  /**
   * A layout asked for fresh grips while the creature was not resting on the
   * frame — on its way back to it. The replay holds the perch it was recalled
   * to, the old heading and landing spot among it: it takes hold anew as soon
   * as it has landed.
   */
  private regripLanded = false;

  constructor(
    private readonly replay: CrawlReplay,
    knobs: PromptKnobs = defaultPromptKnobs(),
  ) {
    this.knobs = knobs;
  }

  /** 'crawl' until a reset succeeds; 'crawl' for good without a space. Under way, where it is going. */
  get name(): SceneName {
    return this.scene;
  }

  /** A space and a shot: the prompt can be shown. */
  get available(): boolean {
    return !!this.build && !!this.current;
  }

  get shot(): PerchShot | null {
    return this.current;
  }

  /** The space's field with the frame in it, for any load the host does itself; null without a space. */
  get field(): ThreadField | null {
    return this.perched;
  }

  /**
   * A new layout of the cluster over `model` — a new space, vault or layout
   * knob — or null: no prompt here (the brain stand-in), the crawl for good.
   * A transition under way is first cut to where it was going, so nothing
   * eases toward a shot of the old layout or recalls to a perch the new field
   * lacks; the host then rests it (`reset`) or loads the crawl over `field`,
   * as `name` says, once it has laid it out.
   */
  setSpace(build: SpaceBuild | null, model: GraphModel | null): void {
    this.finish();
    this.current = null;
    this.regripLanded = false;
    if (!build || !model) {
      this.build = null;
      this.model = null;
      this.perched = null;
      this.scene = 'crawl';
      this.levels = { ...AT_CRAWL };
      return;
    }
    this.build = build;
    this.model = model;
    this.perched = withPerch(build.field, null);
  }

  /**
   * The box moved, the view resized, or a knob changed: the shot again. At
   * rest, the grips are taken again when `regrip`, or when the frame changed
   * width by more than a tenth; otherwise the claws keep their place along
   * the rails as the frame moves under them. Under way, it only moves the
   * frame — and on the way back, grips asked for then are taken once the
   * creature has landed. False when nothing could be placed: the last shot
   * stays.
   */
  layout(l: PromptLayout, regrip = false): boolean {
    this.last = l;
    const build = this.build;
    if (!build || !this.perched) return false;
    const shot = perchShot({ ...l, unit: build.unit, knobs: this.knobs });
    if (!shot) return false;
    const before = this.current;
    this.current = shot;
    this.perched.setFrame(shot);
    const wider =
      !before || Math.abs(shot.bezel.width - before.bezel.width) > 0.1 * before.bezel.width;
    if (regrip || wider) {
      if (this.interactive()) this.rest();
      else if (this.scene === 'prompt') this.regripLanded = true;
    }
    return true;
  }

  /** Rests on the frame now, the prompt shown: a cut. False without a space or a shot. */
  reset(): boolean {
    if (!this.build || !this.current) return false;
    this.running = null;
    this.rest();
    if (!this.replay.resting) return false;
    this.scene = 'prompt';
    this.levels = { ...AT_PROMPT };
    return true;
  }

  /**
   * A prompt sent or a recent crawl touched: the crawl sets out from the
   * frame, and the camera backs out from the perch shot to the overview,
   * arriving as the creature does. `now` in seconds, on the scene's clock —
   * the replay's. False unless the input takes a send.
   */
  submit(crawl: CrawlResult, now: number, still: boolean): boolean {
    const { build, model, perched, current } = this;
    if (!this.interactive() || !build || !model || !perched || !current) return false;
    this.replay.load(crawl, model, {
      field: perched,
      unit: build.unit,
      pace: build.pace,
      perch: this.perch(),
    });
    this.start('crawl', now, still, current.cam);
    return true;
  }

  /**
   * "New search": the walk called back to the frame from wherever it is, the
   * camera eased from `from` to the perch shot. False in the prompt or on the
   * way there already.
   */
  back(now: number, still: boolean, from: Camera): boolean {
    if (this.scene === 'prompt' || !this.build || !this.current) return false;
    if (!this.replay.recall(this.perch(), this.knobs.times.leave.crossing)) return false;
    this.start('prompt', now, still, from);
    return true;
  }

  /** The user took the camera midway: the timeline lets it go for the rest of the transition. */
  takeCamera(): void {
    if (this.running) this.running.camera = false;
  }

  /**
   * This frame, `now` seconds on the scene's clock — the replay's, as it
   * stands after this frame's step. Under reduced motion a transition under
   * way ends at once.
   */
  frame(now: number, still: boolean): PromptFrame {
    const r = this.running;
    let camera: Camera | null = null;
    let handoff: PromptFrame['handoff'] = null;
    if (r) {
      const at = transitionAt(r.tr, still ? Infinity : Math.max(0, now - r.start));
      this.levels = at.levels;
      const to = this.destination(r.tr.to);
      if (r.camera && !at.cameraDone && to) camera = cameraBetween(r.from, to, at.camera);
      else if (r.camera && at.handoff !== null && to) handoff = { camera: to, k: at.handoff };
      if (at.done) this.running = null;
    }
    // Landed on a frame that changed on the way: the grips it was asked for, now.
    if (this.regripLanded && this.interactive()) this.rest();
    // At the prompt the shot holds the camera whenever the timeline does not move it.
    if (!camera && this.scene === 'prompt' && this.current) camera = { ...this.current.cam };
    const interactive = this.interactive();
    return {
      scene: this.scene,
      moving: this.running !== null,
      levels: { ...this.levels },
      camera,
      handoff,
      interactive,
      atRest: interactive,
      gaze: this.scene === 'prompt' ? this.gaze() : null,
    };
  }

  // -- Inside ----------------------------------------------------------------------

  /** The prompt, with nothing under way and the creature resting on the frame. */
  private interactive(): boolean {
    return this.scene === 'prompt' && !this.running && this.replay.resting;
  }

  /** Where the camera is going: the overview of the latest layout, or the live perch shot. */
  private destination(to: SceneName): Camera | null {
    if (to === 'crawl') return this.last ? { ...this.last.overview } : null;
    return this.current ? { ...this.current.cam } : null;
  }

  private gaze(): Vec3 | null {
    const shot = this.current;
    if (!shot) return null;
    if (this.knobs.gaze === 'viewer') return shot.viewer;
    if (this.knobs.gaze === 'box') return shot.box;
    return null;
  }

  /** The replay's perch for the current shot. */
  private perch(): ReplayPerch {
    return replayPerch(this.current!, {
      reach: this.knobs.frameReach,
      crossing: this.knobs.times.enter.crossing,
      release: this.knobs.release,
    });
  }

  /** The replay resting on the frame, its grips taken at once. */
  private rest(): void {
    const { build, model, perched } = this;
    if (!build || !model || !perched || !this.current) return;
    this.regripLanded = false;
    this.replay.rest(model, {
      field: perched,
      unit: build.unit,
      pace: build.pace,
      perch: this.perch(),
    });
  }

  /**
   * A transition to `to` from the levels shown now, the camera from `from`.
   * The creature's crossing, when it has set out on one, is the replay's leg:
   * the camera's way ends as it lands.
   */
  private start(to: SceneName, now: number, still: boolean, from: Camera): void {
    const w = this.replay.view.walk;
    const arrive = this.replay.view.mode === 'walk' && w?.void ? w.duration : null;
    // Either way the replay was just handed the perch of the shot as it is now: no grips are owed.
    this.regripLanded = false;
    this.running = {
      tr: transition(to, this.levels, this.knobs.times, still, arrive),
      start: now,
      from: { ...from },
      camera: true,
    };
    this.scene = to;
  }

  /** A transition under way, ended where it was going. */
  private finish(): void {
    if (!this.running) return;
    this.levels = { ...(this.running.tr.to === 'crawl' ? AT_CRAWL : AT_PROMPT) };
    this.running = null;
  }
}
