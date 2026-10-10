// The Sentinel view over the graph: a GraphPlugin that replays crawls
// (CrawlReplay) and draws them on a stage of its own, or, where that stage
// cannot run, as a trail of light over the brain.
//
// It opens on the prompt scene (prompt/prompt-scene.ts): the input at the
// centre, the Sentinel clinging to the frame round it. A send — or a recent
// touched — takes it into the crawl: the panel slides in, the cluster wakes,
// the camera backs out and the creature crosses to the first note. "New
// search" takes it back. Nothing ever plays on its own: an assistant's crawl
// waits under the prompt until somebody touches it.
//
// The stage (stage/sentinel-stage.ts) is three, the dormant network and the
// creature: far too much for the graph's own chunk, so it is imported only
// when the view opens, and this module knows it by its types alone
// (stage/stage-handle.ts). Until it has loaded, built the cluster and
// compiled its shaders, the brain stays on screen under an inert prompt; then
// `stage` returns the facade the controller steps aside for. Anything that
// stops it — the chunk, no WebGL, a software rasteriser, a build or a shader
// that fails, the context lost, a frame that throws, or a start that takes too
// long — sends the view to the trail for the rest of this plugin's life, said
// once on the console and in the panel. The next visit makes a new plugin, so
// it tries again.
//
// The camera is handed between the prompt scene's timeline (the perch shot,
// and the way to the overview and back), the walk the controller follows, and
// the user, in that order: the scene holds it at the prompt, so nothing moves
// it there. The scene's levels are written on the page as CSS variables, so the
// prompt and the panel fade and slide in step with the stage.
//
// The graph rebuilds its model on every change; the cluster is laid out again
// only when what its layout reads changed (space/space-key.ts), a little after
// the last change. A crawl that had finished then shows its end, and one still
// walking starts over from its first note.

import { projector, type Camera, type Viewport } from '@/lib/graph-camera';
import type { GraphModel, GraphNode } from '@/lib/graph-model';

import type { GraphPlugin, PluginFrame, PluginStage } from '../graph-controller';

import { drawCrawl, drawSignal, type Project } from './crawl-draw';
import { decisionIds, type CrawlResult } from './crawl-plan';
import { CrawlReplay } from './crawl-replay';
import type { CrawlSnapshot } from './crawl-snapshot';
import type { PerchShot } from './prompt/perch-geometry';
import { PromptScene, type PromptFrame } from './prompt/prompt-scene';
import {
  AT_CRAWL,
  AT_PROMPT,
  cameraBetween,
  type Levels,
  type SceneName,
} from './prompt/transition';
import { spaceKey } from './space/space-key';
import type { SpaceBuild } from './space/space';
import { OVERVIEW_YAW, notesReach, overviewCamera, stageZoomRange } from './stage/overview';
import type { StageFactory, StageHandle } from './stage/stage-handle';
import type { Vec3 } from './vec';

/** What the panel and the prompt show, sent whenever it changes. */
export interface SentinelUi {
  /** Where the person is, or is going. */
  scene: SceneName;
  /** The prompt takes text and a send. */
  interactive: boolean;
  /** Bumped each time the prompt should take focus (every return to it). */
  focus: number;
  status: 'starting' | 'sentinel' | 'trail';
  /** Why it fell back to the trail, in a few words. */
  failure: string | null;
}

export interface CrawlPluginOptions {
  /** Reduced motion at the start; `setReducedMotion` follows a change. */
  still: boolean;
  /** The creature drawn (the Sentinel switch). */
  sentinel: boolean;
  onSnapshot(s: CrawlSnapshot): void;
  onUi(ui: SentinelUi): void;
  /** The stage's module, imported. A test hands in a fake. */
  loadStage?: () => Promise<StageFactory>;
}

type Status = 'loading' | 'building' | 'warming' | 'ready' | 'trail';

/**
 * Foreground frame time the stage may take to build and compile, ms. Counted
 * in frames — the controller's `dt`, capped at 64 ms — not wall time: a page
 * opened in a background tab draws no frames, and a frame stalled on a
 * compile is not ten seconds of waiting for the person in front of it.
 */
