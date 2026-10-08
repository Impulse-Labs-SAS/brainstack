// The Sentinel lab's engine: everything /dev/sentinel runs, outside React.
//
// It is the Crawl integration in miniature, without the graph. A WebGLRenderer
// set up exactly as GraphScene sets up the graph's — same multisampling, clear
// colour, no tone mapping, pixel ratio — so the Sentinel meets the canvas it
// will meet in Crawl. The real CrawlReplay over the seeded sample vault, the
// real SentinelMotion and SentinelView, the camera eased toward the walk the
// way the graph controller eases it, and the quality governor fed the way
// Crawl will feed it, with the Sentinel's CPU and GPU time measured around its
// own work. What the lab adds is only for judging it: a stand-in for the graph
// (the backdrop) drawn under the creature or over it, the crawl's lit threads
// and labels on a 2D overlay above both, debug marks, and stats.
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
import { hash01, type GraphModel } from '@/lib/graph-model';

import { CrawlReplay } from '../../crawl-replay';
import { sampleVault, type SampleVault } from '../../sample-vault';
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

/** What the panel binds to. Plain fields the frame reads; the setters below do the rest. */
export interface LabControls {
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
  backdrop: boolean;
  backdropOrder: BackdropOrder;
  /** Lit threads, found notes and labels, as the Crawl view's overlay draws them. */
  overlay: boolean;
  /** Joints, targets and grip slots. */
  debug: boolean;
}

/** Read-only text for the panel's Stats folder, refreshed twice a second. */
export interface LabStats {
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

/** How far the notes wander with drift on, creature units, and how slowly. */
const DRIFT = 0.3;
const DRIFT_RATE = [0.31, 0.23, 0.27] as const;
/** Frames the stats look back over. */
const STATS_FRAMES = 240;
const STATS_EVERY_MS = 500;
/** How long dispose waits for a shader compile still polling before freeing the renderer. */
const COMPILE_WAIT_MS = 5000;

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

  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly caps: Caps;
  private readonly startTrail: boolean;
  private readonly governor: QualityGovernor;
  private readonly timer: GpuTimer | null;
  private readonly vault: SampleVault;
  private readonly model: GraphModel;
  private readonly unit: number;
  private readonly replay: CrawlReplay;
  private readonly backdrop: LabBackdrop;
  private readonly notes: Map<string, { radius: number; phase: number }>;
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

  private cam: Camera;
  private vp: Viewport = { width: 1, height: 1 };
  private dpr = 1;
  private resized = true;
  private drag: { x: number; y: number; pan: boolean } | null = null;
  private raf = 0;
  private lastNow: number | null = null;

  /** Where each note was laid out, for drift to wander around and come back to. */
  private readonly home: Float64Array;
  private readonly phases: Float64Array;
  private drifting = false;

  private readonly dts = new Samples(STATS_FRAMES);
  private readonly cpus = new Samples(STATS_FRAMES);
  private readonly sims = new Samples(STATS_FRAMES);
  private readonly gpus = new Samples(STATS_FRAMES);
  private statsAt = 0;
  private lastReason = '';
  /** Programs once the view warmed up: the count must stay there, or something compiles mid-crawl. */
  private programsAtReady: number | null = null;

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
    try {
      this.renderer.setClearColor(0x0a0a0a, 1);
      this.fit();

      this.caps = probeCaps(this.renderer);
      const start = startTier(this.caps, recallStable());
      this.startTrail = start === 'trail';
      this.tier = start;
      this.governor = new QualityGovernor(start === 'trail' ? 0 : start, this.caps.timer);
      const gl = this.renderer.getContext();
      this.timer =
        this.caps.timer &&
        typeof WebGL2RenderingContext !== 'undefined' &&
        gl instanceof WebGL2RenderingContext
          ? GpuTimer.create(gl)
          : null;

      this.vault = sampleVault();
      this.model = this.vault.model;
      this.unit = typicalLink(this.model);
      this.notes = new Map(
        this.model.nodes.map((n) => [n.id, { radius: n.radius, phase: n.phase }]),
      );
      this.home = new Float64Array(this.model.nodes.length * 3);
      this.phases = new Float64Array(this.model.nodes.length);
      this.model.nodes.forEach((n, i) => {
        this.home.set([n.x, n.y, n.z || 0], i * 3);
        this.phases[i] = hash01(n.id) * Math.PI * 2;
      });
      this.backdrop = new LabBackdrop(this.model);
      this.baseTwist = Float32Array.from(
        { length: TENTACLES },
        (_, i) => tentacleCharacter(i, SENTINEL_SEED).twist,
      );
      this.font =
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        'ui-monospace, monospace';

      this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.controls = {
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
        backdrop: true,
        backdropOrder: 'under',
        overlay: true,
        debug: false,
      };
      this.stats = {
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

      const bounds = boundsOf(this.model.nodes);
      this.cam = {
        tx: bounds?.cx ?? 0,
        ty: bounds?.cy ?? 0,
        tz: bounds?.cz ?? 0,
        yaw: 0.5,
        pitch: 0.16,
        dist: this.unit * 20,
      };

      this.replay = new CrawlReplay(() => {});
      if (this.tier !== 'trail') this.motion.setTier(this.tier);
      made = this.createView();
      this.view = made;
      this.load(this.controls.preset);

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
      this.freeRenderer();
      throw error;
    }
  }

