// A space of Crawl's own: where the notes stand, what the threads look like,
// and how it is drawn — instead of the brain the other views share. The lab
// tries several; the Crawl view will show one.
//
// A space builds from the graph model (positions are its own, never the
// brain's) and hands the crawl a ThreadField, the only thing the replay and
// the Sentinel read. It draws first, into the canvas, writing depth; the
// Sentinel then draws into the same depth, so a pipe in front of a tentacle
// hides it. Everything it changes on the renderer it restores.
//
// A space that stays dark until the crawl wakes it is told where the
// Sentinel's eye is each frame (`SpaceFrame.eye`): what the eye looks at is
// what it reveals. Which notes record a decision comes from the data, after
// the build (`setDecisions`), and a space may compile its shaders before its
// first frame (`warmup`). All three are optional: a space that needs none of
// them ignores them.

import type * as THREE from 'three';
import type GUI from 'three/addons/libs/lil-gui.module.min.js';

import type { Bounds, Camera, Viewport } from '@/lib/graph-camera';
import type { GraphModel } from '@/lib/graph-model';

import type { ReplayView } from '../replay-view';
import type { ThreadField } from '../threads';
import type { Vec3 } from '../vec';

export interface SpaceBuild {
  /** Where each note stands in the space, by node id, world units. */
  positions: ReadonlyMap<string, Vec3>;
  /** Its threads and notes, for the replay and the Sentinel. */
  field: ThreadField;
  /** World units per creature unit: the space sets the Sentinel's scale, not the brain's links. */
  unit: number;
  /** Everything the space draws, to frame it. */
  bounds: Bounds;
  /** The fastest a walk may go here, world units a second; null leaves the replay's own pace. */
  pace: number | null;
  /** How the camera sees it best: pitch in radians, and the follow distance in creature units. */
  camera: { pitch: number; follow: number };
}

export interface SpaceFrame {
  cam: Camera;
  vp: Viewport;
  dpr: number;
  /** The crawl as it stands: what is lit and found. Null before one is loaded. */
  view: ReplayView | null;
  /** Seconds, for anything that moves on its own. */
  time: number;
  /** Reduced motion: nothing moves on its own. */
  still: boolean;
  /**
   * The Sentinel's eye, world space: where the lens is, the way it looks (unit
   * length) and how bright it is (1 at rest, more when it finds something). A
   * space that wakes under the eye lights what falls in its cone. With the
   * creature off, whoever draws may pass a stand-in eye at the walk, so the
   * reveal still happens; null or absent, nothing is revealed.
   */
  eye?: { position: Vec3; dir: Vec3; intensity: number } | null;
}

export interface CrawlSpace {
  /** Shown in the lab's picker. */
  readonly name: string;
  /** Lays the model out and builds what it draws. Called again when the model changes. */
  build(model: GraphModel): SpaceBuild;
  /**
   * Clears the canvas and draws the space, writing depth, with a camera that
   * matches the graph's. Restores every renderer setting it touches.
   */
  render(renderer: THREE.WebGLRenderer, frame: SpaceFrame): void;
  /** The near and far planes its last frame used, world units: the Sentinel draws into that depth. */
  readonly depth: { near: number; far: number } | null;
  /** What its last frame cost, for the lab. */
  readonly info: { calls: number; triangles: number };
  /** Its own knobs, in the lab. */
  gui?(folder: GUI): void;
  /**
   * The notes that record a decision, by id — from the data (a decision tag,
   * the crawl's own flag), never guessed from a title. Takes effect at once,
   * before or after a build, and holds across builds until set again.
   */
  setDecisions?(ids: ReadonlySet<string>): void;
  /**
   * Compiles every shader the space draws with, for the canvas it will draw
   * into, so its first frame does not stall. Call it after a build; rejects
   * if a shader fails.
   */
  warmup?(renderer: THREE.WebGLRenderer): Promise<void>;
  dispose(): void;
}