const START_WAIT_MS = 10_000;
/** How long the model must hold still before the cluster is laid out again: a burst of changes builds once. */
const REBUILD_AFTER_MS = 300;
/** The CSS variables it writes on the chrome, taken off when it goes. */
const CSS_VARS = [
  '--crawl-prompt',
  '--crawl-panel',
  '--crawl-prompt-visibility',
  '--crawl-frame-below',
] as const;

const loadSentinelStage = (): Promise<StageFactory> =>
  import('./stage/sentinel-stage').then((m) => m.createStage);

/** The facade the controller sees, built once: it compares `stage` by identity every frame. */
function stageFacade(
  canvas: HTMLCanvasElement,
  s: Omit<PluginStage, 'canvas' | 'locked'> & { locked(): boolean },
): PluginStage {
  return {
    canvas,
    get locked() {
      return s.locked();
    },
    overview: s.overview,
    zoomRange: s.zoomRange,
    resize: s.resize,
    camera: s.camera,
    render: s.render,
  };
}

export class CrawlPlugin implements GraphPlugin {
  private readonly player: CrawlReplay;
  private readonly scene: PromptScene;
  private readonly onUi: (ui: SentinelUi) => void;

  /** The prompt scene's clock, seconds: the replay's steps added up, never wall time. */
  private clock = 0;
  /** This frame's step of the replay, seconds: 0 while paused. */
  private step = 0;
  private playing = true;
  private sentinelOn: boolean;
  private still: boolean;
  private model: GraphModel | null = null;
  private byId = new Map<string, GraphNode>();
  /** The crawl on screen, or last shown: what a rebuild or a fallback plays again. */
  private crawl: { result: CrawlResult; asked: string } | null = null;

  private status: Status = 'loading';
  private failure: string | null = null;
  /** The stage's module, loaded and waiting for a frame to size the stage by. */
  private factory: StageFactory | null = null;
  private gl: StageHandle | null = null;
  /** Kept after a failure: the controller still takes it out of the page. */
  private canvas: HTMLCanvasElement | null = null;
  private facade: PluginStage | null = null;
  /** Foreground frame time spent building and compiling, ms. */
  private waited = 0;
  /** Where the trail, or the start, shows the person: the prompt, or the crawl. */
  private fallbackScene: SceneName = 'prompt';

  private dom: { box: HTMLElement; chrome: HTMLElement } | null = null;
  /** The box and the stage as last laid out: the scene is laid out again only when they change. */
  private rects: number[] = [];
  private layoutDirty: 'move' | 'regrip' | null = null;
  /** To rest on the frame as soon as the box has a place. */
  private pendingRest = false;
  /** The cluster as last built: kept after a failure, for a facade the controller still holds. */
  private build: SpaceBuild | null = null;
  private reach: { build: SpaceBuild; radius: number } | null = null;
  private builtKey: string | null = null;
  private rebuildAt: number | null = null;
  private decisionsKey: string | null = null;
  /** This frame's scene. */
  private sf: PromptFrame | null = null;
  /** The follow camera while the timeline hands over to it: eased on its own, shown blended in. */
  private chase: Camera | null = null;
  /** The camera the stage last drew with: where "New search" eases back from. */
  private lastCam: Camera | null = null;
  /** The controller asked the facade for this frame's camera: `draw` is a stage frame's. */
  private staging = false;

  private css = { prompt: '', panel: '', visibility: '', below: '' };
  private ui: SentinelUi | null = null;
  private focusCount = 0;
  private font: string | null = null;
  private disposed = false;

