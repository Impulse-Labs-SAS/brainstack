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
// It owns its canvases. A canvas keeps its WebGL context for life, and one
// lost on purpose — forceContextLoss, which stops hot reloads from piling
// contexts up — stays lost; React's Strict Mode mounts, unmounts and mounts
// again, and the second mount needs a canvas of its own.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  TAN_HALF_FOV,
  boundsOf,
  orbitBy,
  panBy,
  projector,
  type Bounds,
  type Camera,
  type Viewport,
} from '@/lib/graph-camera';
import { hash01 } from '@/lib/graph-model';

import { CrawlReplay } from '../../crawl-replay';
import { sampleVault, type SampleVault } from '../../sample-vault';
import { largeVault } from '../../space/large-vault';
import type { SpaceBuild } from '../../space/space';
import { typicalLink } from '../../threads';
import type { Vec3 } from '../../vec';
import { TENTACLES } from '../anatomy';
import { assertRendererState, withRendererState } from '../gl-state';
import { GpuTimer } from '../gpu-timer';
import { DEFAULT_GRIP, type GripParams } from '../grips';
import { defaultLook, type SentinelLook } from '../look';
import { SentinelMotion } from '../motion';
import { probeCaps } from '../probe';
import { QualityGovernor, recallStable, startTier, type Caps } from '../quality';
import { SENTINEL_SEED, tentacleCharacter, type Rig } from '../rig';
import { TIERS, type Tier } from '../tiers';
import { SentinelView } from '../view';

import { LabBackdrop } from './backdrop';
import { drawCrawl, drawDebug, drawNotes, type Project } from './lab-overlay';
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
}

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

