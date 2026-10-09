// The Sentinel lab's engine: everything /dev/sentinel runs, outside React.
//
// It is the Crawl integration in miniature, without the graph. A WebGLRenderer
// set up exactly as GraphScene sets up the graph's — same multisampling, clear
// colour, no tone mapping, pixel ratio — so the Sentinel meets the canvas it
// will meet in Crawl. The real CrawlReplay over the seeded sample vault, the
// real SentinelMotion and SentinelView, the camera eased toward the walk the
// way the graph controller eases it, and the quality governor fed the way
// Crawl will feed it, with the Sentinel's CPU and GPU time measured around its
// own work. What the lab adds is only for judging it: a stage to walk in, the
// crawl's labels on a 2D overlay above it, debug marks, and stats.
//
// The stage is the brain stand-in (the backdrop: the graph's look, drawn under
// the creature or over it, walked exactly as Crawl walks the brain today) or
// one of the spaces of Crawl's own (lab-spaces.ts). A space lays the
// notes out itself and hands the replay its own threads, scale and pace; it
// draws first, clearing and writing depth, and the Sentinel draws into that
// depth, so a thread in front hides a tentacle, reflecting the space's light.
// Its cost is measured apart from the Sentinel's, which is all the governor
// sees, as in Crawl. Either stage walks the 69-note sample vault or a seeded
// one of 1,600 notes, to judge it at the density a real vault has.
//
// The lab opens on the dormant network over the large vault: the space Crawl
// is meant to walk, at a real vault's size, with the flat follow camera the
// brain stand-in uses — the whole cluster at first, then easing after the
// walk, then what it found once done; a drag orbits, shift-drag pans, the
// wheel zooms, Follow hands the camera back. A space is also told where the
// Sentinel's eye is each frame (or a stand-in's, with the creature off or not
// ready), which notes record a decision, and compiles its shaders before it
// first draws.
//
// Over a space, once the page hands it the prompt (`attachPrompt`), the lab
// opens on the prompt scene, as Crawl will: the input at the centre, the
// Sentinel clinging to the frame round it, big on screen, the cluster not
// drawn at all. A send — or a recent crawl touched — runs the transition into
// the crawl: the panel slides in, the cluster fades up from under a veil of
// the background, the camera backs out to the overview and the creature lets
// go and crosses to the crawl's first note; "New search" runs it back.
// prompt/prompt-scene.ts decides all of it; the lab draws it, writes the
// levels to the page as CSS variables, and hands the camera between the
// scene's timeline, the follow camera and the user. At the prompt nothing may
// move the camera, or the frame would leave the box.
//
// The stage's pass then depends on where the scene is. At rest at the prompt:
// a clear, the Sentinel in the frame's planes, the frame. Under way: the
// space, the veil over it while the cluster is below full, its depth cleared
// then — crystals veiled to nothing must not cut holes in the creature — the
// Sentinel in the space's planes, the frame over it. In the crawl, as ever.
// The frame is always drawn after the creature, with the depth test on: it
// hides what lies behind it, and fades over it rather than cutting it out.
//
// It owns its canvases. A canvas keeps its WebGL context for life, and one
// lost on purpose — forceContextLoss, which stops hot reloads from piling
// contexts up — stays lost; React's Strict Mode mounts, unmounts and mounts
// again, and the second mount needs a canvas of its own.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  boundsOf,
  orbitBy,
  panBy,
  projector,
  type Camera,
  type Viewport,
} from '@/lib/graph-camera';
import { hash01 } from '@/lib/graph-model';

import type { CrawlSnapshot } from '../../crawl-layer';
import { CrawlReplay } from '../../crawl-replay';
import { PERCH_RAIL_SET } from '../../prompt/perch-field';
import { PromptScene, type IdleLife, type PromptFrame } from '../../prompt/prompt-scene';
import { promptRecents, type PromptRecent } from '../../prompt/recents';
import { cameraBetween, type Levels, type SceneName } from '../../prompt/transition';
import type { ReplayView } from '../../replay-view';
import { sampleVault, type SampleVault } from '../../sample-vault';
import { largeVault } from '../../space/large-vault';
import type { SpaceBuild } from '../../space/space';
import { PromptBezel } from '../../stage/bezel';
import { notesReach, overviewCamera } from '../../stage/overview';
import { Veil } from '../../stage/veil';
import { typicalLink } from '../../threads';
import type { Vec3 } from '../../vec';
import { GRIP_SLOTS, TENTACLES } from '../anatomy';
import { assertRendererState, withRendererState } from '../gl-state';
import { GpuTimer } from '../gpu-timer';
import { DEFAULT_GRIP, type GripParams } from '../grips';
import { defaultLook, type SentinelLook } from '../look';
import { SentinelMotion, type MotionParams } from '../motion';
import { probeCaps } from '../probe';
import { QualityGovernor, recallStable, startTier, type Caps } from '../quality';
import { SENTINEL_SEED, tentacleCharacter, type Rig } from '../rig';
import { TIERS, type Tier } from '../tiers';
import { SentinelView, creatureBounds } from '../view';

import { LabBackdrop } from './backdrop';
import { drawCrawl, drawDebug, drawNotes, drawPerch, type Project } from './lab-overlay';
import { LAB_ASKED, labRecents } from './lab-prompt';
import {
  DEFAULT_SPACE,
  LAB_SPACES,
  blankEye,
  labDecisions,
  sentinelEye,
  standInEye,
  type LabSpace,
  type LabSpaceReport,
  type SpaceEye,
} from './lab-spaces';

export type Preset = keyof SampleVault['crawls'];
export const PRESETS: readonly Preset[] = ['walk', 'gap', 'ask', 'tour'];

export type EnvironmentPreset = 'hangar' | 'room';
export const ENVIRONMENTS: readonly EnvironmentPreset[] = ['hangar', 'room'];