  /** Starts loading the stage at once. */
  constructor(opts: CrawlPluginOptions) {
    this.still = opts.still;
    this.sentinelOn = opts.sentinel;
    this.onUi = opts.onUi;
    this.player = new CrawlReplay((s) => {
      if (!this.disposed) opts.onSnapshot(s);
    });
    this.scene = new PromptScene(this.player);
    let loading: Promise<StageFactory>;
    try {
      loading = (opts.loadStage ?? loadSentinelStage)();
    } catch (error) {
      loading = Promise.reject(error);
    }
    loading.then(
      (factory) => {
        // Strict Mode mounts twice: the first plugin's import lands after it went, and makes nothing.
        if (!this.disposed && this.status === 'loading') this.factory = factory;
      },
      (error: unknown) => this.fail('the stage failed to load', error),
    );
  }

  /** The prompt's box (what the frame is fitted to) and the element the levels are written on. */
  attach(dom: { box: HTMLElement; chrome: HTMLElement }): void {
    if (this.disposed) return;
    if (this.dom && this.dom.chrome !== dom.chrome) this.clearCss(this.dom.chrome);
    this.dom = dom;
    this.css = { prompt: '', panel: '', visibility: '', below: '' };
    this.rects = [];
    if (this.layoutDirty !== 'regrip') this.layoutDirty = 'move';
  }

  /** The facade while the stage is ready, else null: the controller enters and leaves stage mode by it. */
  get stage(): PluginStage | null {
    return this.status === 'ready' ? this.facade : null;
  }

  draw(ctx: CanvasRenderingContext2D, f: PluginFrame): void {
    if (this.disposed) return;
    if (this.staging) {
      this.staging = false;
      // Over the stage, the labels; nothing if it failed this very frame (the controller leaves it at the next).
      if (this.status === 'ready') this.drawLabels(ctx, f);
      return;
    }
    this.see(f);
    this.start(f);
    // Starting, or the trail: the prompt or the crawl, cut, never a transition.
    this.writeLevels(this.fallbackScene === 'crawl' ? AT_CRAWL : AT_PROMPT);
    this.writeFrameBelow(null);
    this.tell();
    if (this.status === 'trail') this.drawTrail(ctx, f);
  }

  follow(): { x: number; y: number; z: number; dist: number } | null {
    const f = this.player.follow();
    if (!f) return null;
    if (this.status === 'trail') return f;
    const b = this.build;
    if (this.status !== 'ready' || !b) return null;
    // Over the cluster the walk is followed from the space's own distance; at the end, framed whole.
    return this.player.view.mode === 'done' ? f : { ...f, dist: b.unit * b.camera.follow };
  }

  onUserCamera(): void {
    this.scene.takeCamera();
    this.chase = null;
    this.player.onUserCamera();
  }

  /**
   * A crawl to play: from the prompt, the way into it; in the crawl, in place,
   * from its first note. False if nothing can take it now — the stage still
   * starting, or the scene on its way somewhere.
   */
  play(result: CrawlResult, asked: string): boolean {
    const model = this.model;
    if (this.disposed || !model) return false;
    if (this.status === 'ready') {
      const b = this.build;
      if (!this.scene.available || !b) return false;
      if (this.scene.name === 'prompt') {
        if (!this.scene.submit(result, this.clock, this.still)) return false;
        this.chase = null;
        // The cluster's first full upload after rest, and the camera's sweep, are no reason to step down.
        this.gl?.hold(performance.now());
      } else {
        const field = this.scene.field ?? b.field;
        this.player.load(result, model, { field, unit: b.unit, pace: b.pace });
        this.gl?.snap(this.player.view);
      }
      if (this.still) this.settleAtEnd();
    } else if (this.status === 'trail') {
      this.player.load(result, model);
      if (this.still) {
        this.player.skipToEnd();
        this.player.drain();
      }
      this.fallbackScene = 'crawl';
    } else return false;
    this.crawl = { result, asked };
    // A paused walk would hold the way in still, and nothing on screen could resume it.
    this.playing = true;
    this.refreshDecisions();
    this.tell();
    return true;
  }