/** How far back all of `b` is in view: its bounding sphere inside the narrower field of view. */
function overview(b: Bounds, vp: Viewport): number {
  const radius = Math.hypot(b.w, b.h, b.d) / 2;
  const tan = TAN_HALF_FOV * Math.min(1, vp.width / vp.height);
  return radius / Math.sin(Math.atan(tan));
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

  constructor(private readonly container: HTMLElement) {
    this.glCanvas = canvas(container);
    this.overlay = canvas(container);
    this.overlay.style.cursor = 'grab';
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
    try {
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.fit();

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
      this.follows.set(BRAIN_STANDIN, this.motion.params.followDistance);
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
      };

      // Built before the view: the view lends a space's light as it warms up.
      stage = this.makeStage(DEFAULT_SPACE, null);
      this.stage = stage;
      if (stage.kind === 'space') this.motion.params.followDistance = stage.build.camera.follow;
      this.unit = stage.kind === 'space' ? stage.build.unit : typicalLink(this.vault.model);

      this.replay = new CrawlReplay(() => {});
      if (this.tier !== 'trail') this.motion.setTier(this.tier);
      made = this.createView();
      this.view = made;
      this.load(this.controls.preset);
      this.frameStage();
      this.warmStage();

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
    this.follows.set(this.stageChoice(), this.motion.params.followDistance);
    this.leave();
    this.stage = this.makeStage(choice, null);
    const s = this.stage;
    this.motion.params.followDistance =
      this.follows.get(this.stageChoice()) ??
      (s.kind === 'space' ? s.build.camera.follow : this.motion.params.followDistance);
    this.enter();
    this.onStageChange?.();
  }

  /**
   * Another vault: the same stage laid out again over its notes, a space's
   * knobs kept, and the crawl started over.
   */
  setVault(choice: VaultChoice): void {
    if (this.disposed) return;
    this.controls.vault = choice;
    this.restage(openVault(choice));
  }

  setPreset(preset: Preset): void {
    this.controls.preset = preset;
    this.load(preset);
  }

  replayAgain(): void {
    this.replay.replay();
    this.motion.snap(this.replay.view);
    if (this.still) this.settleAtEnd();
  }

  setFollowing(on: boolean): void {
    if (on) this.replay.followAgain();
    else this.replay.onUserCamera();
  }

  /** Reduced motion, as Crawl will honour it: the crawl jumps to its end and the creature to its still pose. */
  setReducedMotion(on: boolean): void {
    this.controls.reducedMotion = on;
    this.still = on;
    if (on) this.settleAtEnd();
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
        motion: this.motion.params,
        look: this.look,
        grip: { ...this.grip },
        // Not a parameter anywhere yet: it scales rig.ts's seeded twist per segment.
        twistScale: this.controls.twist,
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

    // Everything on the GPU goes while the renderer that holds it is alive; the
    // view first, so it lets go of the light it borrowed before the space frees it.
    this.view.dispose();
    this.leave();
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
   * view's, or the space's — reads the renderer's state until it settles, and
   * throws once that state is gone; the renderer goes after both, or after a
   * while if one never settles.
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
        this.programsAtReady = this.memory().programs;
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

  /** The brain stand-in in place of a space that cannot draw, and why on screen. */
  private fallBack(why: string): void {
    this.follows.set(this.stageChoice(), this.motion.params.followDistance);
    this.leave();
    this.controls.space = BRAIN_STANDIN;
    this.placeBrain();
    this.stage = { kind: 'brain', backdrop: new LabBackdrop(this.vault.model) };
    this.spaceFailure = why;
    this.motion.params.followDistance =
      this.follows.get(BRAIN_STANDIN) ?? this.motion.params.followDistance;
    this.enter();
    this.onStageChange?.();
  }

  /** Whether the stage draws: the brain always, a space once its shaders are compiled. */
  private stageWarm(): boolean {
    return this.stage.kind === 'brain' || this.stage.warm;
  }

  /** The crawl, the camera and the governor, once the stage changed. */
  private enter(): void {
    const s = this.stage;
    this.unit = s.kind === 'space' ? s.build.unit : typicalLink(this.vault.model);
    this.load(this.controls.preset);
    this.frameStage();
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
    const whole = s.kind === 'space' ? overview(s.build.bounds, this.vp) : this.unit * 20;
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
    // threads, scale and pace.
    if (s.kind === 'space') {
      const { field, unit, pace } = s.build;
      this.replay.load(crawl, this.vault.model, { field, unit, pace });
    } else this.replay.load(crawl, this.vault.model);
    this.motion.snap(this.replay.view);
    if (this.still) this.settleAtEnd();
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

  /** As the graph controller follows a plugin: eased over 450 ms, at once under reduced motion. */
  private followCamera(dt: number): void {
    const f = this.replay.follow();
    if (!f || this.drag) return;
    const dist =
      this.replay.view.mode === 'done'
        ? f.dist
        : this.replay.unit * this.motion.params.followDistance;
    const k = this.still ? 1 : 1 - Math.exp(-dt / 450);
    const c = this.cam;
    this.cam = {
      ...c,
      tx: c.tx + (f.x - c.tx) * k,
      ty: c.ty + (f.y - c.ty) * k,
      tz: c.tz + (f.z - c.tz) * k,
      dist: c.dist + (dist - c.dist) * k,
    };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.overlay.setPointerCapture(e.pointerId);
    this.replay.onUserCamera();
    this.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey };
    this.overlay.style.cursor = 'grabbing';
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
    this.overlay.style.cursor = 'grab';
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.replay.onUserCamera();
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
    }
    const stage = this.stage;
    let moved = false;
    if (stage.kind === 'brain') {
      moved = this.drift(now);
      if (moved) stage.backdrop.place();
    }
    this.followCamera(dt);
    this.controls.following = this.replay.snapshot.following;

    const replay = this.replay;
    replay.update(this.controls.playing ? (dt / 1000) * this.controls.speed : 0);
    const view = replay.view;
    const events = replay.drain();

    // The Sentinel's own CPU time: its motion, its draw calls, and the simulated slow CPU.
    const t0 = performance.now();
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
    if (stage.kind === 'space') {
      if (warm) stageCpu = this.timeStage(() => this.drawSpace(stage, now, draw));
      else r.clear();
      // Its light is baked on its first frame, and lent from then on: the metal reflects the space.
      this.view.setEnvironment(this.controls.lendEnvironment ? stage.space.environment : null);
    } else if (backdrop && under) {
      stageCpu = this.timeStage(() => this.drawBackdrop(backdrop));
    } else r.clear();
    let submit = 0;
    if (draw) {
      const t3 = performance.now();
      this.timer?.begin();
      const shared = stage.kind === 'space' && warm;
      this.view.render(this.motion.pose, this.cam, this.vp, this.dpr, {
        depth: shared ? stage.space.depth : null,
      });
      this.timer?.end();
      submit = performance.now() - t3;
      assertRendererState(r, 'the Sentinel drew in the lab');
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
    if (this.settleIn > 0 && this.ready && warm && --this.settleIn === 0) {
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
   * The space's pass. `sentinel`: the creature draws this frame, so the space
   * is told where its eye is; otherwise a stand-in eye at the walk wakes it,
   * as Crawl would show it without the creature.
   */
  private drawSpace(
    stage: SpaceStage,
    now: number,
    sentinel: boolean,
  ): { calls: number; triangles: number } {
    const view = this.replay.view;
    // The stand-in burns as the creature's eye does when nothing flares: resting, or still.
    const p = this.motion.params;
    const resting = this.still ? p.eyeStill : p.eyeBase;
    stage.space.render(this.renderer, {
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      view,
      time: now / 1000,
      still: this.still,
      eye: sentinel ? sentinelEye(this.motion.pose, this.eye) : standInEye(view, resting, this.eye),
    });
    assertRendererState(this.renderer, `the ${stage.name} space drew in the lab`);
    return stage.space.info;
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
    if (this.controls.overlay) {
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
      });
    }
    if (this.controls.debug) {
      drawDebug(ctx, P, this.motion.pose, this.motion.debug, view, this.font);
    }
    const snap = this.replay.snapshot;
    const found = snap.found.named + snap.found.linked + snap.found.decision;
    drawNotes(
      ctx,
      [
        this.sentinelNote(),
        this.stageNote(),
        `${snap.state} · ${snap.threads} threads · ${found} found${this.still ? ' · reduced motion' : ''}`,
        'drag to orbit · shift-drag to pan · wheel to zoom',
      ],
      this.vp.height,
      this.font,
    );
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