  // -- What the panel calls ------------------------------------------------------

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
    return JSON.stringify(
      {
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

    // Everything on the GPU goes while the renderer that holds it is alive.
    this.view.dispose();
    this.backdrop.dispose();
    this.timer?.dispose();
    this.room?.dispose();
    Object.assign(DEFAULT_GRIP, this.gripDefaults);
    this.glCanvas.remove();
    this.overlay.remove();

    this.freeRenderer();
  }

  /**
   * Frees the renderer and its context. A shader compile still polling reads
   * the renderer's state until it settles; the renderer goes after it, or
   * after a while if it never does.
   */
  private freeRenderer(): void {
    const renderer = this.renderer;
    const free = () => {
      renderer.dispose();
      renderer.forceContextLoss();
    };
    if (this.ready) free();
    else {
      const wait = new Promise<void>((resolve) => setTimeout(resolve, COMPILE_WAIT_MS));
      void Promise.race([this.warming.catch(() => {}), wait]).then(free);
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

  // -- The crawl -----------------------------------------------------------------

  private load(preset: Preset): void {
    this.replay.load(this.vault.crawls[preset], this.model);
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

  /** Drift: every note wanders a little around where it was laid out. True when positions changed. */
  private drift(now: number): boolean {
    if (!this.controls.drift) {
      if (!this.drifting) return false;
      this.restoreLayout();
      return true;
    }
    this.drifting = true;
    const t = now / 1000;
    const a = DRIFT * this.unit;
    this.model.nodes.forEach((n, i) => {
      const ph = this.phases[i]!;
      n.x = this.home[i * 3]! + a * Math.sin(t * DRIFT_RATE[0] + ph);
      n.y = this.home[i * 3 + 1]! + a * Math.sin(t * DRIFT_RATE[1] + ph * 1.7);
      n.z = this.home[i * 3 + 2]! + a * Math.sin(t * DRIFT_RATE[2] + ph * 2.3);
    });
    return true;
  }

  private restoreLayout(): void {
    this.drifting = false;
    this.model.nodes.forEach((n, i) => {
      n.x = this.home[i * 3]!;
      n.y = this.home[i * 3 + 1]!;
      n.z = this.home[i * 3 + 2]!;
    });
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
      dist: clamp(this.cam.dist / factor, this.unit * 1.5, this.unit * 150),
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
    const moved = this.drift(now);
    if (moved) this.backdrop.place();
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
    const draw = this.ready && this.tier !== 'trail';
    const backdrop = this.controls.backdrop;
    const under = this.controls.backdropOrder === 'under';
    // The graph's pass: it clears and draws, as GraphScene does every frame.
    if (backdrop && under) this.backdrop.render(r, this.cam, this.vp, this.dpr);
    else r.clear();
    let submit = 0;
    if (draw) {
      const t3 = performance.now();
      this.timer?.begin();
      this.view.render(this.motion.pose, this.cam, this.vp, this.dpr);
      this.timer?.end();
      submit = performance.now() - t3;
      assertRendererState(r, 'the Sentinel drew in the lab');
    }
    if (backdrop && !under) {
      withRendererState(r, () => {
        r.autoClear = false;
        this.backdrop.render(r, this.cam, this.vp, this.dpr);
      });
    }
    const gpu = this.timer?.poll() ?? null;
    const cpu = t2 - t0 + submit;

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
    if (now - this.statsAt >= STATS_EVERY_MS) {
      this.statsAt = now;
      this.refreshStats();
    }
  };

  private drawOverlay(now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const project = projector(this.cam, this.vp);
    const P: Project = (p: Vec3) => project(p[0], p[1], p[2]);
    const view = this.replay.view;
    if (this.controls.overlay) {
      drawCrawl(ctx, P, {
        view,
        labels: this.replay.labels,
        note: (id) => this.notes.get(id) ?? null,
        time: now / 1000,
        still: this.still,
        width: this.vp.width,
        font: this.font,
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
        `${snap.state} · ${snap.threads} threads · ${found} found${this.still ? ' · reduced motion' : ''}`,
        'drag to orbit · shift-drag to pan · wheel to zoom',
      ],
      this.vp.height,
      this.font,
    );
  }

  private sentinelNote(): string {
    if (this.failure) return `Sentinel failed: ${this.failure}`;
    if (this.tier === 'trail') {
      return this.startTrail && this.controls.tier === 'auto'
        ? 'Sentinel: software renderer, Crawl would show the trail (force a tier to see it)'
        : 'Sentinel: overloaded at T0, Crawl would show the trail';
    }
    if (!this.ready) return 'Sentinel: warming up…';
    return `Sentinel T${this.tier}${this.controls.backdrop ? ` · backdrop ${this.controls.backdropOrder}` : ''}`;
  }

  private refreshStats(): void {
    const s = this.stats;
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
}