  /** "New search": back to the prompt from wherever the walk and the camera are. */
  newSearch(): boolean {
    if (this.disposed) return false;
    if (this.status === 'ready') {
      const from = this.lastCam ?? this.scene.shot?.cam;
      if (!from || !this.scene.back(this.clock, this.still, from)) return false;
      this.chase = null;
      this.gl?.hold(performance.now());
      if (this.still) {
        // Back on the frame at once, its grips landed: what happened on the way flares for nothing.
        this.player.skipToEnd();
        this.player.drain();
        this.gl?.finalPose(this.player.view);
      }
    } else if (this.status === 'trail') {
      this.player.clear();
      this.fallbackScene = 'prompt';
    } else return false;
    // The way back runs on the replay's clock: paused, it would never land, and the input would never return.
    this.playing = true;
    this.tell();
    return true;
  }

  /** The crawl from its first note again; nothing at the prompt, where there is no crawl to replay. */
  replay(): void {
    const inCrawl =
      this.status === 'ready'
        ? this.scene.available && this.scene.name === 'crawl'
        : this.status === 'trail' && this.fallbackScene === 'crawl';
    if (!inCrawl || !this.crawl) return;
    this.player.replay();
    this.gl?.snap(this.player.view);
    if (this.still) this.settleAtEnd();
  }

  setPlaying(on: boolean): void {
    this.playing = on;
  }

  followAgain(): void {
    this.player.followAgain();
  }

  /** The creature drawn or not, from the next frame. */
  setSentinel(on: boolean): void {
    this.sentinelOn = on;
  }

  /**
   * Reduced motion: the crawl jumps to its end and the creature to its still
   * pose. At the prompt, or on the way back to it, the creature is on the
   * frame at once, its grips landed; a transition under way ends at the next
   * frame.
   */
  setReducedMotion(on: boolean): void {
    if (on === this.still) return;
    this.still = on;
    if (!on) return;
    if (this.status === 'ready' && this.scene.available && this.scene.name === 'prompt') {
      this.player.skipToEnd();
      this.player.drain();
      this.gl?.finalPose(this.player.view);
    } else this.settleAtEnd();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.factory = null;
    const gl = this.gl;
    this.gl = null;
    gl?.dispose();
    if (this.dom) this.clearCss(this.dom.chrome);
    this.dom = null;
  }

  // -- Starting and failing ----------------------------------------------------------

  /**
   * Outside stage frames: makes the stage once its module is in (sized by
   * this frame), builds the cluster over the model, and gives up if that takes
   * too long. Each step goes to the trail when it fails.
   */
  private start(f: PluginFrame): void {
    if (this.status === 'loading') {
      const factory = this.factory;
      if (!factory) return;
      this.factory = null;
      let gl: StageHandle;
      try {
        gl = factory({ vp: f.vp, dpr: f.dpr });
      } catch (error) {
        this.fail('no WebGL for the stage', error);
        return;
      }
      if (gl.software) {
        gl.dispose();
        this.fail('a software renderer');
        return;
      }
      gl.onLost = () => {
        if (this.gl === gl) this.fail('the WebGL context was lost');
      };
      this.gl = gl;
      this.canvas = gl.canvas;
      this.decisionsKey = null;
      this.status = 'building';
    }
    const gl = this.gl;
    const model = this.model;
    if (this.status === 'building' && gl && model) {
      gl.resize(f.vp, f.dpr);
      let build: SpaceBuild;
      try {
        build = gl.build(model);
      } catch (error) {
        this.fail('the space failed to build', error);
        return;
      }
      this.adopt(build, model);
      this.status = 'warming';
      this.warm(gl);
    }
    if (this.status === 'building' || this.status === 'warming') {
      this.waited += f.dt;
      if (this.waited > START_WAIT_MS) this.fail('the stage took too long to start');
    }
  }

  /** Compiles what the stage has not: the first time it is what makes it ready. */
  private warm(gl: StageHandle): void {
    gl.warmup().then(
      () => {
        if (this.disposed || this.gl !== gl) return;
        if (this.status === 'warming') {
          this.status = 'ready';
          this.facade ??= this.makeFacade(gl.canvas);
          // At the prompt as soon as the box is placed, the claws taking hold anew.
          this.pendingRest = true;
          this.layoutDirty = 'regrip';
          this.tell();
        }
        gl.hold(performance.now());
      },
      (error: unknown) => {
        // A stage left while it compiled rejects on purpose: only the current one's failure counts.
        if (!this.disposed && this.gl === gl) this.fail('a shader failed to compile', error);
      },
    );
  }

