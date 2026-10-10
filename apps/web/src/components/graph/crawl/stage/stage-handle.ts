// What the Sentinel view's plugin asks of its stage, as types alone: the
// plugin (crawl-plugin.ts) is loaded with the graph's chunk and must never
// pull three in, so it knows the stage only through this, and the stage's
// module only through a dynamic import. The stage is sentinel-stage.ts; a
// test hands the plugin a fake instead.

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel } from '@/lib/graph-model';

import type { PluginFrame } from '../../graph-controller';
import type { ReplayEvent, ReplayView } from '../replay-view';
import type { PerchShot } from '../prompt/perch-geometry';
import type { IdleLife, PromptFrame } from '../prompt/prompt-scene';
import type { SpaceBuild } from '../space/space';

/** A frame of the stage: the controller's, and what the plugin made of it. */
export interface StageFrame extends PluginFrame {
  /** The replay after this frame's step, and what happened during it. */
  view: ReplayView;
  events: readonly ReplayEvent[];
  /** The prompt scene this frame (levels, gaze, atRest), or null when there is none to show. */
  scene: PromptFrame | null;
  /** The creature drawn: the Sentinel switch. Off, a stand-in eye rides the walk. */
  sentinel: boolean;
  /** The body's idle life at the prompt, blended in by `scene.levels.prompt`. */
  idle: IdleLife;
  /** Reduced motion, as the plugin holds it now: it follows a live change, the page's does not. */
  still: boolean;
}

/** What the plugin needs of the stage: SentinelStage, or a fake in a test. */
export interface StageHandle {
  /** Its own canvas, which the controller lays under the overlay and fades in. */
  readonly canvas: HTMLCanvasElement;
  /** A software rasteriser: the stage would crawl, so the trail is drawn instead. */
  readonly software: boolean;
  /** Lays the dormant network out over `model` (first build or again, its knobs kept). Throws when it cannot. */
  build(model: GraphModel): SpaceBuild;
  /**
   * Compiles what is not compiled yet for this canvas — the creature, the
   * frame and the veil the first time, the space after every build. Rejects
   * when a shader fails.
   */
  warmup(): Promise<void>;
  /** The notes that record a decision, by id: held across builds until set again. */
  setDecisions(ids: ReadonlySet<string>): void;
  /** The frame round the prompt shaped to `shot`, or hidden. */
  shapeBezel(shot: PerchShot | null): void;
  resize(vp: Viewport, dpr: number): void;
  /** Governor grace: compiles, uploads and sweeps stutter once. */
  hold(now: number): void;
  /** The creature placed where the replay is, at rest: a crawl loaded, a rest taken. */
  snap(view: ReplayView): void;
  /** The creature's still pose where the replay is: reduced motion, or a jump to the end. */
  finalPose(view: ReplayView): void;
  render(frame: StageFrame): void;
  /** Called once if the context is lost: nothing is restored, the plugin falls back. */
  onLost: (() => void) | null;
  dispose(): void;
}

/**
 * Makes a stage sized for the container from the start: the GPU is probed
 * through it, and a canvas at the default 300 × 150 would never trip the cap
 * a 4K or HiDPI buffer puts on the starting tier. Reduced motion is not asked:
 * every frame says it (`StageFrame.still`). Throws without WebGL.
 */
export type StageFactory = (opts: { vp: Viewport; dpr: number }) => StageHandle;
