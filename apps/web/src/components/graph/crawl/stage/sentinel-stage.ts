// The Sentinel view's stage: the dormant network, the Sentinel and the frame
// round the prompt, drawn in a canvas of their own that the graph steps aside
// for while it shows (graph-controller.ts, stage mode). The lab's assembly
// (sentinel/lab/lab-host.ts) brought to the view, without anything the lab
// keeps for judging it — no brain stand-in, drift, stats, debug marks, studio
// light or knobs — and without ever writing a position into the graph's
// notes: the replay walks the space's own field, given its unit, and never
// reads them, so the brain's layout and the layout it saves stay as they are.
//
// Its own WebGLRenderer, set up exactly as graph-scene.ts sets up the graph's,
// so the Sentinel meets the canvas the lab tuned it on. Two contexts on a
// page is the cost; the controller parks the graph's drawing buffer at 1×1
// while this one covers it, and this one is freed — disposed, then its
// context lost on purpose — when the view is left. A canvas keeps its context
// for life and a lost one stays lost, so every entry makes a new stage.
//
// The frame, in the lab's order: the creature's motion first (its CPU time
// measured from there), then the stage's first pass (stage-pass.ts: bare at
// the prompt, the space under a veil on the way, a clear while the space
// compiles), the creature into that depth, and the frame round the prompt
// after it with the depth test on, so a claw curled round the front of the bar
// shows and the body behind it does not.
//
// One quality governor, started from what the GPU says and where the last
// stage on this page settled, fed only frames at rest and only the
// Sentinel's own time: the GPU timer brackets the creature alone, and on the
// frames it does, one pixel is read back first so the space's tail on the GPU
// is not counted as the creature's. That read stalls the CPU until the GPU
// catches up, so it is taken one frame in SPLIT_EVERY, and each reading stands
// for the frames until the next.

import * as THREE from 'three';

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel } from '@/lib/graph-model';

import type { PerchShot } from '../prompt/perch-geometry';
import type { IdleLife } from '../prompt/prompt-scene';
import type { ReplayView } from '../replay-view';
import { assertRendererState, withRendererState } from '../sentinel/gl-state';
import { GpuTimer } from '../sentinel/gpu-timer';
import { SentinelMotion, type MotionParams } from '../sentinel/motion';
import { probeCaps } from '../sentinel/probe';
import {
  QualityGovernor,
  recallStable,
  rememberStable,
  startTier,
  type Caps,
} from '../sentinel/quality';
import type { Tier } from '../sentinel/tiers';
import { SentinelView, creatureBounds } from '../sentinel/view';
import { DormantNetwork } from '../space/dormant/dormant-network';
import type { SpaceBuild } from '../space/space';

import { PromptBezel } from './bezel';
import { blankEye, sentinelEye, standInEye, type SpaceEye } from './eye';
import type { StageFactory, StageFrame, StageHandle } from './stage-handle';
import { stagePass } from './stage-pass';
import { Veil } from './veil';

/** The motion params the prompt's idle life stands in for, blended by its level: the body's, never the tentacles'. */
const IDLE_KEYS = [
  'breathing',
  'humAmplitude',
  'bob',
] as const satisfies readonly (keyof IdleLife)[];

/** How long dispose waits for a shader compile still polling before freeing the renderer. */
const COMPILE_WAIT_MS = 5000;
/**
 * One frame in this many is timed on the GPU, after a read-back that makes
 * the GPU finish the stage's pass first. At 60 fps that is 7–8 readings a
 * second, and each one stands for the frames until the next, so the
 * governor's window always holds enough of them to decide on.
 */
const SPLIT_EVERY = 8;

/** The canvas the stage draws in: over the graph's, under the overlay, taking no input. */
function stageCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.position = 'absolute';
  c.style.inset = '0';
  c.style.display = 'block';
  c.style.width = '100%';
  c.style.height = '100%';
  c.style.pointerEvents = 'none';
  c.setAttribute('aria-hidden', 'true');
  return c;
}