  /**
   * The trail for the rest of this plugin's life. The stage goes; a crawl
   * on screen in it is played again over the brain — at its end if it had
   * finished — and anything else goes back to the prompt. The controller
   * leaves stage mode at its next frame, putting the brain's camera back.
   */
  private fail(reason: string, error?: unknown): void {
    if (this.disposed || this.status === 'trail') return;
    // Under way, a transition counts as where it is going.
    const wasCrawl = this.status === 'ready' && this.scene.available && this.scene.name === 'crawl';
    this.status = 'trail';
    this.failure = reason;
    const message = `Sentinel: ${reason}; the walk shows as a trail of light instead.`;
    if (error === undefined) console.warn(message);
    else console.warn(message, error);
    this.factory = null;
    const gl = this.gl;
    this.gl = null;
    gl?.dispose();
    this.scene.setSpace(null, null);
    this.sf = null;
    this.chase = null;
    this.pendingRest = false;
    this.layoutDirty = null;
    this.rebuildAt = null;
    const model = this.model;
    if (wasCrawl && this.crawl && model) {
      const done = this.player.view.mode === 'done';
      this.player.load(this.crawl.result, model);
      if (done || this.still) {
        this.player.skipToEnd();
        this.player.drain();
      }
      this.fallbackScene = 'crawl';
    } else {
      this.player.clear();
      this.fallbackScene = 'prompt';
    }
    this.writeFrameBelow(null);
    this.tell();
  }

  private makeFacade(canvas: HTMLCanvasElement): PluginStage {
    return stageFacade(canvas, {
      // At the prompt, or about to rest there: the perch shot is the only camera the frame fits.
      locked: () => (this.scene.available ? this.scene.name === 'prompt' : this.pendingRest),
      overview: (vp) => this.overviewOf(vp),
      zoomRange: (vp) => (this.build ? stageZoomRange(this.build, vp) : { min: 1e-3, max: 1e6 }),
      resize: (vp, dpr) => {
        this.gl?.resize(vp, dpr);
        // The box moves with the stage: laid out again even in the crawl, so the way back finds it.
        if (this.layoutDirty !== 'regrip') this.layoutDirty = 'move';
      },
      camera: (f) => {
        this.staging = true;
        return this.guarded(() => this.stageCamera(f), null);
      },
      render: (f) => this.guarded(() => this.stageRender(f), undefined),
    });
  }

  /** Runs a stage frame's part; one that throws sends the view to the trail, never into the controller's loop. */
  private guarded<T>(fn: () => T, otherwise: T): T {
    if (this.disposed || this.status !== 'ready') return otherwise;
    try {
      return fn();
    } catch (error) {
      this.fail('a frame failed', error);
      return otherwise;
    }
  }

  // -- The model -----------------------------------------------------------------

  /** A new model from the controller: the replay and the scene follow it, and the cluster may be due again. */
  private see(f: PluginFrame): void {
    if (f.model === this.model) return;
    const model = f.model;
    this.model = model;
    this.byId = new Map(model.nodes.map((n) => [n.id, n]));
    this.player.rebind(model);
    this.scene.setModel(model);
    this.refreshDecisions();
    if (this.gl && this.build) {
      this.rebuildAt = spaceKey(model) !== this.builtKey ? f.now + REBUILD_AFTER_MS : null;
    }
  }

  /** A cluster built over `model`: the scene takes it, and the stage the decisions it shows. */
  private adopt(build: SpaceBuild, model: GraphModel): void {
    this.build = build;
    this.builtKey = spaceKey(model);
    this.rebuildAt = null;
    this.reach = null;
    this.refreshDecisions();
    this.scene.setSpace(build, model);
  }