export type TierChoice = 'auto' | 'T0' | 'T1' | 'T2' | 'T3';
export const TIER_CHOICES: readonly TierChoice[] = ['auto', 'T0', 'T1', 'T2', 'T3'];
const FORCED: Readonly<Record<TierChoice, Tier | null>> = {
  auto: null,
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export type BackdropOrder = 'under' | 'over';
export const BACKDROP_ORDERS: readonly BackdropOrder[] = ['under', 'over'];

/** The stage that walks the brain: the backdrop, and the brain's own threads and positions. */
export const BRAIN_STANDIN = 'brain stand-in';
/** The brain stand-in, or the name of one of the lab's spaces. */
export type SpaceChoice = string;
export const SPACES: readonly SpaceChoice[] = [BRAIN_STANDIN, ...LAB_SPACES.map((s) => s.name)];

export type VaultChoice = 'sample' | 'large';
export const VAULTS: readonly VaultChoice[] = ['sample', 'large'];
/** The vault the lab opens on: the density a real vault has. */
const DEFAULT_VAULT: VaultChoice = 'large';

/** What the panel binds to. Plain fields the frame reads; the setters below do the rest. */
export interface LabControls {
  /** Where the Sentinel walks. */
  space: SpaceChoice;
  /** The 69-note sample vault, or a seeded one of 1,600. */
  vault: VaultChoice;
  /**
   * The creature drawn. Off, the space walks alone, as Crawl will show it when
   * the Sentinel cannot draw: a stand-in eye at the walk still wakes it.
   */
  sentinel: boolean;
  playing: boolean;
  /** Playback speed of the replay; the creature itself always lives in real time. */
  speed: number;
  preset: Preset;
  /** Mirrors the replay: false once the camera was taken. */
  following: boolean;
  reducedMotion: boolean;
  /** Notes wander slowly, as while a layout settles. */
  drift: boolean;
  /** Scales every tentacle's seeded twist per segment. */
  twist: number;
  environment: EnvironmentPreset;
  tier: TierChoice;
  /** Busy-waits this long inside the Sentinel's CPU time each frame. */
  slowCpuMs: number;
  /**
   * Makes the GPU finish the stage's pass before the Sentinel's is timed. A
   * timer query reads the GPU clock as commands go in, not as they complete,
   * so whatever of a heavy space is still drawing when the Sentinel's timer
   * starts is counted as the Sentinel's — which is what the governor reads.
   * In the Hive, on 1,600 notes, the Sentinel measured 5.5 ms at
   * T0 and at T3 alike, and the space under 1 ms; split, 0.4 and 0.8 ms, and
   * the space 2 to 5. WebGL has no blocking wait but a read: reading one
   * pixel back is the sync, at the cost of the overlap between CPU and GPU.
   */
  splitGpu: boolean;
  /** The brain stand-in's backdrop, and whether it draws under the creature or over it. */
  backdrop: boolean;
  backdropOrder: BackdropOrder;
  /** A space lends the Sentinel its light, so the metal reflects where it walks. Off: the hangar. */
  lendEnvironment: boolean;
  /** Over a space, the overlay's halos on found notes as well as the space's own light on them. */
  spaceHalos: boolean;
  /**
   * Lit threads, found notes and labels, as the Crawl view's overlay draws
   * them. Over a space, labels only (and halos when asked): it lights its own.
   */
  overlay: boolean;
  /** Joints, targets and grip slots. */
  debug: boolean;
}

/** Read-only text for the panel's Stats folder, refreshed twice a second. */
export interface LabStats {
  /** The stage, and how long it took to build. */
  space: string;
  /** Its draws and triangles last frame, apart from the Sentinel's. */
  spaceCost: string;
  /** Its CPU and GPU time, p50, apart from the Sentinel's. */
  spaceTime: string;
  /** The space's shape, as it reports it. */
  shape: string;
  /** State texture uploads a second: 0 once nothing new happens. */
  uploads: string;
  /** What switching space ten times left behind. */
  cycle: string;
  /** What switching vault ten times left behind. */
  vaultCycle: string;
  fps: string;
  dt: string;
  cpu: string;
  sim: string;
  gpu: string;
  draws: string;
  triangles: string;
  programs: string;
  memory: string;
  tier: string;
  segments: string;
  governor: string;
  renderer: string;
  status: string;
  rebuild: string;
  /** The prompt scene: where it is, the frame's size, the shot, the camera's pull, the claws on the frame. */
  prompt: string;
  /** What going from the prompt to the crawl and back twenty times left behind. */
  promptCycle: string;
}

/** What the lab's prompt and panel show, as React reads it: sent whenever it changes. */
export interface LabPromptUi {
  scene: SceneName;
  /** The stage can show the prompt: a space, and a place for the box in it. */
  available: boolean;
  /** The input takes text and a send. */
  interactive: boolean;
  /** Bumped whenever the input should take focus: each time it takes text again at the prompt. */
  focus: number;
  /** What the crawl on screen was asked. */
  asked: string;
  recents: PromptRecent[];
}

/** The motion params the prompt's idle life stands in for, blended by its level: the body's, never the tentacles'. */
const IDLE_KEYS = [
  'breathing',
  'humAmplitude',
  'bob',
] as const satisfies readonly (keyof IdleLife)[];

/** The CSS variables the lab writes on the page for the prompt and the panel. */
const PROMPT_CSS = [
  '--crawl-prompt',
  '--crawl-panel',
  '--crawl-prompt-visibility',
  '--crawl-glass-alpha',
  '--crawl-glass-blur',
] as const;

/**
 * Frames a cycle waits for the scene to get somewhere before it gives up: 30 s
 * at 60 fps. Counted in frames, not seconds — the walk, and the transitions on
 * its clock, advance at most 64 ms a frame, so on a throttled tab a transition
 * takes longer than its seconds.
 */
const CYCLE_WAIT_FRAMES = 1800;

/** Where the Sentinel walks: the brain stand-in, or a space built over the vault's notes. */
type Stage =
  | { kind: 'brain'; backdrop: LabBackdrop }
  | {
      kind: 'space';
      name: string;
      space: LabSpace;
      /** The object its knobs live on, for "export settings". */
      knobs: object;
      /** Its lines for the Stats folder, when it has any. */
      report: (() => LabSpaceReport | null) | null;
      build: SpaceBuild;
      /** How long `build` took, ms. */
      buildMs: number;
      /**
       * Its shaders compiled for this canvas (warmup settled). Until then it
       * does not draw, so its first frame does not stall on a compile.
       */
      warm: boolean;
    };
type SpaceStage = Extract<Stage, { kind: 'space' }>;
type Kept = Pick<SpaceStage, 'space' | 'knobs' | 'report'>;

/** A vault as the lab holds it, with what the brain stand-in and the overlay need of it. */
interface LabVault extends SampleVault {
  /** Each note's world radius and pulse phase, for the overlay's found halos. */
  notes: ReadonlyMap<string, { radius: number; phase: number }>;
  /** The notes that record a decision, as the lab stands in for the data (labDecisions). */
  decisions: ReadonlySet<string>;
  /**
   * Where the vault laid each note out, six numbers a note (x, y, z, ox, oy,
   * oz): the brain stand-in's places, which a space overwrites, put back when
   * the brain stand-in returns, and drift's home.
   */
  home: Float64Array;
  phases: Float64Array;
}

function openVault(choice: VaultChoice): LabVault {
  const vault = choice === 'large' ? largeVault() : sampleVault();
  const nodes = vault.model.nodes;
  const home = new Float64Array(nodes.length * 6);
  const phases = new Float64Array(nodes.length);
  nodes.forEach((n, i) => {
    home.set([n.x, n.y, n.z || 0, n.ox, n.oy, n.oz], i * 6);
    phases[i] = hash01(n.id) * Math.PI * 2;
  });
  return {
    ...vault,
    notes: new Map(nodes.map((n) => [n.id, { radius: n.radius, phase: n.phase }])),
    decisions: labDecisions(vault),
    home,
    phases,
  };
}

/** How far the notes wander with drift on, creature units, and how slowly. */
const DRIFT = 0.3;
const DRIFT_RATE = [0.31, 0.23, 0.27] as const;
/** Frames the stats look back over. */
const STATS_FRAMES = 240;
const STATS_EVERY_MS = 500;
/** How long dispose waits for a shader compile still polling before freeing the renderer. */
const COMPILE_WAIT_MS = 5000;
/** The lab's angle, at first and after every change of space: one view to compare them by. */
const LAB_YAW = 0.5;
const BRAIN_PITCH = 0.16;
/** A found note's halo over a space, creature units: about a brain note's size beside its links. */
const SPACE_NOTE_RADIUS = 0.3;
/**
 * Frames a new stage draws before its programs count as settled: the first
 * bakes its light and compiles its shaders.
 */
const SETTLE_FRAMES = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)} ms` : '…');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1));
    tick(n);
  });

/** The last few hundred samples of something measured every frame. */
class Samples {
  private readonly values: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private count = 0;

  constructor(n: number) {
    this.values = new Float64Array(n);
    this.sorted = new Float64Array(n);
  }

  push(v: number): void {
    this.values[this.head] = v;
    this.head = (this.head + 1) % this.values.length;
    if (this.count < this.values.length) this.count++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** NaN when nothing was measured. */
  percentile(p: number): number {
    if (this.count === 0) return NaN;
    const s = this.sorted.subarray(0, this.count);
    s.set(this.values.subarray(0, this.count));
    s.sort();
    return s[Math.min(this.count - 1, Math.floor(p * this.count))]!;
  }

  mean(): number {
    if (this.count === 0) return NaN;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.values[i]!;
    return sum / this.count;
  }
}

/** Spins for `duration` ms: a slow CPU, simulated. Returns the spins, so nothing optimises it away. */
function busyWait(duration: number): number {
  const until = performance.now() + duration;
  let spins = 0;
  while (performance.now() < until) spins++;
  return spins;
}

function canvas(container: HTMLElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.position = 'absolute';
  c.style.inset = '0';
  c.style.display = 'block';
  c.style.width = '100%';
  c.style.height = '100%';
  container.appendChild(c);
  return c;
}

export class LabHost {
  readonly controls: LabControls;
  readonly stats: LabStats;
  readonly motion = new SentinelMotion();
  /** Shared by every view the lab makes: it survives a rebuild or a change of environment. */
  readonly look: SentinelLook = defaultLook();
  /**
   * The replay plans grips with the grip planner's module defaults, and takes
   * no parameters of its own: the lab tunes those defaults in place — from
   * the next leg on — and puts them back when it goes.
   */
  readonly grip: GripParams = DEFAULT_GRIP;
  /**
   * Called whenever the stage changes, from the panel or from within (a
   * switch ×10, a space that failed to build): the panel refills its Space
   * folder with the new stage's knobs.
   */
  onStageChange: (() => void) | null = null;
  /** Every snapshot the replay emits: what the panel shows of the walk. */
  onSnapshot: ((s: CrawlSnapshot) => void) | null = null;
  /** The prompt scene: its `knobs` are what the Prompt folder binds. */
  readonly scene: PromptScene;
  /** The frame round the prompt: its `look` is what the Bezel folder binds. */
  readonly bezel: PromptBezel;
  /**
   * The panel's motion params, which the GUI binds; the motion reads a copy
   * with the prompt's idle life blended in, so the walk's values stay as tuned.
   */
  readonly params: MotionParams;
  /** The prompt box's glass, written to the page as CSS variables: its alpha, and its blur in px. */
  readonly glass = { alpha: 0.5, blur: 12 };

  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly caps: Caps;
  private readonly startTrail: boolean;
  private readonly governor: QualityGovernor;
  /** The Sentinel's GPU time, which the governor reads. */
  private readonly timer: GpuTimer | null;
  /** The stage's, apart: a space's cost must not step the creature down. */
  private readonly spaceTimer: GpuTimer | null;
  private vault: LabVault;
  private stage: Stage;
  /** Why the space asked for is not on screen, when it failed to build. */
  private spaceFailure: string | null = null;
  /** World units per creature unit: the vault's typical link on the brain stand-in, else the space's. */
  private unit = 1;
  /** The farthest the wheel goes out: far enough to see the whole stage. */
  private farthest = 1;
  /** Each space's follow distance when last left: a tuned one survives a change of space and back. */
  private readonly follows = new Map<SpaceChoice, number>();
  private readonly replay: CrawlReplay;
  private readonly gripDefaults: GripParams = { ...DEFAULT_GRIP };
  private readonly baseTwist: Float32Array;
  private readonly font: string;
  private readonly resizeObserver: ResizeObserver;

  private view: SentinelView;
  private warming: Promise<void> = Promise.resolve();
  private ready = false;
  private failure: string | null = null;
  private room: RoomEnvironment | null = null;
  private tier: Tier | 'trail';
  private still: boolean;
  private rebuilding = false;
  private disposed = false;

  private cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: LAB_YAW, pitch: BRAIN_PITCH, dist: 1 };
  private vp: Viewport = { width: 1, height: 1 };
  private dpr = 1;
  private resized = true;
  private drag: { x: number; y: number; pan: boolean } | null = null;
  private raf = 0;
  private lastNow: number | null = null;

  /** Drift has moved the notes off their home. */
  private drifting = false;

  private readonly dts = new Samples(STATS_FRAMES);
  private readonly cpus = new Samples(STATS_FRAMES);
  private readonly sims = new Samples(STATS_FRAMES);
  private readonly gpus = new Samples(STATS_FRAMES);
  private readonly spaceCpus = new Samples(STATS_FRAMES);
  private readonly spaceGpus = new Samples(STATS_FRAMES);
  private spaceDrawn = { calls: 0, triangles: 0 };
  /** Where `splitGpu` reads the one pixel that makes the GPU finish the stage's pass. */
  private readonly pixel = new Uint8Array(4);
  private statsAt = 0;
  private lastReason = '';
  /**
   * Programs once the view warmed up and the stage drew its first frames: the
   * count must stay there, or something compiles mid-crawl.
   */
  private programsAtReady: number | null = null;
  /** Frames left before a new stage's programs count as settled. */
  private settleIn = 0;
  /** Settles once the stage's shaders are compiled, or failed to: what a cycle waits for. Never rejects. */
  private stageWarming: Promise<void> = Promise.resolve();
  /** A space's compile is polling the renderer right now: the renderer must outlive it. */
  private stageCompiling = false;
  /** The eye a space is told about, written in place every frame. */
  private readonly eye: SpaceEye = blankEye();
  /** The space's upload count at the last stats refresh, and when: the rate is the difference. */
  private uploadsSeen: { count: number; at: number } | null = null;

  /** Over the background, the cluster fading in and out. */
  private readonly veil: Veil;
  /** What the motion reads: `params`, with the prompt's idle life blended in. */
  private readonly live: MotionParams;
  /** The page's prompt: the box the frame is fitted to, the element the levels are written on, who hears of changes. */
  private prompt: {
    box: HTMLElement;
    chrome: HTMLElement;
    listener: (ui: LabPromptUi) => void;
  } | null = null;
  /** The box and the stage as last laid out: the scene is laid out again only when they change. */
  private promptRects: number[] = [];
  /** Lay the scene out again at the next frame: the stage resized, or a knob moved (and the claws take hold anew). */
  private promptDirty: 'move' | 'regrip' | null = null;
  /** The prompt was asked for and could not be placed yet — the box had no size: it rests as soon as it can. */
  private promptPending = false;
  /** The frame's and the veil's shaders compiled: neither draws before. */
  private promptWarm = false;
  private promptFailure: string | null = null;
  /** Settles once their compile has, or failed to. Never rejects. */
  private promptWarming: Promise<void> = Promise.resolve();
  /** Their compile is polling the renderer right now: the renderer must outlive it. */
  private promptCompiling = false;
  /**
   * The prompt scene's clock, seconds: the replay's steps added up — capped,
   * at the panel's speed, none while paused — never wall time. The scene times
   * the camera's way to end as the creature's crossing lands, on the clock the
   * crossing runs on; on wall time a slow speed, a pause or a frame past the
   * cap would bring the camera to the overview with the creature still
   * mid-void, and back to the perch shot with the claws not yet on the frame.
   */
  private sceneClock = 0;
  /** This frame's scene, for the overlay, the stats and the cycles. */
  private sf: PromptFrame | null = null;
  /** The follow camera while the timeline hands over to it: eased on its own, shown blended in. */
  private chase: Camera | null = null;
  /** What the page was last given: written only when it changes. */
  private css = { prompt: '', panel: '', visibility: '' };
  private ui: LabPromptUi | null = null;
  private focusCount = 0;
  private asked = '';
  /** The recent crawls this view has shown: an assistant's is new until it is played. */
  private readonly seen = new Set<string>();
  /** When the lab opened, ms: its recents were made minutes before. */
  private readonly opened = Date.now();
  private recents: PromptRecent[] = [];
  /** How far the notes of a build reach from its overview's target: the perch keeps its gap from them. */
  private reach: { build: SpaceBuild; radius: number } | null = null;
  private cursor = '';

  constructor(private readonly container: HTMLElement) {
    this.glCanvas = canvas(container);
    this.overlay = canvas(container);
    this.setCursor('grab');
    this.overlay.style.touchAction = 'none';
    const ctx = this.overlay.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas context');
    this.ctx = ctx;

    // Exactly as graph-scene.ts makes the graph's: the Sentinel draws into this canvas as it will into that one.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.glCanvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // Whatever fails from here on, the context must not outlive it: a page gets
    // only a few, and the next mount needs one.
    let made: SentinelView | null = null;
    let stage: Stage | null = null;
    let bezel: PromptBezel | null = null;
    let veil: Veil | null = null;
    try {
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.fit();
      // The panel tunes `params`; the motion reads `live`, the same with the prompt's life blended in.
      this.params = this.motion.params;
      this.live = { ...this.params };
      this.motion.params = this.live;

      this.caps = probeCaps(this.renderer);
      const start = startTier(this.caps, recallStable());
      this.startTrail = start === 'trail';
      this.tier = start;
      this.governor = new QualityGovernor(start === 'trail' ? 0 : start, this.caps.timer);
      const gl = this.renderer.getContext();
      const gl2 =
        this.caps.timer &&
        typeof WebGL2RenderingContext !== 'undefined' &&
        gl instanceof WebGL2RenderingContext
          ? gl
          : null;
      // Two timers, one after the other and never nested (a context times one query at a time).
      this.timer = gl2 ? GpuTimer.create(gl2) : null;
      this.spaceTimer = gl2 ? GpuTimer.create(gl2) : null;

      this.vault = openVault(DEFAULT_VAULT);
      this.follows.set(BRAIN_STANDIN, this.params.followDistance);
      this.baseTwist = Float32Array.from(
        { length: TENTACLES },
        (_, i) => tentacleCharacter(i, SENTINEL_SEED).twist,
      );
      this.font =
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        'ui-monospace, monospace';

      this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.controls = {
        space: DEFAULT_SPACE,
        vault: DEFAULT_VAULT,
        sentinel: true,
        playing: true,
        speed: 1,
        preset: 'walk',
        following: true,
        reducedMotion: this.still,
        drift: false,
        twist: 1,
        environment: 'hangar',
        tier: 'auto',
        slowCpuMs: 0,
        splitGpu: true,
        backdrop: true,
        backdropOrder: 'under',
        lendEnvironment: true,
        spaceHalos: false,
        overlay: true,
        debug: false,
      };
      this.stats = {
        space: '…',
        spaceCost: '…',
        spaceTime: '…',
        shape: '—',
        uploads: '—',
        cycle: '—',
        vaultCycle: '—',
        fps: '…',
        dt: '…',
        cpu: '…',
        sim: '…',
        gpu: this.timer ? '…' : 'n/a',
        draws: '…',
        triangles: '…',
        programs: '…',
        memory: '…',
        tier: '…',
        segments: '…',
        governor: '—',
        renderer: this.caps.renderer ?? 'unknown',
        status: '…',
        rebuild: '—',
        prompt: '—',
        promptCycle: '—',
      };

      // Built before the view: the view lends a space's light as it warms up.
      stage = this.makeStage(DEFAULT_SPACE, null);
      this.stage = stage;
      if (stage.kind === 'space') this.params.followDistance = stage.build.camera.follow;
      this.unit = stage.kind === 'space' ? stage.build.unit : typicalLink(this.vault.model);

      this.replay = new CrawlReplay((s) => this.onSnapshot?.(s));
      this.scene = new PromptScene(this.replay);
      bezel = new PromptBezel();
      this.bezel = bezel;
      veil = new Veil();
      this.veil = veil;
      this.refreshRecents();
      if (this.tier !== 'trail') this.motion.setTier(this.tier);
      made = this.createView();
      this.view = made;
      // The crawl until the page hands in the prompt (attachPrompt), which then takes over.
      this.load(this.controls.preset);
      this.frameStage();
      this.warmStage();
      this.warmPrompt();

      this.overlay.addEventListener('pointerdown', this.onPointerDown);
      this.overlay.addEventListener('pointermove', this.onPointerMove);
      this.overlay.addEventListener('pointerup', this.onPointerUp);
      this.overlay.addEventListener('pointercancel', this.onPointerUp);
      this.overlay.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('resize', this.onResize);
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
      this.raf = requestAnimationFrame(this.frame);
    } catch (error) {
      this.disposed = true;
      cancelAnimationFrame(this.raf);
      window.removeEventListener('resize', this.onResize);
      made?.dispose();
      if (stage?.kind === 'space') stage.space.dispose();
      else stage?.backdrop.dispose();
      bezel?.dispose();
      veil?.dispose();
      this.freeRenderer();
      throw error;
    }
  }

  // -- What the panel calls ------------------------------------------------------

  /** The space the Sentinel walks in, for its knobs; null on the brain stand-in. */
  get space(): LabSpace | null {
    return this.stage.kind === 'space' ? this.stage.space : null;
  }

  /**
   * Walks the Sentinel somewhere else. The old stage goes — the Sentinel gives
   * back the light it borrowed first, and its GPU resources go while the
   * renderer lives — the new one is laid out over the same notes, and the
   * crawl starts again in it, framed as the space suggests.
   */
  setSpace(choice: SpaceChoice): void {
    if (this.disposed) return;
    // From the stage, not the controls: the panel has already written the new choice there.
    this.follows.set(this.stageChoice(), this.params.followDistance);
    this.leave();
    this.stage = this.makeStage(choice, null);
    const s = this.stage;
    this.params.followDistance =
      this.follows.get(this.stageChoice()) ??
      (s.kind === 'space' ? s.build.camera.follow : this.params.followDistance);
    this.enter();
    this.onStageChange?.();
  }

  /**
   * Another vault: the same stage laid out again over its notes, a space's
   * knobs kept, and the crawl started over — or, at the prompt, the creature
   * back on the frame in front of the new cluster.
   */
  setVault(choice: VaultChoice): void {
    if (this.disposed) return;
    this.controls.vault = choice;
    this.restage(openVault(choice));
    this.refreshRecents();
  }

  /** The crawl the walk plays. At the prompt it only picks what a send plays. */
  setPreset(preset: Preset): void {
    this.controls.preset = preset;
    if (this.promptHolds()) return;
    this.load(preset);
  }

  /** The crawl from its first note again; nothing at the prompt, where there is no crawl to replay. */
  replayAgain(): void {
    if (this.promptHolds()) return;
    this.replay.replay();
    this.motion.snap(this.replay.view);
    if (this.still) this.settleAtEnd();
  }

  setFollowing(on: boolean): void {
    if (on) this.replay.followAgain();
    else this.replay.onUserCamera();
  }

  /**
   * Reduced motion, as Crawl will honour it: the crawl jumps to its end and
   * the creature to its still pose. At the prompt, or on the way back to it,
   * the creature is on the frame at once, its grips landed; a transition
   * under way ends at the next frame.
   */
  setReducedMotion(on: boolean): void {
    this.controls.reducedMotion = on;
    this.still = on;
    if (!on) return;
    if (this.promptHolds()) {
      this.replay.skipToEnd();
      this.replay.drain();
      this.motion.finalPose(this.replay.view);
    } else this.settleAtEnd();
  }

  // -- The prompt ----------------------------------------------------------------

  /**
   * The page's prompt: `box` is the input's box, which the frame is fitted to
   * (measured against the lab's container, never transformed); `chrome` the
   * element the levels are written on as CSS variables, an ancestor of both
   * the prompt and the panel. Over a space, the lab goes to the prompt scene
   * at once. `listener` hears whatever the prompt and the panel show change.
   */
  attachPrompt(
    dom: { box: HTMLElement; chrome: HTMLElement },
    listener: (ui: LabPromptUi) => void,
  ): void {
    if (this.disposed) return;
    this.prompt = { box: dom.box, chrome: dom.chrome, listener };
    this.ui = null;
    this.css = { prompt: '', panel: '', visibility: '' };
    this.writeGlass();
    this.enterScene(true);
  }

  /** The page's prompt gone: its variables taken off the page, and the crawl as the lab walked it before. */
  detachPrompt(): void {
    const p = this.prompt;
    if (!p) return;
    for (const name of PROMPT_CSS) p.chrome.style.removeProperty(name);
    this.prompt = null;
    this.ui = null;
    this.sf = null;
    if (!this.disposed) this.enterScene();
  }

  /**
   * A question sent from the prompt. The lab has no gather to run: it plays
   * the preset picked in the panel, as if that were what the question found.
   */
  submit(text: string): void {
    const asked = text.trim();
    if (!asked || !this.startCrawl(this.controls.preset)) return;
    this.asked = asked;
  }

  /** A recent crawl touched (its id a preset): the same way into the crawl. It is seen from then on. */
  playRecent(id: string): void {
    const preset = PRESETS.find((p) => p === id);
    if (!preset || !this.startCrawl(preset)) return;
    this.controls.preset = preset;
    this.asked = LAB_ASKED[preset];
    this.seen.add(preset);
    this.refreshRecents();
  }

  /** "New search": back to the prompt from wherever the walk and the camera are. */
  newSearch(): void {
    if (this.disposed || !this.prompt) return;
    if (!this.scene.back(this.sceneClock, this.still, this.cam)) return;
    this.chase = null;
    this.governor.hold(performance.now());
    if (this.still) {
      // Back on the frame at once, its grips landed: what happened on the way flares for nothing.
      this.replay.skipToEnd();
      this.replay.drain();
      this.motion.finalPose(this.replay.view);
    }
  }

  /** A frame knob moved: the scene is laid out again at the next frame, and the claws take hold anew. */
  promptChanged(): void {
    this.promptDirty = 'regrip';
  }

  /** The glass knobs moved: written to the page. */
  glassChanged(): void {
    this.writeGlass();
  }

  /** The hangar the Sentinel ships with, or three's RoomEnvironment to compare: a new view either way. */
  setEnvironment(environment: EnvironmentPreset): void {
    this.controls.environment = environment;
    this.replaceView();
  }

  setTier(choice: TierChoice): void {
    this.controls.tier = choice;
    this.governor.force(FORCED[choice]);
    this.applyTier();
  }

  printGovernorLog(): void {
    console.info(`Sentinel governor:\n${this.governor.log.join('\n') || '(nothing yet)'}`);
  }

  /** What the lab settled on, to paste into the constants. */
  exportSettings(): string {
    const s = this.stage;
    return JSON.stringify(
      {
        vault: this.controls.vault,
        space:
          s.kind === 'space'
            ? { name: s.name, knobs: s.knobs }
            : {
                name: BRAIN_STANDIN,
                knobs: {
                  backdrop: this.controls.backdrop,
                  backdropOrder: this.controls.backdropOrder,
                },
              },
        // The panel's, not the copy the motion reads with the prompt's life blended in.
        motion: this.params,
        look: this.look,
        grip: { ...this.grip },
        // Not a parameter anywhere yet: it scales rig.ts's seeded twist per segment.
        twistScale: this.controls.twist,
        prompt: { ...this.scene.knobs, glass: { ...this.glass }, bezel: this.bezel.look },
      },
      null,
      2,
    );
  }

  /**
   * Disposes the view and makes a new one, `times` over, then compares the
   * renderer's memory and programs with what they were: anything that grew is
   * something a view does not free.
   */
  async rebuild(times = 20): Promise<void> {
    if (this.rebuilding || this.disposed) return;
    this.rebuilding = true;
    const before = this.memory();
    try {
      for (let i = 1; i <= times; i++) {
        this.stats.rebuild = `${i}/${times}…`;
        this.replaceView();
        await this.warming;
        if (this.disposed) return;
      }
      // Measured as before: with the new view having drawn.
      await frames(2);
      if (this.disposed) return;
      const after = this.memory();
      this.stats.rebuild = (['geometries', 'textures', 'programs'] as const)
        .map((k) => `${k} ${before[k]}→${after[k]}`)
        .join(' · ');
    } catch (error) {
      this.stats.rebuild = `stopped: ${message(error)}`;
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * Switches space `times` over, each drawing a few frames (baking its light,
   * compiling its programs), then back to where it started, and compares the
   * renderer's memory and programs with what they were: anything that grew is
   * something a space, or the light the Sentinel borrowed from it, does not free.
   */
  async cycleSpaces(times = 10): Promise<void> {
    const start = this.stageChoice();
    const first = SPACES.indexOf(start);
    await this.cycle(
      'cycle',
      times,
      (i) => this.setSpace(SPACES[(first + i) % SPACES.length]!),
      () => this.setSpace(start),
    );
  }

  /**
   * Switches vault `times` over, the same stage laid out again over each, then
   * back, and compares memory and programs as `cycleSpaces` does: anything that
   * grew is something a rebuild of the stage does not free.
   */
  async cycleVaults(times = 10): Promise<void> {
    const start = this.controls.vault;
    const first = VAULTS.indexOf(start);
    await this.cycle(
      'vaultCycle',
      times,
      (i) => this.setVault(VAULTS[(first + i) % VAULTS.length]!),
      () => this.setVault(start),
    );
  }

  private async cycle(
    stat: 'cycle' | 'vaultCycle',
    times: number,
    step: (i: number) => void,
    back: () => void,
  ): Promise<void> {
    if (this.rebuilding || this.disposed) return;
    this.rebuilding = true;
    const before = this.memory();
    try {
      for (let i = 1; i <= times; i++) {
        this.stats[stat] = `${i}/${times}…`;
        step(i);
        await this.settled();
        if (this.disposed) return;
      }
      // Measured as before: back where it started, drawn.
      back();
      await this.settled();
      if (this.disposed) return;
      const after = this.memory();
      this.stats[stat] = (['geometries', 'textures', 'programs'] as const)
        .map((k) => `${k} ${before[k]}→${after[k]}`)
        .join(' · ');
    } catch (error) {
      this.stats[stat] = `stopped: ${message(error)}`;
    } finally {
      this.rebuilding = false;
    }
  }

  /** Until the stage has compiled its shaders and drawn its first few frames. */
  private async settled(): Promise<void> {
    await this.stageWarming;
    await frames(SETTLE_FRAMES);
  }

  /**
   * Goes from the prompt to the crawl and back `times` over — a send, the
   * transition, New search, the way back until the claws are on the frame —
   * then compares the renderer's memory and programs with what they were, as
   * `cycleSpaces` does: anything that grew is something the frame, the veil
   * or a transition does not free. Needs the walk playing: a paused return
   * never lands, and the cycle stops.
   */
  async cyclePrompt(times = 20): Promise<void> {
    if (this.rebuilding || this.disposed || !this.prompt || !this.scene.available) return;
    this.rebuilding = true;
    const before = this.memory();
    try {
      for (let i = 1; i <= times; i++) {
        this.stats.promptCycle = `${i}/${times}…`;
        await this.until(() => this.sf?.interactive === true);
        if (this.disposed) return;
        if (!this.startCrawl(this.controls.preset)) throw new Error('the prompt refused the send');
        await this.until(() => {
          const sf = this.sf;
          return !!sf && sf.scene === 'crawl' && !sf.moving;
        });
        if (this.disposed) return;
        this.newSearch();
        await this.until(() => this.sf?.interactive === true);
        if (this.disposed) return;
      }
      // Measured as before: at the prompt, drawn.
      await frames(2);
      if (this.disposed) return;
      const after = this.memory();
      this.stats.promptCycle = (['geometries', 'textures', 'programs'] as const)
        .map((k) => `${k} ${before[k]}→${after[k]}`)
        .join(' · ');
    } catch (error) {
      this.stats.promptCycle = `stopped: ${message(error)}`;
    } finally {
      this.rebuilding = false;
    }
  }

  /** Until `done` holds at a frame; throws after CYCLE_WAIT_FRAMES. */
  private async until(done: () => boolean): Promise<void> {
    for (let n = 0; !done(); n++) {
      if (this.disposed) return;
      if (n > CYCLE_WAIT_FRAMES) throw new Error('timed out: is the walk paused?');
      await frames(1);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.overlay.removeEventListener('pointerdown', this.onPointerDown);
    this.overlay.removeEventListener('pointermove', this.onPointerMove);
    this.overlay.removeEventListener('pointerup', this.onPointerUp);
    this.overlay.removeEventListener('pointercancel', this.onPointerUp);
    this.overlay.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();

    this.onStageChange = null;
    this.onSnapshot = null;
    this.detachPrompt();

    // Everything on the GPU goes while the renderer that holds it is alive; the
    // view first, so it lets go of the light it borrowed before the space frees it.
    this.view.dispose();
    this.leave();
    this.bezel.dispose();
    this.veil.dispose();
    this.timer?.dispose();
    this.spaceTimer?.dispose();
    this.room?.dispose();
    Object.assign(DEFAULT_GRIP, this.gripDefaults);
    this.glCanvas.remove();
    this.overlay.remove();

    this.freeRenderer();
  }

  /**
   * Frees the renderer and its context. A shader compile still polling — the
   * view's, the space's, or the prompt frame's — reads the renderer's state
   * until it settles, and throws once that state is gone; the renderer goes
   * after all of them, or after a while if one never settles.
   */
  private freeRenderer(): void {
    const renderer = this.renderer;
    const free = () => {
      renderer.dispose();
      renderer.forceContextLoss();
    };
    const compiling: Promise<unknown>[] = [];
    if (!this.ready) compiling.push(this.warming.catch(() => {}));
    // Never rejects; disposed, the space's compile ends as soon as it settles.
    if (this.stageCompiling) compiling.push(this.stageWarming);
    // Never rejects either.
    if (this.promptCompiling) compiling.push(this.promptWarming);
    if (compiling.length === 0) free();
    else {
      const wait = new Promise<void>((resolve) => setTimeout(resolve, COMPILE_WAIT_MS));
      void Promise.race([Promise.all(compiling), wait]).then(free);
    }
  }

  // -- Views ---------------------------------------------------------------------

  private createView(): SentinelView {
    // Built here and only here: the bright studio is an A/B in the lab, never what Crawl ships.
    const environment =
      this.controls.environment === 'room' ? (this.room ??= new RoomEnvironment()) : undefined;
    const view = new SentinelView(this.renderer, {
      tier: this.tier === 'trail' ? 0 : this.tier,
      floatColor: this.caps.floatColor,
      environment,
    });
    view.look = this.look;
    // Lent before it warms up, a space's light is what the view compiles with: nothing compiles later.
    const space = this.space;
    if (space && this.controls.lendEnvironment) view.setEnvironment(space.environment);
    this.ready = false;
    this.failure = null;
    this.warming = view.warmup();
    void this.warming.then(
      () => {
        if (this.view !== view || this.disposed) return;
        this.ready = true;
        // The prompt frame's programs count too: until they are in, the count is not settled.
        if (this.promptSettled()) this.programsAtReady = this.memory().programs;
        // Uploads and the first frames after a compile stutter: no reason to step down.
        this.governor.hold(performance.now());
      },
      (error: unknown) => {
        // A view disposed while warming rejects on purpose; only the current one's failure counts.
        if (this.view !== view || this.disposed) return;
        this.failure = message(error);
        console.error('Sentinel lab: the view failed to warm up.', error);
      },
    );
    return view;
  }

  private replaceView(): void {
    this.view.dispose();
    this.view = this.createView();
  }

  private memory(): { geometries: number; textures: number; programs: number } {
    const info = this.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  private effectiveTier(): Tier | 'trail' {
    if (this.controls.tier === 'auto' && this.startTrail) return 'trail';
    return this.governor.tier;
  }

  /** Steps the detail; never a compile (tiers.ts). */
  private applyTier(): void {
    const tier = this.effectiveTier();
    if (tier === this.tier) return;
    this.tier = tier;
    if (tier === 'trail') return;
    this.motion.setTier(tier);
    this.view.setTier(tier);
  }

  // -- The stage -----------------------------------------------------------------

  private stageChoice(): SpaceChoice {
    return this.stage.kind === 'space' ? this.stage.name : BRAIN_STANDIN;
  }

  /**
   * The stage for `choice` over the current vault: the brain stand-in on the
   * vault's own positions, or one of the lab's spaces, built, with its
   * positions written into the notes and told the vault's decisions. `keep` is
   * a space to build again rather than make anew: the vault or a layout knob
   * changed, its knobs stay. A space that fails to build is let go and the
   * brain stand-in takes its place, the failure on screen.
   */
  private makeStage(choice: SpaceChoice, keep: Kept | null): Stage {
    this.spaceFailure = null;
    const entry = LAB_SPACES.find((s) => s.name === choice);
    if (entry) {
      const { space, knobs, report = null } = keep ?? entry.create();
      try {
        const t0 = performance.now();
        const build = space.build(this.vault.model);
        const buildMs = performance.now() - t0;
        this.place(build.positions);
        space.setDecisions?.(this.vault.decisions);
        // A knob that moves the notes lays the same vault out again, the crawl over.
        space.onRebuild = () => {
          if (!this.disposed && this.stage.kind === 'space' && this.stage.space === space) {
            this.restage(this.vault);
          }
        };
        this.controls.space = entry.name;
        const warm = !space.warmup;
        return { kind: 'space', name: entry.name, space, knobs, report, build, buildMs, warm };
      } catch (error) {
        // Only a space kept from the last stage can have lent the Sentinel its light.
        if (keep) this.view.setEnvironment(null);
        space.dispose();
        this.spaceFailure = `${entry.name} failed to build: ${message(error)}`;
        console.error(`Sentinel lab: ${entry.name} failed to build.`, error);
      }
    }
    this.controls.space = BRAIN_STANDIN;
    this.placeBrain();
    return { kind: 'brain', backdrop: new LabBackdrop(this.vault.model) };
  }

  /** Lets the stage go: the Sentinel gives back the light it borrowed before the space frees it. */
  private leave(): void {
    const s = this.stage;
    if (s.kind === 'space') {
      this.view.setEnvironment(null);
      s.space.dispose();
    } else s.backdrop.dispose();
  }

  /**
   * The same stage laid out again over `vault` — another one, or the same
   * after a knob that changes the layout — a space's knobs kept, and the
   * crawl started over.
   */
  private restage(vault: LabVault): void {
    const was = this.stage;
    const choice = this.stageChoice();
    if (was.kind === 'brain') was.backdrop.dispose();
    this.vault = vault;
    this.stage = this.makeStage(
      choice,
      was.kind === 'space' ? { space: was.space, knobs: was.knobs, report: was.report } : null,
    );
    this.enter();
    // A space that failed to build on these notes left the brain stand-in in its place.
    if (this.stage.kind !== was.kind) this.onStageChange?.();
  }

  /**
   * Compiles the space's shaders for this canvas before it first draws.
   * Until they are, the stage only clears, rather than stalling its first
   * frame. One compile at a time: a space built again while its last compile
   * still polls waits for it. A shader that fails leaves the brain stand-in in
   * its place, the failure on screen, as a build that fails does.
   */
  private warmStage(): void {
    const s = this.stage;
    if (s.kind !== 'space' || s.warm || !s.space.warmup) return;
    const space = s.space;
    this.stageWarming = this.stageWarming.then(async () => {
      // Left, or built again, while the last compile ran: that stage warms its own.
      if (this.disposed || this.stage !== s) return;
      this.stageCompiling = true;
      try {
        await space.warmup?.(this.renderer);
        if (this.stage === s) s.warm = true;
      } catch (error) {
        // A space let go while compiling rejects on purpose; only the current one's failure counts.
        if (this.disposed || this.stage !== s) return;
        console.error(`Sentinel lab: ${s.name} failed to warm up.`, error);
        this.fallBack(`${s.name} failed to warm up: ${message(error)}`);
      } finally {
        this.stageCompiling = false;
      }
    });
  }

  /**
   * Compiles the prompt frame's and the veil's shaders for this canvas before
   * either first draws: a transition must not stall on a compile. A shader
   * that fails leaves the prompt without its frame, the failure on screen.
   */
  private warmPrompt(): void {
    this.promptCompiling = true;
    this.promptWarming = Promise.allSettled([
      this.bezel.warmup(this.renderer),
      this.veil.warmup(this.renderer),
    ]).then((results) => {
      this.promptCompiling = false;
      if (this.disposed) return;
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        this.promptFailure = message(failed.reason);
        console.error('Sentinel lab: the prompt frame failed to warm up.', failed.reason);
      } else this.promptWarm = true;
      // New programs: the count settles again, a few frames on.
      this.programsAtReady = null;
      this.settleIn = Math.max(this.settleIn, SETTLE_FRAMES);
      this.governor.hold(performance.now());
    });
  }

  /** The prompt frame's compile is over, one way or the other. */
  private promptSettled(): boolean {
    return this.promptWarm || this.promptFailure !== null;
  }

  /** The brain stand-in in place of a space that cannot draw, and why on screen. */
  private fallBack(why: string): void {
    this.follows.set(this.stageChoice(), this.params.followDistance);
    this.leave();
    this.controls.space = BRAIN_STANDIN;
    this.placeBrain();
    this.stage = { kind: 'brain', backdrop: new LabBackdrop(this.vault.model) };
    this.spaceFailure = why;
    this.params.followDistance = this.follows.get(BRAIN_STANDIN) ?? this.params.followDistance;
    this.enter();
    this.onStageChange?.();
  }

  /** Whether the stage draws: the brain always, a space once its shaders are compiled. */
  private stageWarm(): boolean {
    return this.stage.kind === 'brain' || this.stage.warm;
  }

  /** The crawl (or the prompt), the camera and the governor, once the stage changed. */
  private enter(): void {
    const s = this.stage;
    this.unit = s.kind === 'space' ? s.build.unit : typicalLink(this.vault.model);
    this.frameStage();
    this.enterScene();
    // A build, a bake and new programs stutter: no reason to step the Sentinel down for them.
    this.governor.hold(performance.now());
    this.spaceCpus.clear();
    this.spaceGpus.clear();
    this.uploadsSeen = null;
    this.programsAtReady = null;
    this.settleIn = SETTLE_FRAMES;
    this.warmStage();
  }

  /**
   * The whole stage in view, from the lab's angle at the pitch the space
   * suggests: following, the camera then closes in on the walk. The brain
   * stand-in is framed as the lab always framed it.
   */
  private frameStage(): void {
    const s = this.stage;
    const bounds = s.kind === 'space' ? s.build.bounds : boundsOf(this.vault.model.nodes);
    const whole =
      s.kind === 'space'
        ? overviewCamera(s.build.bounds, this.vp, LAB_YAW, s.build.camera.pitch).dist
        : this.unit * 20;
    this.cam = {
      tx: bounds?.cx ?? 0,
      ty: bounds?.cy ?? 0,
      tz: bounds?.cz ?? 0,
      yaw: LAB_YAW,
      pitch: s.kind === 'space' ? s.build.camera.pitch : BRAIN_PITCH,
      dist: whole,
    };
    this.farthest = Math.max(this.unit * 150, whole * 1.5);
  }

  /**
   * Writes a space's positions into the lab's own notes, so whatever reads
   * the model — the walk's plan, the overlay's labels, the void a question
   * reaches into — finds them where the space put them. No search lift in a
   * space; a note it left out has no place in it.
   */
  private place(positions: ReadonlyMap<string, Vec3>): void {
    this.drifting = false;
    for (const n of this.vault.model.nodes) {
      const p = positions.get(n.id);
      n.x = p ? p[0] : Number.NaN;
      n.y = p ? p[1] : Number.NaN;
      n.z = p ? p[2] : Number.NaN;
      n.ox = 0;
      n.oy = 0;
      n.oz = 0;
    }
  }

  /** The vault's own positions back: where the brain stand-in draws the notes. */
  private placeBrain(): void {
    this.drifting = false;
    const home = this.vault.home;
    this.vault.model.nodes.forEach((n, i) => {
      n.x = home[i * 6]!;
      n.y = home[i * 6 + 1]!;
      n.z = home[i * 6 + 2]!;
      n.ox = home[i * 6 + 3]!;
      n.oy = home[i * 6 + 4]!;
      n.oz = home[i * 6 + 5]!;
    });
  }

  // -- The crawl -----------------------------------------------------------------

  private load(preset: Preset): void {
    const s = this.stage;
    const crawl = this.vault.crawls[preset];
    // The brain stand-in is walked as Crawl walks the brain today; a space hands in its own
    // threads, scale and pace — with the frame round the prompt in them when the scene has
    // one, so a walk loaded in the crawl can still be called back to it.
    if (s.kind === 'space') {
      const { unit, pace } = s.build;
      const field = this.scene.field ?? s.build.field;
      this.replay.load(crawl, this.vault.model, { field, unit, pace });
    } else this.replay.load(crawl, this.vault.model);
    this.motion.snap(this.replay.view);
    if (this.still) this.settleAtEnd();
  }

  /**
   * The crawl, or the prompt scene, over the stage as it now stands. With the
   * prompt attached and a space on the stage, the scene takes the space's new
   * layout — cutting any transition to where it was going — and rests on the
   * frame when it was at the prompt or is new here (`fresh`, or coming from
   * the brain stand-in); otherwise the crawl loads as before, over the field
   * with the frame in it. Without both, the crawl as the lab always walked it.
   */
  private enterScene(fresh = false): void {
    const s = this.stage;
    this.chase = null;
    this.promptPending = false;
    if (!this.prompt || s.kind !== 'space') {
      this.scene.setSpace(null, null);
      this.bezel.shape(null);
      this.load(this.controls.preset);
      return;
    }
    const toPrompt = fresh || !this.scene.available || this.scene.name === 'prompt';
    this.scene.setSpace(s.build, this.vault.model);
    this.layoutPrompt(true, this.readRects(this.prompt));
    this.promptDirty = null;
    if (toPrompt && this.restAtPrompt()) return;
    // The box had no place yet: the crawl meanwhile, and the prompt as soon as it can be laid out.
    this.promptPending = toPrompt;
    this.load(this.controls.preset);
  }

  /** At the prompt, resting on the frame, the creature placed there at once: a cut. */
  private restAtPrompt(): boolean {
    if (!this.scene.reset()) return false;
    this.chase = null;
    const view = this.replay.view;
    if (this.still) this.motion.finalPose(view);
    else this.motion.snap(view);
    return true;
  }

  /**
   * From the prompt into the crawl — a send, or a recent touched — playing
   * `preset`. False when the prompt takes no send now.
   */
  private startCrawl(preset: Preset): boolean {
    if (this.disposed || !this.prompt) return false;
    if (!this.scene.submit(this.vault.crawls[preset], this.sceneClock, this.still)) return false;
    this.chase = null;
    // The cluster's first full upload after rest, and the camera's sweep, are no reason to step down.
    this.governor.hold(performance.now());
    if (this.still) this.settleAtEnd();
    return true;
  }

  /** The prompt scene holds the camera — at the prompt, or on the way back to it — and nothing may move it. */
  private promptHolds(): boolean {
    return !!this.prompt && this.scene.available && this.scene.name === 'prompt';
  }

  /** The box's place on the stage, and the stage's size and density: what the scene is laid out against. */
  private readRects(p: { box: HTMLElement }): number[] {
    const box = p.box.getBoundingClientRect();
    const stage = this.container.getBoundingClientRect();
    return [
      box.left - stage.left,
      box.top - stage.top,
      box.width,
      box.height,
      this.vp.width,
      this.vp.height,
      this.dpr,
    ];
  }

  /**
   * Fits the prompt scene to the box as `rects` (readRects) find it: its
   * corners' radius from the page, the space's overview from the lab's angle,
   * and how far the notes reach from where it looks. The frame is shaped to
   * match. False when nothing could be placed.
   */
  private layoutPrompt(regrip: boolean, rects: number[]): boolean {
    const p = this.prompt;
    const s = this.stage;
    if (!p || s.kind !== 'space') return false;
    this.promptRects = rects;
    const [left, top, width, height] = rects as [number, number, number, number];
    const radius = parseFloat(getComputedStyle(p.box).borderTopLeftRadius) || 0;
    const overview = overviewCamera(s.build.bounds, this.vp, LAB_YAW, s.build.camera.pitch);
    const placed = this.scene.layout(
      {
        vp: this.vp,
        rect: { left, top, width, height, radius },
        overview,
        radius: this.reachOf(s.build, overview),
      },
      regrip,
    );
    this.bezel.shape(this.scene.shot?.bezel ?? null);
    return placed;
  }

  /**
   * How far a build's notes reach from its overview's target, plus a unit for
   * the cage round them: the perch keeps its gap from that. The target is the
   * build's own centre, whatever the viewport, so it is measured once a build.
   */
  private reachOf(build: SpaceBuild, overview: Camera): number {
    if (this.reach?.build !== build) {
      const target: Vec3 = [overview.tx, overview.ty, overview.tz];
      this.reach = { build, radius: notesReach(build.positions.values(), target, build.unit) };
    }
    return this.reach.radius;
  }

  /**
   * The prompt scene this frame: laid out again first when the box or the
   * stage moved, or a knob asked for it — the box is read every frame it
   * shows, since an observer misses a box that moves without resizing, and
   * two rect reads force no layout when nothing changed — with its levels
   * written on the page and the page told of anything it shows that changed.
   * On the scene's clock, which this frame's step has already moved. Null
   * without the prompt attached.
   */
  private promptFrame(): PromptFrame | null {
    const p = this.prompt;
    if (!p) return null;
    if (this.stage.kind === 'space') {
      const showing = (this.sf?.levels.prompt ?? 1) > 0;
      // A prompt still waiting for a place reads the box too: the crawl it
      // walks meanwhile shows no prompt, so nothing else would ever lay it out.
      if (this.promptDirty || showing || this.promptPending) {
        const rects = this.readRects(p);
        if (this.promptDirty || rects.some((v, i) => v !== this.promptRects[i])) {
          this.layoutPrompt(this.promptDirty === 'regrip', rects);
          this.promptDirty = null;
        }
      }
      if (this.promptPending && this.scene.available && this.restAtPrompt()) {
        this.promptPending = false;
      }
    }
    const sf = this.scene.frame(this.sceneClock, this.still);
    this.writeLevels(p.chrome, sf.levels);
    this.tell(p.listener, sf);
    return sf;
  }

  /**
   * The levels on the page, as CSS variables on the chrome: the prompt's and
   * the panel's, and the prompt hidden from everyone only once it has faded
   * out — never the instant the scene turns away, or the fade would be cut.
   * Written only when they change.
   */
  private writeLevels(chrome: HTMLElement, l: Levels): void {
    const css = this.css;
    const prompt = l.prompt.toFixed(4);
    const panel = l.panel.toFixed(4);
    const visibility = l.prompt > 0 ? 'visible' : 'hidden';
    if (prompt !== css.prompt) chrome.style.setProperty('--crawl-prompt', (css.prompt = prompt));
    if (panel !== css.panel) chrome.style.setProperty('--crawl-panel', (css.panel = panel));
    if (visibility !== css.visibility) {
      chrome.style.setProperty('--crawl-prompt-visibility', (css.visibility = visibility));
    }
  }

  /** The prompt box's glass knobs, on the page. */
  private writeGlass(): void {
    const chrome = this.prompt?.chrome;
    if (!chrome) return;
    chrome.style.setProperty('--crawl-glass-alpha', String(clamp(this.glass.alpha, 0, 1)));
    chrome.style.setProperty('--crawl-glass-blur', `${Math.max(0, this.glass.blur)}px`);
  }

  /** The page told what the prompt and the panel show, when any of it changed. */
  private tell(listener: (ui: LabPromptUi) => void, sf: PromptFrame): void {
    const last = this.ui;
    // Each time the input takes text again at the prompt, it takes focus.
    if (sf.interactive && !last?.interactive) this.focusCount++;
    const ui: LabPromptUi = {
      scene: sf.scene,
      available: this.scene.available,
      interactive: sf.interactive,
      focus: this.focusCount,
      asked: this.asked,
      recents: this.recents,
    };
    if (
      last &&
      last.scene === ui.scene &&
      last.available === ui.available &&
      last.interactive === ui.interactive &&
      last.focus === ui.focus &&
      last.asked === ui.asked &&
      last.recents === ui.recents
    ) {
      return;
    }
    this.ui = ui;
    listener(ui);
  }

  /** The recents under the prompt, from the lab's crawls over the current vault. */
  private refreshRecents(): void {
    this.recents = promptRecents(labRecents(this.vault, this.opened), this.seen, Date.now());
  }

  /**
   * The motion's params this frame: the panel's, with the prompt's idle life
   * blended in by its level — at the prompt the body breathes and hums, and
   * the tentacles move as they do on the walk; in the crawl, the walk's own
   * values throughout, as the panel tuned them.
   */
  private blendLife(k: number): void {
    const live = this.live;
    Object.assign(live, this.params);
    if (!(k > 0)) return;
    const idle = this.scene.knobs.idle;
    const share = Math.min(1, k);
    for (const key of IDLE_KEYS) live[key] = live[key] + (idle[key] - live[key]) * share;
  }

  /** The end of the crawl, at once, and the creature's still pose there. */
  private settleAtEnd(): void {
    this.replay.skipToEnd();
    // What happened on the way is history: nothing should flare for it.
    this.replay.drain();
    this.motion.finalPose(this.replay.view);
  }

  /**
   * SentinelMotion keeps its rig private, and a tentacle's twist is part of
   * its seeded character (rig.ts), not a motion parameter — so the lab scales
   * it in place before every step, which is enough for it to be tuned live.
   * A value the lab settles on belongs in tentacleCharacter.
   */
  private scaleTwist(): void {
    const rig = (this.motion as unknown as { rig: Rig | null }).rig;
    if (!rig) return;
    const k = this.controls.twist;
    for (let i = 0; i < TENTACLES; i++) rig.twist[i] = this.baseTwist[i]! * k;
  }

  /**
   * Drift: every note wanders a little around where it was laid out, as on
   * the brain while its layout settles. The brain stand-in's alone: a space's
   * layout is static, and its field never reads the model. True when
   * positions changed.
   */
  private drift(now: number): boolean {
    if (!this.controls.drift) {
      if (!this.drifting) return false;
      this.placeBrain();
      return true;
    }
    this.drifting = true;
    const t = now / 1000;
    const a = DRIFT * this.unit;
    const { home, phases } = this.vault;
    this.vault.model.nodes.forEach((n, i) => {
      const ph = phases[i]!;
      n.x = home[i * 6]! + a * Math.sin(t * DRIFT_RATE[0] + ph);
      n.y = home[i * 6 + 1]! + a * Math.sin(t * DRIFT_RATE[1] + ph * 1.7);
      n.z = home[i * 6 + 2]! + a * Math.sin(t * DRIFT_RATE[2] + ph * 2.3);
    });
    return true;
  }

  // -- Camera and input ----------------------------------------------------------

  /**
   * The camera this frame. The prompt scene's while it holds it — the perch
   * shot, or the way between it and the overview. Then, at the crawl, the
   * follow camera, handed over through a blend from the camera the timeline
   * held: the follow's own ease sets off at full speed, and shown straight it
   * would lurch. Otherwise the follow camera, or the user's.
   */
  private aimCamera(sf: PromptFrame | null, dt: number): void {
    if (sf?.camera) {
      this.cam = sf.camera;
      this.chase = null;
    } else if (sf?.handoff) {
      this.chase = this.followed(this.chase ?? { ...sf.handoff.camera }, dt);
      this.cam = cameraBetween(sf.handoff.camera, this.chase, sf.handoff.k);
    } else {
      if (this.chase) this.cam = this.chase;
      this.chase = null;
      this.cam = this.followed(this.cam, dt);
    }
  }

  /** `c` eased toward the walk, as the graph controller follows a plugin: over 450 ms, at once under reduced motion. */
  private followed(c: Camera, dt: number): Camera {
    const f = this.replay.follow();
    if (!f || this.drag) return c;
    const dist =
      this.replay.view.mode === 'done' ? f.dist : this.replay.unit * this.params.followDistance;
    const k = this.still ? 1 : 1 - Math.exp(-dt / 450);
    return {
      ...c,
      tx: c.tx + (f.x - c.tx) * k,
      ty: c.ty + (f.y - c.ty) * k,
      tz: c.tz + (f.z - c.tz) * k,
      dist: c.dist + (dist - c.dist) * k,
    };
  }

  /**
   * The user took the camera: from the follow, as ever, and from the prompt
   * scene's timeline mid-transition, the hand-off included — whatever is on
   * screen is where the drag or the wheel starts from.
   */
  private takeCamera(): void {
    this.scene.takeCamera();
    this.chase = null;
    this.replay.onUserCamera();
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.overlay.style.cursor = cursor;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    // The perch shot is the only camera the frame fits: at the prompt nothing orbits it.
    if (this.promptHolds()) return;
    this.overlay.setPointerCapture(e.pointerId);
    this.takeCamera();
    this.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey };
    this.setCursor('grabbing');
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    this.cam = drag.pan ? panBy(this.cam, this.vp, dx, dy) : orbitBy(this.cam, dx, dy);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.overlay.hasPointerCapture(e.pointerId))
      this.overlay.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.setCursor(this.promptHolds() ? 'default' : 'grab');
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.promptHolds()) return;
    this.takeCamera();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.cam = {
      ...this.cam,
      dist: clamp(this.cam.dist / factor, this.unit * 1.5, this.farthest),
    };
  };

  private readonly onResize = (): void => {
    this.resized = true;
  };

  /** Sizes both canvases to the container, as the graph controller sizes the graph's. */
  private fit(): void {
    this.resized = false;
    const r = this.container.getBoundingClientRect();
    this.vp = { width: Math.max(1, r.width), height: Math.max(1, r.height) };
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.vp.width, this.vp.height, false);
    this.overlay.width = Math.round(this.vp.width * this.dpr);
    this.overlay.height = Math.round(this.vp.height * this.dpr);
  }

  // -- The frame -----------------------------------------------------------------

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    // The raw time between frames feeds the governor; the controller's 64 ms cap feeds the motion.
    const raw = this.lastNow === null ? 0 : now - this.lastNow;
    this.lastNow = now;
    const dt = Math.min(64, raw);
    if (this.resized) {
      this.fit();
      this.governor.hold(now);
      // The box moves with the stage: laid out again even in the crawl, so the way back finds it.
      if (this.promptDirty !== 'regrip') this.promptDirty = 'move';
    }
    const stage = this.stage;
    let moved = false;
    if (stage.kind === 'brain') {
      moved = this.drift(now);
      if (moved) stage.backdrop.place();
    }
    const replay = this.replay;
    // The replay's step this frame, and the prompt scene's clock moved by it
    // first, so the scene below and the replay after it stand at the same moment.
    const step = this.controls.playing ? (dt / 1000) * this.controls.speed : 0;
    this.sceneClock += step;
    // The prompt scene first: it says who holds the camera, and how much of each part shows.
    const sf = this.promptFrame();
    this.sf = sf;
    const prompting = !!sf && this.scene.available;
    this.aimCamera(sf, dt);
    this.controls.following = this.replay.snapshot.following;
    if (!this.drag) this.setCursor(this.promptHolds() ? 'default' : 'grab');

    // Resting under reduced motion nothing happens at all, not even a re-grip. The
    // scene's clock may run on meanwhile: under reduced motion every transition is a cut.
    replay.update(this.still && replay.resting ? 0 : step);
    const view = replay.view;
    const events = replay.drain();

    // The Sentinel's own CPU time: its motion, its draw calls, and the simulated slow CPU.
    const t0 = performance.now();
    this.motion.gaze = sf?.gaze ?? null;
    this.blendLife(sf && prompting ? sf.levels.prompt : 0);
    this.scaleTwist();
    this.motion.step(view, events, dt / 1000, now / 1000, this.still);
    const t1 = performance.now();
    if (this.controls.slowCpuMs > 0) busyWait(this.controls.slowCpuMs);
    const t2 = performance.now();

    const r = this.renderer;
    const draw = this.ready && this.tier !== 'trail' && this.controls.sentinel;
    const warm = this.stageWarm();
    const backdrop = stage.kind === 'brain' && this.controls.backdrop ? stage.backdrop : null;
    const under = this.controls.backdropOrder === 'under';
    // The stage's pass, as GraphScene's is in Crawl: it clears and draws. A
    // space also writes depth, and the Sentinel draws into it. A space still
    // compiling its shaders only clears.
    let stageCpu: number | null = null;
    this.spaceDrawn = { calls: 0, triangles: 0 };
    // The planes the Sentinel and the frame draw in, sharing one depth: the space's, or the frame's.
    let depth: { near: number; far: number } | null = null;
    let eye: SpaceEye | null = null;
    if (stage.kind === 'space') {
      eye = this.spaceEye(draw, view);
      const cluster = sf && prompting ? sf.levels.cluster : 1;
      // At rest at the prompt the cluster is not drawn at all: a clear, and the
      // frame's planes for the creature and the frame. So too while the frame
      // shows and the space, or the veil over it, cannot draw yet — with planes
      // that hold the creature wherever its crossing has taken it (bareDepth).
      const bare =
        sf &&
        prompting &&
        (sf.atRest || (!warm && sf.levels.prompt > 0) || (cluster < 1 && !this.promptWarm))
          ? sf
          : null;
      if (bare) {
        stageCpu = this.timeStage(() => this.clearStage());
        depth = this.bareDepth(bare, draw, stage.build.unit);
      } else if (warm) {
        stageCpu = this.timeStage(() => this.drawSpace(stage, now, eye, cluster));
        depth = stage.space.depth;
      } else r.clear();
      // Its light is baked on its first frame, and lent from then on: the metal reflects the space.
      this.view.setEnvironment(this.controls.lendEnvironment ? stage.space.environment : null);
    } else if (backdrop && under) {
      stageCpu = this.timeStage(() => this.drawBackdrop(backdrop));
    } else r.clear();
    let submit = 0;
    if (draw) {
      const t3 = performance.now();
      this.timer?.begin();
      this.view.render(this.motion.pose, this.cam, this.vp, this.dpr, { depth });
      this.timer?.end();
      submit = performance.now() - t3;
      assertRendererState(r, 'the Sentinel drew in the lab');
    }
    // The frame after the creature, depth-tested: it hides what lies behind it, and fades over it.
    if (stage.kind === 'space' && sf && prompting && this.promptWarm && sf.levels.prompt > 0) {
      stageCpu = (stageCpu ?? 0) + this.drawBezel(stage, sf.levels.prompt, depth, eye);
    }
    if (backdrop && !under) {
      stageCpu = this.timeStage(() =>
        withRendererState(r, () => {
          r.autoClear = false;
          return this.drawBackdrop(backdrop);
        }),
      );
    }
    const gpu = this.timer?.poll() ?? null;
    const spaceGpu = this.spaceTimer?.poll() ?? null;
    const cpu = t2 - t0 + submit;
    if (this.settleIn > 0 && this.ready && warm && this.promptSettled() && --this.settleIn === 0) {
      this.programsAtReady = this.memory().programs;
    }

    this.drawOverlay(now);

    const decision = this.governor.sample({
      now,
      settled: draw && !moved && !this.rebuilding,
      cpuMs: cpu,
      gpuMs: gpu,
    });
    if (decision.changed) {
      this.lastReason = decision.reason ?? '';
      this.applyTier();
    }

    if (raw > 0) this.dts.push(raw);
    if (draw) {
      this.cpus.push(cpu);
      this.sims.push(t1 - t0);
    }
    if (gpu !== null) this.gpus.push(gpu);
    if (stageCpu !== null) this.spaceCpus.push(stageCpu);
    if (spaceGpu !== null) this.spaceGpus.push(spaceGpu);
    if (now - this.statsAt >= STATS_EVERY_MS) {
      this.statsAt = now;
      this.refreshStats(now);
    }
  };

  /**
   * Runs one of the stage's passes, timed apart from the Sentinel: its CPU
   * time (returned, ms), its GPU time on its own timer, and what it drew.
   * With `splitGpu`, the GPU finishes the pass before its timer ends, so the
   * timer holds all of it and the Sentinel's none; the wait is not counted
   * as the stage's CPU time.
   */
  private timeStage(pass: () => { calls: number; triangles: number }): number {
    const t0 = performance.now();
    this.spaceTimer?.begin();
    const drawn = pass();
    const cpu = performance.now() - t0;
    if (this.spaceTimer && this.controls.splitGpu) {
      const gl = this.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    }
    this.spaceTimer?.end();
    this.spaceDrawn = { calls: drawn.calls, triangles: drawn.triangles };
    return cpu;
  }

  /**
   * The eye the space and the frame are told of: the Sentinel's, when it
   * draws this frame; otherwise a stand-in at the walk, burning as the
   * creature's eye does when nothing flares (resting, or still), as Crawl
   * would show it without the creature.
   */
  private spaceEye(sentinel: boolean, view: ReplayView): SpaceEye | null {
    if (sentinel) return sentinelEye(this.motion.pose, this.eye);
    const p = this.params;
    return standInEye(view, this.still ? p.eyeStill : p.eyeBase, this.eye);
  }

  /**
   * The space's pass, the cluster at `cluster` of its light. Below full, the
   * background is laid over it, and its depth cleared after: crystals veiled
   * to nothing must not cut holes in the creature, and going to the crawl the
   * creature is in front of the cluster until it is whole, so nothing is lost.
   */
  private drawSpace(
    stage: SpaceStage,
    now: number,
    eye: SpaceEye | null,
    cluster: number,
  ): { calls: number; triangles: number } {
    const r = this.renderer;
    stage.space.render(r, {
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      view: this.replay.view,
      time: now / 1000,
      still: this.still,
      eye,
    });
    assertRendererState(r, `the ${stage.name} space drew in the lab`);
    const drawn = { ...stage.space.info };
    if (cluster < 1) {
      this.veil.render(r, 1 - cluster);
      withRendererState(r, () => {
        // A clear honours the depth mask, which the last draw may have left off.
        r.state.buffers.depth.setMask(true);
        r.clearDepth();
      });
      assertRendererState(r, 'the veil drew in the lab');
      drawn.calls += this.veil.info.calls;
      drawn.triangles += this.veil.info.triangles;
    }
    return drawn;
  }

  /**
   * The planes the creature and the frame share on a bare stage, world units.
   * Resting on the frame, the frame's own: the creature is within them by
   * design. Under way — bare because the space, or the frame and the veil,
   * cannot draw yet, or failed to — the creature is anywhere between the
   * frame and the cluster, and in the frame's planes it would be sliced, then
   * culled whole mid-crossing. When the frame draws, its planes widened to
   * hold the creature too, so the two still share one depth; when it does not,
   * none, and the creature fits its own and clears depth.
   */
  private bareDepth(
    sf: PromptFrame,
    sentinel: boolean,
    unit: number,
  ): { near: number; far: number } | null {
    if (sf.atRest) return this.bezel.planes(this.cam, unit);
    if (!this.promptWarm || !(sf.levels.prompt > 0)) return null;
    return this.bezel.planes(this.cam, unit, sentinel ? creatureBounds(this.motion.pose) : null);
  }

  /** The canvas cleared, depth too, with the mask on: the Sentinel shares that depth without clearing it. */
  private clearStage(): { calls: number; triangles: number } {
    const r = this.renderer;
    withRendererState(r, () => {
      r.state.buffers.depth.setMask(true);
      r.clear();
    });
    return { calls: 0, triangles: 0 };
  }

  /**
   * The frame round the prompt, over the creature, in the planes it drew in.
   * Counted with the stage; its GPU time is not timed apart — timed after the
   * Sentinel, its timer would hold the creature's tail instead. Returns its
   * CPU time, ms.
   */
  private drawBezel(
    stage: SpaceStage,
    level: number,
    depth: { near: number; far: number } | null,
    eye: SpaceEye | null,
  ): number {
    const t0 = performance.now();
    const r = this.renderer;
    this.bezel.render(r, {
      cam: this.cam,
      vp: this.vp,
      level,
      unit: stage.build.unit,
      depth,
      eye,
    });
    assertRendererState(r, 'the prompt frame drew in the lab');
    const b = this.bezel.info;
    this.spaceDrawn = {
      calls: this.spaceDrawn.calls + b.calls,
      triangles: this.spaceDrawn.triangles + b.triangles,
    };
    return performance.now() - t0;
  }

  /** The backdrop's draws: three counts each render() call afresh. */
  private drawBackdrop(backdrop: LabBackdrop): { calls: number; triangles: number } {
    backdrop.render(this.renderer, this.cam, this.vp, this.dpr);
    return this.renderer.info.render;
  }

  private drawOverlay(now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const project = projector(this.cam, this.vp);
    const P: Project = (p: Vec3) => project(p[0], p[1], p[2]);
    const view = this.replay.view;
    // A space lights its own threads along its routes; the overlay's brain curves would cut corners.
    const space = this.stage.kind === 'space';
    // The walk's labels and halos fade with the cluster they belong to.
    const sf = this.sf;
    const prompting = !!sf && this.scene.available;
    const cluster = sf && prompting ? sf.levels.cluster : 1;
    if (this.controls.overlay && cluster > 0) {
      drawCrawl(ctx, P, {
        view,
        labels: this.replay.labels,
        note: (id) => this.noteLook(id),
        time: now / 1000,
        still: this.still,
        width: this.vp.width,
        font: this.font,
        threads: !space,
        halos: !space || this.controls.spaceHalos,
        alpha: cluster,
      });
    }
    if (this.controls.debug) {
      drawDebug(ctx, P, this.motion.pose, this.motion.debug, view, this.font);
      const shot = this.scene.shot;
      if (sf && prompting && shot && sf.levels.prompt > 0) {
        drawPerch(ctx, P, shot, sf.levels.prompt);
      }
    }
    const snap = this.replay.snapshot;
    const found = snap.found.named + snap.found.linked + snap.found.decision;
    const prompt = this.promptNote();
    drawNotes(
      ctx,
      [
        this.sentinelNote(),
        this.stageNote(),
        ...(prompt ? [prompt] : []),
        `${snap.state} · ${snap.threads} threads · ${found} found${this.still ? ' · reduced motion' : ''}`,
        this.promptHolds()
          ? 'type a question, or touch a recent crawl'
          : 'drag to orbit · shift-drag to pan · wheel to zoom',
      ],
      this.vp.height,
      this.font,
    );
  }

  /**
   * Where the prompt scene is, for the notes: at the prompt, the frame's size,
   * the perch shot's distance and how far the camera backs off to the
   * overview, creature units; or on its way, or in the crawl. Null without
   * the prompt on a space.
   */
  private promptNote(): string | null {
    if (!this.prompt || this.stage.kind !== 'space') return null;
    if (this.promptFailure) return `prompt frame failed: ${this.promptFailure}`;
    const sf = this.sf;
    const shot = this.scene.shot;
    if (!sf || !shot) return 'prompt · the box has no place yet';
    if (sf.moving) return sf.scene === 'crawl' ? 'going to the crawl' : 'going back';
    if (sf.scene === 'crawl') return 'crawl';
    const u = shot.unit;
    // A paused return leaves the claws short of the frame, and the input waiting for them.
    const waiting = sf.interactive
      ? ''
      : this.controls.playing
        ? ' · landing'
        : ' · paused: the input waits for the claws';
    const frame = `${(shot.bezel.width / u).toFixed(2)} × ${(shot.bezel.height / u).toFixed(2)} u`;
    return `prompt · frame ${frame} · shot ${(shot.depth / u).toFixed(1)} u · pull ${(shot.pulled / u).toFixed(1)} u${waiting}`;
  }

  /** The Stats folder's prompt line: where the scene is, the frame, the shot, the pull, the claws on the frame. */
  private promptStat(): string {
    if (!this.prompt) return 'not attached';
    const shot = this.scene.shot;
    if (!this.scene.available || !shot) {
      return this.stage.kind === 'space'
        ? 'no place for the box yet'
        : 'none on the brain stand-in';
    }
    const sf = this.sf;
    const where = sf?.moving ? `→ ${sf.scene}` : (sf?.scene ?? this.scene.name);
    const u = shot.unit;
    const held = this.replay.view.holds.filter((h) => h && PERCH_RAIL_SET.has(h.key)).length;
    const frame = `${(shot.bezel.width / u).toFixed(2)}×${(shot.bezel.height / u).toFixed(2)} u`;
    return `${where} · frame ${frame} · shot ${(shot.depth / u).toFixed(1)} u · pull ${(shot.pulled / u).toFixed(1)} u · ${held}/${GRIP_SLOTS.length} on the frame`;
  }

  /**
   * A note's radius and pulse phase, for its halo. In a space the brain's
   * radius means nothing: a halo there is sized by the creature instead.
   */
  private noteLook(id: string): { radius: number; phase: number } | null {
    const note = this.vault.notes.get(id);
    if (!note || this.stage.kind === 'brain') return note ?? null;
    return { radius: this.unit * SPACE_NOTE_RADIUS, phase: note.phase };
  }

  private stageNote(): string {
    const s = this.stage;
    const notes = `${this.vault.model.nodes.length.toLocaleString('en-US')} notes`;
    if (s.kind === 'space') {
      const lent = this.controls.lendEnvironment && s.space.environment ? ' · reflected' : '';
      const warming = s.warm ? '' : ' · compiling its shaders';
      return `${s.name} · ${notes}${lent}${warming}`;
    }
    const backdrop = this.controls.backdrop
      ? `backdrop ${this.controls.backdropOrder}`
      : 'no backdrop';
    const failed = this.spaceFailure ? `${this.spaceFailure} · ` : '';
    return `${failed}${BRAIN_STANDIN} · ${backdrop} · ${notes}`;
  }

  private sentinelNote(): string {
    if (this.failure) return `Sentinel failed: ${this.failure}`;
    if (!this.controls.sentinel) {
      return this.stage.kind === 'space'
        ? 'Sentinel: off · a stand-in eye rides the walk'
        : 'Sentinel: off';
    }
    if (this.tier === 'trail') {
      return this.startTrail && this.controls.tier === 'auto'
        ? 'Sentinel: software renderer, Crawl would show the trail (force a tier to see it)'
        : 'Sentinel: overloaded at T0, Crawl would show the trail';
    }
    if (!this.ready) return 'Sentinel: warming up…';
    return `Sentinel T${this.tier}`;
  }

  private refreshStats(now: number): void {
    const s = this.stats;
    const stage = this.stage;
    s.space =
      stage.kind === 'space'
        ? `${stage.name} · built in ${stage.buildMs.toFixed(0)} ms`
        : (this.spaceFailure ?? BRAIN_STANDIN);
    const drawn = this.spaceDrawn;
    s.spaceCost = `${drawn.calls} draws · ${drawn.triangles.toLocaleString('en-US')} triangles`;
    const spaceGpu = this.spaceTimer ? ms(this.spaceGpus.percentile(0.5)) : 'n/a';
    s.spaceTime = `CPU ${ms(this.spaceCpus.percentile(0.5))} · GPU ${spaceGpu}`;
    const report = stage.kind === 'space' ? (stage.report?.() ?? null) : null;
    s.shape = report?.shape ?? '—';
    s.uploads = this.uploadRate(report?.uploads ?? null, now);
    const mean = this.dts.mean();
    s.fps = Number.isFinite(mean) && mean > 0 ? (1000 / mean).toFixed(1) : '…';
    s.dt = `${ms(this.dts.percentile(0.5))} / ${ms(this.dts.percentile(0.95))}`;
    s.cpu = ms(this.cpus.percentile(0.5));
    s.sim = ms(this.sims.percentile(0.5));
    s.gpu = this.timer ? ms(this.gpus.percentile(0.5)) : 'n/a';
    const info = this.view.info;
    s.draws = String(info.calls);
    s.triangles = info.triangles.toLocaleString('en-US');
    s.programs =
      this.programsAtReady === null
        ? String(info.programs)
        : `${info.programs} (${this.programsAtReady} after warm-up)`;
    const m = this.memory();
    s.memory = `${m.geometries} geometries · ${m.textures} textures`;
    s.tier =
      this.tier === 'trail'
        ? 'trail'
        : `T${this.tier}${this.controls.tier === 'auto' ? '' : ' (forced)'}${this.lastReason ? ` · last: ${this.lastReason}` : ''}`;
    const t = TIERS[this.tier === 'trail' ? 0 : this.tier];
    s.segments = `${t.crownSegments} crown / ${t.explorerSegments} explorer`;
    s.governor = this.governor.log[this.governor.log.length - 1] ?? '—';
    s.status = this.failure ? `failed: ${this.failure}` : this.ready ? 'ready' : 'warming up';
    s.prompt = this.promptStat();
  }

  /**
   * State uploads a second since the last refresh, from the space's running
   * count: 0 is the promise at rest. A count that went down belongs to a new
   * build, so that interval says nothing.
   */
  private uploadRate(count: number | null, now: number): string {
    const seen = this.uploadsSeen;
    this.uploadsSeen = count === null ? null : { count, at: now };
    if (count === null) return 'n/a';
    if (!seen || count < seen.count || now <= seen.at) return '…';
    return `${(((count - seen.count) * 1000) / (now - seen.at)).toFixed(1)} a second`;
  }
}