export class SentinelStage implements StageHandle {
  readonly canvas: HTMLCanvasElement;
  readonly software: boolean;
  onLost: (() => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly caps: Caps;
  private readonly governor: QualityGovernor;
  /** The Sentinel's own GPU time; null without WebGL2 and the timer extension. */
  private readonly timer: GpuTimer | null;
  private readonly motion = new SentinelMotion();
  /** The walk's motion params, as tuned; the motion reads `live`, the same with the prompt's life blended in. */
  private readonly params: MotionParams;
  private readonly live: MotionParams;
  private readonly view: SentinelView;
  private readonly bezel: PromptBezel;
  private readonly veil: Veil;
  /** The eye the space and the frame are told of, written in place every frame. */
  private readonly eye: SpaceEye = blankEye();
  private readonly pixel = new Uint8Array(4);

  private space: DormantNetwork | null = null;
  private built: SpaceBuild | null = null;
  private decisions: ReadonlySet<string> = new Set();
  private tier: Tier | 'trail';
  /** The view's warm-up, started at once: it loads and compiles the creature. */
  private readonly viewWarming: Promise<void>;
  private viewReady = false;
  /** The frame's and the veil's compile, started by the first warmup(). */
  private promptWarming: Promise<void> | null = null;
  private promptWarm = false;
  /** The space as last built has its shaders compiled; until then it does not draw. */
  private spaceWarm = false;
  /** The space's compiles, one after another: a build while one polls waits for it. */
  private spaceChain: Promise<void> = Promise.resolve();
  /** Every compile still polling the renderer: it must outlive them all. */
  private readonly compiling = new Set<Promise<unknown>>();
  private frames = 0;
  /** The last GPU reading, standing for the frames until the next. */
  private gpu: number | null = null;
  private disposed = false;

  constructor(vp: Viewport, dpr: number) {
    this.canvas = stageCanvas();
    // Exactly as graph-scene.ts makes the graph's: the Sentinel draws into this canvas as it did in the lab.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // Whatever fails from here on, the context must not outlive it: a page
    // gets only a few, and the graph holds one.
    let view: SentinelView | null = null;
    let bezel: PromptBezel | null = null;
    let veil: Veil | null = null;
    let timer: GpuTimer | null = null;
    try {
      this.renderer.setClearColor(0x0a0a0a, 1);
      // Sized before the probe: the starting tier reads the drawing buffer's pixels.
      this.size(vp, dpr);
      this.params = this.motion.params;
      this.live = { ...this.params };
      this.motion.params = this.live;

      this.caps = probeCaps(this.renderer);
      const start = startTier(this.caps, recallStable());
      this.software = start === 'trail';
      this.tier = start;
      this.governor = new QualityGovernor(start === 'trail' ? 0 : start, this.caps.timer);
      const gl = this.renderer.getContext();
      timer =
        this.caps.timer &&
        typeof WebGL2RenderingContext !== 'undefined' &&
        gl instanceof WebGL2RenderingContext
          ? GpuTimer.create(gl)
          : null;
      this.timer = timer;
      if (start !== 'trail') this.motion.setTier(start);

      bezel = new PromptBezel();
      this.bezel = bezel;
      veil = new Veil();
      this.veil = veil;
      view = new SentinelView(this.renderer, {
        tier: start === 'trail' ? 0 : start,
        floatColor: this.caps.floatColor,
      });
      this.view = view;
      // A software stage is disposed at once: nothing is worth loading for it.
      this.viewWarming = this.software
        ? Promise.reject(new Error('Sentinel stage: a software renderer'))
        : this.track(view.warmup()).then(() => {
            this.viewReady = true;
          });
      // Settled either way; whoever asks for a warmup hears how it went.
      this.viewWarming.catch(() => {});
      this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    } catch (error) {
      view?.dispose();
      bezel?.dispose();
      veil?.dispose();
      timer?.dispose();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      throw error;
    }
  }

  build(model: GraphModel): SpaceBuild {
    if (this.disposed) throw new Error('Sentinel stage: build after dispose');
    this.space ??= new DormantNetwork();
    this.spaceWarm = false;
    const build = this.space.build(model);
    this.space.setDecisions(this.decisions);
    this.built = build;
    return build;
  }

  warmup(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Sentinel stage: warmup after dispose'));
    const parts: Promise<void>[] = [];
    if (!this.viewReady) parts.push(this.viewWarming);
    if (!this.promptWarm) parts.push((this.promptWarming ??= this.warmPrompt()));
    if (this.space && !this.spaceWarm) parts.push(this.warmSpace());
    return Promise.all(parts).then(() => {
      // Uploads and the first frames after a compile stutter: no reason to step down.
      if (!this.disposed) this.hold(performance.now());
    });
  }

  setDecisions(ids: ReadonlySet<string>): void {
    this.decisions = new Set(ids);
    this.space?.setDecisions(this.decisions);
  }

  shapeBezel(shot: PerchShot | null): void {
    this.bezel.shape(shot?.bezel ?? null);
  }

  resize(vp: Viewport, dpr: number): void {
    if (this.disposed) return;
    this.size(vp, dpr);
    this.hold(performance.now());
  }

  hold(now: number): void {
    this.governor.hold(now);
    this.gpu = null;
  }

  snap(view: ReplayView): void {
    this.motion.snap(view);
  }

  finalPose(view: ReplayView): void {
    this.motion.finalPose(view);
  }

  render(f: StageFrame): void {
    if (this.disposed) return;
    const r = this.renderer;
    const { cam, vp, dpr, scene } = f;
    const prompt = scene ? scene.levels.prompt : 0;

    // The Sentinel's own CPU time: its motion and its draw calls.
    const t0 = performance.now();
    this.motion.gaze = scene?.gaze ?? null;
    this.blendLife(f.idle, prompt);
    this.motion.step(f.view, f.events, f.dt / 1000, f.now / 1000, f.still);
    let cpu = performance.now() - t0;

    const draw = this.viewReady && this.tier !== 'trail' && f.sentinel;
    // The Sentinel's eye when it draws; otherwise a stand-in at the walk, burning
    // as the creature's does when nothing flares, so the space still wakes.
    const p = this.params;
    const eye = draw
      ? sentinelEye(this.motion.pose, this.eye)
      : standInEye(f.view, f.still ? p.eyeStill : p.eyeBase, this.eye);
    const unit = this.built?.unit ?? f.view.unit;

    // The planes the creature and the frame share one depth in: the space's, or the frame's.
    let depth: { near: number; far: number } | null = null;
    const pass = this.space && this.built ? stagePass(scene, this.spaceWarm) : 'clear';
    if (pass === 'bare' && scene) {
      withRendererState(r, () => {
        r.state.buffers.depth.setMask(true);
        r.clear();
      });
      depth = scene.atRest
        ? this.bezel.planes(cam, unit)
        : this.bezel.planes(cam, unit, draw ? creatureBounds(this.motion.pose) : null);
    } else if (pass === 'space' && this.space) {
      // The dormant network lends the creature no light of its own: the hangar
      // suits a dark cluster. A space that did would be lent through
      // view.setEnvironment, and taken back before it is disposed.
      this.space.render(r, { cam, vp, dpr, view: f.view, time: f.now / 1000, still: f.still, eye });
      assertRendererState(r, 'the dormant network drew');
      const cluster = scene?.levels.cluster ?? 1;
      if (cluster < 1) {
        this.veil.render(r, 1 - cluster);
        // Crystals veiled to nothing must not cut holes in the creature.
        withRendererState(r, () => {
          r.state.buffers.depth.setMask(true);
          r.clearDepth();
        });
        assertRendererState(r, 'the veil drew');
      }
      depth = this.space.depth;
    } else r.clear();

    if (draw) {
      const timed = this.timer !== null && this.frames++ % SPLIT_EVERY === 0;
      if (timed) {
        const gl = r.getContext();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
        this.timer?.begin();
      }
      const t1 = performance.now();
      this.view.render(this.motion.pose, cam, vp, dpr, { depth });
      cpu += performance.now() - t1;
      if (timed) this.timer?.end();
      assertRendererState(r, 'the Sentinel drew');
    }

    // The frame after the creature, depth-tested: it hides what lies behind it, and fades over it.
    if (scene && prompt > 0 && this.promptWarm) {
      this.bezel.render(r, { cam, vp, level: prompt, unit, depth, eye });
      assertRendererState(r, 'the prompt frame drew');
    }

    this.gpu = this.timer?.poll() ?? this.gpu;
    const decision = this.governor.sample({
      now: f.now,
      // Only the creature at rest counts: never the brain's layout ticks, nor a space compiling.
      settled: draw && f.settled && this.spaceWarm,
      cpuMs: cpu,
      gpuMs: this.gpu,
    });
    if (decision.changed) this.applyTier(decision.tier);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onLost = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    // Everything on the GPU goes while the renderer that holds it is alive.
    this.view.dispose();
    this.space?.dispose();
    this.bezel.dispose();
    this.veil.dispose();
    this.timer?.dispose();
    rememberStable(this.tier);
    // The controller may already have taken it out.
    this.canvas.remove();
    this.freeRenderer();
  }

  // -- Inside --------------------------------------------------------------------

  private size(vp: Viewport, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(vp.width, vp.height, false);
  }

  /** Tracks a compile until it settles, so the renderer outlives it. Returns it as it is. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.compiling.add(p);
    const done = () => this.compiling.delete(p);
    p.then(done, done);
    return p;
  }

  /** The frame's and the veil's shaders, compiled before either first draws: a transition must not stall. */
  private warmPrompt(): Promise<void> {
    const r = this.renderer;
    // Tracked apart: one that fails must not let the renderer go while the other still polls.
    const parts = [this.track(this.bezel.warmup(r)), this.track(this.veil.warmup(r))];
    return Promise.all(parts).then(() => {
      this.promptWarm = true;
    });
  }

  /**
   * The space's shaders, compiled for this canvas after a build. One compile
   * at a time: a build while the last still polls waits for it, and a compile
   * whose build was replaced meanwhile leaves the space cold for the next.
   */
  private warmSpace(): Promise<void> {
    const space = this.space!;
    const build = this.built;
    const next = this.spaceChain.then(async () => {
      if (this.disposed) throw new Error('Sentinel stage: disposed while warming up');
      if (this.built !== build) return;
      await this.track(space.warmup(this.renderer));
      if (this.built === build) this.spaceWarm = true;
    });
    this.spaceChain = next.catch(() => {});
    return next;
  }

  /**
   * The motion's params this frame: the walk's, with the prompt's idle life
   * blended in by its level — at the prompt the body breathes and bobs, in
   * the crawl it moves exactly as tuned.
   */
  private blendLife(idle: IdleLife, k: number): void {
    const live = this.live;
    Object.assign(live, this.params);
    if (!(k > 0)) return;
    const share = Math.min(1, k);
    for (const key of IDLE_KEYS) live[key] = live[key] + (idle[key] - live[key]) * share;
  }

  /** Steps the detail; never a compile (tiers.ts). On the trail the creature stops drawing. */
  private applyTier(tier: Tier | 'trail'): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.gpu = null;
    if (tier === 'trail') return;
    this.motion.setTier(tier);
    this.view.setTier(tier);
  }

  private readonly onContextLost = (): void => {
    // Never restored (no preventDefault): the view falls back to the trail for good.
    if (!this.disposed) this.onLost?.();
  };

  /**
   * Frees the renderer and its context. A shader compile still polling reads
   * the renderer's state until it settles, and throws once that state is
   * gone: the renderer goes after all of them, or after a while if one never
   * settles.
   */
  private freeRenderer(): void {
    const renderer = this.renderer;
    const free = () => {
      renderer.dispose();
      // A context lost already (the browser took it) cannot be lost again.
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    };
    if (this.compiling.size === 0) {
      free();
      return;
    }
    const settled = [...this.compiling].map((p) => p.catch(() => {}));
    const wait = new Promise<void>((resolve) => setTimeout(resolve, COMPILE_WAIT_MS));
    void Promise.race([Promise.all(settled), wait]).then(free);
  }
}

/** The Sentinel view's stage, sized for the container: what the plugin imports this module for. */
export const createStage: StageFactory = ({ vp, dpr }) => new SentinelStage(vp, dpr);