  /**
   * The cluster laid out again over the model as it now stands. At the
   * prompt, or on the way there, the creature rests on the frame again; a
   * crawl on screen is loaded over the new layout — at its end if it had
   * finished, from its first note if it was still walking. Until its shaders
   * are compiled the stage draws the creature alone.
   */
  private rebuild(): void {
    const gl = this.gl;
    const model = this.model;
    if (!gl || !model) return;
    // Read before the build: setSpace cuts a transition to where it was going.
    const crawl = this.scene.available && this.scene.name === 'crawl' ? this.crawl : null;
    const done = this.player.view.mode === 'done';
    let build: SpaceBuild;
    try {
      build = gl.build(model);
    } catch (error) {
      this.fail('the space failed to build', error);
      return;
    }
    this.adopt(build, model);
    this.chase = null;
    // Laid out in this same frame, before the scene is asked for it.
    this.layoutDirty = 'regrip';
    if (!crawl) this.pendingRest = true;
    else {
      const field = this.scene.field ?? build.field;
      this.player.load(crawl.result, model, { field, unit: build.unit, pace: build.pace });
      if (done || this.still) this.settleAtEnd();
      else gl.snap(this.player.view);
    }
    this.warm(gl);
    gl.hold(performance.now());
  }

  /** The decisions the cluster shows: the graph's, and the crawl's own. Sent only when they change. */
  private refreshDecisions(): void {
    const gl = this.gl;
    const model = this.model;
    if (!gl || !model) return;
    const ids = decisionIds(this.crawl?.result ?? null, model);
    const key = [...ids].sort().join('\n');
    if (key === this.decisionsKey) return;
    this.decisionsKey = key;
    gl.setDecisions(ids);
  }

  // -- A stage frame ---------------------------------------------------------------

  /**
   * First in a stage frame (the lab's order: step, scene, aim): the model
   * seen, the scene's clock moved by this frame's step, the scene laid out and
   * framed, its levels written, and the camera it holds — or null, to leave
   * it to the controller's follow.
   */
  private stageCamera(f: PluginFrame): Camera | null {
    this.see(f);
    if (this.rebuildAt !== null && f.now >= this.rebuildAt) {
      this.rebuildAt = null;
      this.rebuild();
      if (this.status !== 'ready') return null;
    }
    this.step = this.playing ? f.dt / 1000 : 0;
    this.clock += this.step;

    const showing = (this.sf?.levels.prompt ?? 1) > 0;
    // The box is read every frame it shows, since an observer misses a box that
    // moves without resizing; a prompt still waiting for a place reads it too.
    if (this.layoutDirty || showing || this.pendingRest) {
      const rects = this.readRects(f.vp, f.dpr);
      if (rects && (this.layoutDirty || rects.some((v, i) => v !== this.rects[i]))) {
        this.layout(f.vp, this.layoutDirty === 'regrip', rects);
        this.layoutDirty = null;
      }
    }
    if (this.pendingRest && this.scene.available && this.restAtPrompt()) this.pendingRest = false;
    const sf = this.scene.available ? this.scene.frame(this.clock, this.still) : null;
    this.sf = sf;
    // Still waiting for a place: the prompt, inert.
    this.writeLevels(sf?.levels ?? AT_PROMPT);
    this.tell();

    if (sf?.camera) {
      this.chase = null;
      return sf.camera;
    }
    if (sf?.handoff) {
      // The follow's own ease sets off at full speed: shown straight, it would lurch.
      this.chase = this.followed(this.chase ?? { ...sf.handoff.camera }, f.dt);
      return cameraBetween(sf.handoff.camera, this.chase, sf.handoff.k);
    }
    if (this.chase) {
      const last = this.followed(this.chase, f.dt);
      this.chase = null;
      return last;
    }
    return null;
  }

  private stageRender(f: PluginFrame): void {
    const gl = this.gl;
    if (!gl) return;
    this.lastCam = { ...f.cam };
    // Resting under reduced motion nothing happens at all, not even a re-grip.
    this.player.update(this.still && this.player.resting ? 0 : this.step);
    const view = this.player.view;
    const events = this.player.drain();
    gl.render({
      ...f,
      view,
      events,
      scene: this.sf,
      sentinel: this.sentinelOn,
      idle: this.scene.knobs.idle,
      still: this.still,
    });
  }

  /** `c` eased toward the walk, as the controller follows: over 450 ms, at once under reduced motion. */
  private followed(c: Camera, dt: number): Camera {
    const t = this.follow();
    if (!t) return c;
    const k = this.still ? 1 : 1 - Math.exp(-dt / 450);
    return {
      ...c,
      tx: c.tx + (t.x - c.tx) * k,
      ty: c.ty + (t.y - c.ty) * k,
      tz: c.tz + (t.z - c.tz) * k,
      dist: c.dist + (t.dist - c.dist) * k,
    };
  }

  /** At the prompt, resting on the frame, the creature placed there at once: a cut. */
  private restAtPrompt(): boolean {
    if (!this.scene.reset()) return false;
    this.chase = null;
    const view = this.player.view;
    if (this.still) this.gl?.finalPose(view);
    else this.gl?.snap(view);
    return true;
  }

  /** The end of the crawl, at once, and the creature's still pose there. */
  private settleAtEnd(): void {
    this.player.skipToEnd();
    // What happened on the way is history: nothing should flare for it.
    this.player.drain();
    this.gl?.finalPose(this.player.view);
  }

  private overviewOf(vp: Viewport): Camera {
    const b = this.build;
    if (b) return overviewCamera(b.bounds, vp, OVERVIEW_YAW, b.camera.pitch);
    return { ...(this.lastCam ?? { tx: 0, ty: 0, tz: 0, yaw: OVERVIEW_YAW, pitch: 0, dist: 1 }) };
  }

  // -- The prompt on the page -----------------------------------------------------

  /** The box's place on the stage, and the stage's size and density: what the scene is laid out against. */
  private readRects(vp: Viewport, dpr: number): number[] | null {
    const dom = this.dom;
    const canvas = this.canvas;
    if (!dom || !canvas) return null;
    const box = dom.box.getBoundingClientRect();
    const stage = canvas.getBoundingClientRect();
    return [
      box.left - stage.left,
      box.top - stage.top,
      box.width,
      box.height,
      vp.width,
      vp.height,
      dpr,
    ];
  }

  /**
   * Fits the prompt scene to the box as `rects` find it: its corners' radius
   * from the page, the cluster's overview, and how far the notes reach from
   * where it looks. The frame is shaped to match.
   */
  private layout(vp: Viewport, regrip: boolean, rects: number[]): void {
    const build = this.build;
    const dom = this.dom;
    if (!build || !dom) return;
    this.rects = rects;
    const [left, top, width, height] = rects as [number, number, number, number];
    const radius = parseFloat(getComputedStyle(dom.box).borderTopLeftRadius) || 0;
    const overview = overviewCamera(build.bounds, vp, OVERVIEW_YAW, build.camera.pitch);
    this.scene.layout(
      {
        vp,
        rect: { left, top, width, height, radius },
        overview,
        radius: this.reachOf(build, overview),
      },
      regrip,
    );
    this.gl?.shapeBezel(this.scene.shot);
    this.writeFrameBelow(this.scene.shot);
  }

  /** How far a build's notes reach from its overview's target, plus a unit: measured once a build. */
  private reachOf(build: SpaceBuild, overview: Camera): number {
    if (this.reach?.build !== build) {
      const target: Vec3 = [overview.tx, overview.ty, overview.tz];
      this.reach = { build, radius: notesReach(build.positions.values(), target, build.unit) };
    }
    return this.reach.radius;
  }

  /**
   * The levels on the page: the prompt's and the panel's, and the prompt
   * hidden from everyone only once it has faded out — never the instant the
   * scene turns away, or the fade would be cut. Written only when they change.
   */
  private writeLevels(l: Levels): void {
    const chrome = this.dom?.chrome;
    if (!chrome) return;
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

  /**
   * How far the frame reaches below the box, CSS pixels, from the shot the bar
   * was shaped to: the prompt starts its recents that far down. Taken off
   * without a shot (the trail draws no frame).
   */
  private writeFrameBelow(shot: PerchShot | null): void {
    const chrome = this.dom?.chrome;
    if (!chrome) return;
    const css = this.css;
    if (!shot) {
      if (css.below !== '') chrome.style.removeProperty('--crawl-frame-below');
      css.below = '';
      return;
    }
    const below = `${shot.below.toFixed(2)}px`;
    if (below !== css.below) chrome.style.setProperty('--crawl-frame-below', (css.below = below));
  }

  private clearCss(chrome: HTMLElement): void {
    for (const name of CSS_VARS) chrome.style.removeProperty(name);
  }

  /** The page told what the prompt and the panel show, when any of it changed. */
  private tell(): void {
    if (this.disposed) return;
    const ready = this.status === 'ready';
    // From the scene itself, not this frame's: a send or New search turns it before the next frame.
    const scene: SceneName = ready
      ? this.scene.available
        ? this.scene.name
        : 'prompt'
      : this.fallbackScene;
    const interactive = ready
      ? scene === 'prompt' && this.sf?.interactive === true
      : this.status === 'trail' && scene === 'prompt';
    const last = this.ui;
    // Each time the prompt takes text again, it takes focus.
    if (interactive && !last?.interactive) this.focusCount++;
    const ui: SentinelUi = {
      scene,
      interactive,
      focus: this.focusCount,
      status: ready ? 'sentinel' : this.status === 'trail' ? 'trail' : 'starting',
      failure: this.failure,
    };
    if (
      last &&
      last.scene === ui.scene &&
      last.interactive === ui.interactive &&
      last.focus === ui.focus &&
      last.status === ui.status &&
      last.failure === ui.failure
    ) {
      return;
    }
    this.ui = ui;
    this.onUi(ui);
  }

  // -- Drawing on the overlay -----------------------------------------------------

  /** Over the stage, the labels alone, fading with the cluster: the space lights its own threads and notes. */
  private drawLabels(ctx: CanvasRenderingContext2D, f: PluginFrame): void {
    const alpha = this.sf ? this.sf.levels.cluster : 1;
    if (!(alpha > 0)) return;
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    drawCrawl(ctx, this.project(f), {
      view: this.player.view,
      labels: this.player.labels,
      note: () => null,
      time: f.now / 1000,
      still: this.still,
      width: f.vp.width,
      font: this.fontOf(),
      threads: false,
      halos: false,
      alpha,
    });
  }

  /**
   * The trail over the brain: the threads it lit as the brain's curves, the
   * notes it found haloed, the labels, and a point of light where the walk is.
   */
  private drawTrail(ctx: CanvasRenderingContext2D, f: PluginFrame): void {
    this.step = this.playing ? f.dt / 1000 : 0;
    this.player.update(this.step);
    // Nothing flares on the brain: what happened is drawn from the view alone.
    this.player.drain();
    const view = this.player.view;
    if (view.mode === 'idle') return;
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    const P = this.project(f);
    const time = f.now / 1000;
    drawCrawl(ctx, P, {
      view,
      labels: this.player.labels,
      note: (id) => {
        const n = this.byId.get(id);
        return n ? { radius: n.radius, phase: n.phase } : null;
      },
      time,
      still: this.still,
      width: f.vp.width,
      font: this.fontOf(),
      threads: true,
      halos: true,
      alpha: 1,
    });
    if (view.mode !== 'walk' && view.mode !== 'dwell') return;
    const c = this.player.cursor;
    const p = c ? P(c) : null;
    if (p) drawSignal(ctx, p.x, p.y, time, this.still);
  }

  private project(f: PluginFrame): Project {
    const project = projector(f.cam, f.vp);
    return (p) => project(p[0], p[1], p[2]);
  }

  /** The page's monospace, read once it is needed. */
  private fontOf(): string {
    if (this.font === null) {
      const css =
        typeof document === 'undefined'
          ? ''
          : getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
      this.font = css || 'ui-monospace, monospace';
    }
    return this.font;
  }
}
