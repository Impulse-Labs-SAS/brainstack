// Ties the layout (graph-engine), the WebGL scene (graph-scene) and the 2D
// overlay (graph-overlay) together: camera, pointer and keyboard, focus and
// paths, growth replay and the frame loop. React owns the chrome around the
// canvas and hears about selection, hover and the rest through `events`. A
// feature built over the graph plugs in as a GraphPlugin, and may bring a
// stage of its own that the graph steps aside for (stage mode, below).
//
// Nothing here re-renders React while the graph animates: the loop runs on
// refs and plain objects, and only changes a panel shows go through events.

import {
  ANGLES,
  TAN_HALF_FOV,
  basis,
  boundsOf,
  fitBounds,
  fitBrain,
  interpolate,
  orbitBy,
  outward,
  panBy,
  pixelsPerUnit,
  zoomFlatAt,
  type AnglePreset,
  type Camera,
  type Viewport,
} from '@/lib/graph-camera';
import {
  findPath,
  hopsFrom,
  neighbourToward,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type GraphPath,
  type GraphView,
} from '@/lib/graph-model';

import { GraphEngine, type RebuildReason } from './graph-engine';
import {
  drawMinimap,
  drawOverlay,
  forgetTextWidths,
  landPaths,
  pickNode,
  projectNodes,
  type LandPaths,
  type MinimapTransform,
} from './graph-overlay';
import { GraphScene } from './graph-scene';

/**
 * Something a feature built over the graph draws — the Sentinel view. It sees the frame, never
 * the controller: it draws over the overlay, may ask the camera to keep a point in view, and
 * may bring a stage of its own that the graph steps aside for. Removing it leaves the graph
 * exactly as it was.
 */
export interface GraphPlugin {
  /** Every frame, after the overlay (or, in stage mode, on the cleared overlay). */
  draw(ctx: CanvasRenderingContext2D, frame: PluginFrame): void;
  /** A point to keep in view and how close to stay, or null to leave the camera alone. */
  follow(): { x: number; y: number; z: number; dist: number } | null;
  /** The user took the camera: dragged, zoomed, clicked or pressed Fit. */
  onUserCamera(): void;
  /**
   * A stage drawn instead of the graph while it is non-null. Read once a frame: it appears when
   * the stage is ready and goes when it fails, and the controller enters and leaves stage mode
   * as it does. Absent: drawn over the graph, as ever.
   */
  readonly stage?: PluginStage | null;
}

export interface PluginStage {
  /** Its own canvas. The controller lays it just under the overlay on entering stage mode,
   *  fades it in and takes it out on leaving; the stage makes, sizes and frees it. */
  readonly canvas: HTMLCanvasElement;
  /** It holds the camera still (the prompt): drags, the wheel, + / − and Fit change nothing. */
  readonly locked: boolean;
  /** Where Fit goes: the whole of what it draws. */
  overview(vp: Viewport): Camera;
  /** The camera distances the wheel and + / − keep between, world units. */
  zoomRange(vp: Viewport): { min: number; max: number };
  /** The container's size: on entering, and whenever it changes. */
  resize(vp: Viewport, dpr: number): void;
  /** First each frame: the camera it holds this frame, or null to leave it to the controller. */
  camera(frame: PluginFrame): Camera | null;
  /** Draws the frame with the camera the controller settled on. */
  render(frame: PluginFrame): void;
}

export interface PluginFrame {
  now: number;
  /** Milliseconds since the last frame. */
  dt: number;
  cam: Camera;
  vp: Viewport;
  dpr: number;
  model: GraphModel;
  reduceMotion: boolean;
  /**
   * No layout tick, warm-up or growth this frame: the graph is at rest (what a quality
   * governor may count).
   */
  settled: boolean;
}

export type Selection = { kind: 'note'; node: GraphNode } | { kind: 'path'; path: GraphPath };

/** Territories: the country under the pointer, for its tooltip. */
export interface CountryHover {
  id: string;
  label: string;
  vault: string;
  notes: number;
  folders: number;
  /** Links from its notes to notes in other countries. */
  routes: number;
}

export interface ControllerEvents {
  onSelection(selection: Selection | null): void;
  onHover(node: GraphNode | null): void;
  onHoverCountry(country: CountryHover | null): void;
  onToast(message: string): void;
  onGrowth(active: boolean): void;
  onSpin(spinning: boolean): void;
  onAngle(angle: AnglePreset | null): void;
  onOpen(node: GraphNode): void;
  /** The layout came to rest: a good moment to remember it. */
  onSettled(): void;
}

interface Elements {
  stage: HTMLElement;
  gl: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  tooltip: HTMLElement;
  timeChip: HTMLElement;
}

type Drag = {
  kind: 'node' | 'orbit' | 'pan';
  node: GraphNode | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  travel: number;
  shift: boolean;
  origin: { x: number; y: number; z: number } | null;
};

type Tween = { from: Camera; to: Camera; t0: number; duration: number };

const CLICK_SLOP = 4;
const MONTH_YEAR = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });
const PREVIEW_OFFSET = 160;
const SPIN_PER_MS = 0.00008;
/** How far a search match springs out of the brain, as a share of its size. */
const LIFT_REACH = 0.13;
/** Past this many matches the rest only glow: a hundred notes flying out is a cloud, not an answer. */
const MAX_LIFTED = 150;
const LIFT_MS = 720;
const LIFT_STAGGER_MS = 30;
const DROP_MS = 380;
/** How long a plugin's stage takes to fade in over the graph's last frame. */
const STAGE_FADE_MS = 400;
/** The graph's drawing buffer while a stage covers it: none of it shows, so it holds no memory. */
const PARKED: Viewport = { width: 1, height: 1 };

type LiftTween = { from: number; to: number; t0: number };

/** Out past the target and back: the spring of a note leaving the brain. */
function easeOutBack(t: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class GraphController {
  readonly webgl: boolean;
  private readonly engine: GraphEngine;
  private readonly scene: GraphScene | null;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly minimapCtx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly fonts: { sans: string; mono: string };
  private cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 800 };
  private vp: Viewport = { width: 800, height: 600 };
  private dpr = 1;
  private tween: Tween | null = null;
  private userMoved = false;
  private spin = false;

  private hover: GraphNode | null = null;
  private selected: GraphNode | null = null;
  private pathFrom: GraphNode | null = null;
  private path: GraphPath | null = null;
  private pathT0 = 0;
  private pathPick = false;
  private focus: GraphNode | null = null;
  private focusT0 = 0;
  private hops: Map<GraphNode, number> | null = null;
  private matched: Set<GraphNode> | null = null;
  private matches: GraphNode[] | null = null;
  private searchT0 = 0;
  /** A result under the pointer in the results list: lit like a hovered note. */
  private previewed: GraphNode | null = null;
  // Search lift: which matches are sprung out, and the tweens still running.
  private lifted = new Set<GraphNode>();
  private liftTweens = new Map<GraphNode, LiftTween>();
  /** How far lifted notes may go: 1 in the brain, 0 in the flat views, eased between. */
  private liftReach = 0;
  private edgesDirty = true;
  /** When edge brightness was last recomputed. */
  private edgesLitAt = 0;

  // Territories.
  private hotCountry: string | null = null;
  private countryRoutes: GraphEdge[] | null = null;
  private routesLayer = false;
  private landAlpha = 0;
  private mapBlend = 0;
  private edgeScale = 1;
  private land: { version: number; paths: LandPaths; landed: Set<string> } | null = null;

  private drag: Drag | null = null;
  private raf = 0;
  private lastFrame = 0;
  private frameNo = 0;
  private minimapTransform: MinimapTransform | null = null;
  private wasMoving = false;
  private growing = false;
  private chipTimer = 0;
  private plugin: GraphPlugin | null = null;

  // Stage mode: a plugin's stage drawn instead of the graph (see `syncStage`).
  private staged: PluginStage | null = null;
  /**
   * The brain's camera when the stage came; put back when it goes. `resized`: notes came or
   * went under the stage, so the camera it comes back to was framed for another brain.
   */
  private brain: {
    cam: Camera;
    tween: Tween | null;
    userMoved: boolean;
    resized: boolean;
  } | null = null;
  /** Non-null while a plugin is attached: the graph does not spin; this is the spin to resume. */
  private spinAfter: boolean | null = null;
  /** The stage canvas's opacity, 0–1. */
  private fade = 0;
  /** The graph's drawing buffer is 1×1 (`PARKED`). */
  private parked = false;
  /** The next graph frame uploads positions, levels and edges: none were under the stage. */
  private reupload = false;
  private disposed = false;

  constructor(
    private readonly el: Elements,
    private readonly events: ControllerEvents,
    private readonly reduceMotion: boolean,
  ) {
    this.engine = new GraphEngine(reduceMotion);
    let scene: GraphScene | null = null;
    try {
      scene = new GraphScene(el.gl);
    } catch {
      // No WebGL: the overlay draws the flat views on its own.
      scene = null;
    }
    this.scene = scene;
    this.webgl = !!scene;
    this.ctx = el.overlay.getContext('2d')!;
    this.minimapCtx = el.minimap.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    this.fonts = {
      sans: css.getPropertyValue('--font-sans').trim() || 'ui-sans-serif, system-ui, sans-serif',
      mono: css.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
    };
    void document.fonts?.ready.then(() => forgetTextWidths());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el.stage);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Attach a plugin, or detach the one attached. While one is, the graph holds its spin (and
   * hands it back on detach); its stage, when it has one, comes and goes on its own (see
   * `syncStage`). The camera is not saved here: the view switches to the brain around the same
   * commit, and a camera saved now could be the one that switch is about to replace.
   */
  setPlugin(plugin: GraphPlugin | null): void {
    if (plugin === this.plugin) return;
    if (this.plugin) {
      this.leaveStage();
      const spin = this.spinAfter ?? false;
      this.plugin = null;
      this.spinAfter = null;
      if (!this.disposed) this.setSpin(spin);
    }
    // After dispose (React may clean the panel up after the view) only references go.
    if (!plugin || this.disposed) return;
    this.stopGrowth(); // it would play unseen under a stage
    this.clearSelection(); // closes the preview
    const spin = this.spin;
    this.setSpin(false);
    this.spinAfter = spin;
    this.plugin = plugin;
  }

  dispose(): void {
    this.disposed = true;
    this.leaveStage();
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    clearTimeout(this.chipTimer);
    this.scene?.dispose();
  }

  get view(): GraphView {
    return this.engine.view;
  }
  get model(): GraphModel | null {
    return this.engine.model;
  }

  // -- Inputs from React ----------------------------------------------------------

  setModel(
    model: GraphModel,
    reason: RebuildReason,
    saved?: ReadonlyMap<string, { x: number; y: number; z: number }>,
  ): void {
    this.growing = false;
    this.engine.setModel(model, reason, performance.now(), saved);
    this.scene?.setModel(model);
    if (reason === 'init') {
      const angle = this.engine.is3D ? ANGLES.threeQuarter : { yaw: 0, pitch: 0 };
      // Under a stage the framing is the brain's, for when it comes back.
      if (this.brain)
        this.brain = {
          ...this.brain,
          cam: { ...this.brain.cam, ...this.fitTarget(), ...angle },
          tween: null,
        };
      else this.cam = { ...this.cam, ...this.fitTarget(), ...angle };
      this.setSpin(this.engine.is3D);
    }
    const keep = (n: GraphNode | null) => (n && model.nodes.includes(n) ? n : null);
    // A note that left the model lands at once: nothing would finish its tween.
    const present = new Set(model.nodes);
    for (const n of this.liftTweens.keys()) {
      if (present.has(n)) continue;
      this.liftTweens.delete(n);
      n.lift = n.ox = n.oy = n.oz = 0;
    }
    this.setHotCountry(null);
    if (this.selected && !keep(this.selected)) this.clearSelection();
    if (this.path && !this.path.nodes.every((n) => model.nodes.includes(n))) this.clearSelection();
    this.hover = keep(this.hover);
    this.previewed = keep(this.previewed);
    this.focus = null;
    this.userMoved = false;
    // Notes came or went: the brain comes back eased to its new size, not where it was left
    // (a first layout was framed for it above).
    if (this.brain) this.brain = { ...this.brain, userMoved: false, resized: reason !== 'init' };
    this.edgesDirty = true;
  }

  /** The first view, before any model: decides how the first layout is shaped. */
  initView(view: GraphView): void {
    this.engine.view = view;
  }

  setView(view: GraphView): void {
    if (view === this.engine.view) return;
    if (view === 'brain' && !this.webgl) return;
    const was3D = this.engine.is3D;
    this.stopGrowth();
    this.setHotCountry(null);
    const rescale = this.engine.setView(view);
    this.userMoved = false;
    this.edgesDirty = true;
    this.events.onAngle(null);
    if (rescale) {
      // The layout was rescaled into the brain; the camera follows so the first frame matches.
      const { k, cx, cy, oy } = rescale;
      this.cam = {
        ...this.cam,
        tx: (this.cam.tx - cx) * k,
        ty: (this.cam.ty - cy) * k + oy,
        tz: 0,
        dist: this.cam.dist * k,
      };
      this.animateTo({ ...this.cam, ...this.fitTarget(), ...ANGLES.threeQuarter }, 1300);
      this.setSpin(true);
    } else if (was3D || this.engine.isMap) {
      // The map's shape is known before the notes get there: fly straight to it.
      this.animateTo({ ...this.cam, ...this.fitTarget(), tz: 0, yaw: 0, pitch: 0 }, 1000);
      this.setSpin(false);
    }
  }

  /** Territories: every link drawn faintly over the map, not only the routes of what you point at. */
  setRoutes(on: boolean): void {
    this.routesLayer = on;
  }

  /**
   * What a search found, best first; null when there is no search. The
   * matches spring out of the brain (in the flat views they only grow) and
   * send a ping; whatever stopped matching drops back into place.
   */
  setMatches(matches: GraphNode[] | null): void {
    this.matches = matches;
    this.matched = matches ? new Set(matches) : null;
    this.searchT0 = performance.now();
    this.edgesDirty = true;
    this.scene?.lightCountries(
      matches
        ? new Set(matches.map((n) => n.project?.id).filter((id): id is string => !!id))
        : null,
    );

    const now = this.searchT0;
    const lift = this.reduceMotion ? [] : (matches ?? []).slice(0, MAX_LIFTED);
    this.lifted = new Set(lift);
    const rank = new Map(lift.map((n, i) => [n, i]));
    for (const n of this.model?.nodes ?? []) {
      const to = rank.has(n) ? 1 : 0;
      const current = this.liftTweens.get(n)?.to ?? n.lift;
      if (current === to) continue;
      const delay = to ? Math.min(rank.get(n)!, 24) * LIFT_STAGGER_MS : 0;
      this.liftTweens.set(n, { from: n.lift, to, t0: now + delay });
    }
  }

  /** A result under the pointer in the results list, or null when it leaves. */
  preview(node: GraphNode | null): void {
    if (this.staged) return;
    this.previewed = node;
  }

  /** Bring every match into view. */
  frameMatches(): void {
    if (this.staged) return;
    const nodes = this.matches?.filter((n) => Number.isFinite(n.x));
    if (!nodes?.length) return;
    if (nodes.length === 1) {
      this.flyTo(nodes[0]!);
      return;
    }
    this.setSpin(false);
    // Where they are drawn, sprung out of the brain, not where they live.
    const b = boundsOf(
      nodes.map((n) => ({ x: n.x + n.ox, y: n.y + n.oy, z: (n.z || 0) + n.oz, radius: n.radius })),
    );
    // In the brain, as close as a click on one note would go; flat, the usual cap.
    const maxScale = this.engine.is3D
      ? this.vp.height / 2 / (TAN_HALF_FOV * this.engine.brainScale * 1.9)
      : 1.6;
    if (b)
      this.animateTo({
        ...this.cam,
        ...fitBounds(b, this.vp, { maxScale, depth: this.engine.is3D }),
      });
    this.userMoved = true;
  }

  select(node: GraphNode): void {
    if (this.staged) return;
    this.selected = node;
    this.path = null;
    this.pathFrom = null;
    this.pathPick = false;
    this.edgesDirty = true;
    this.events.onSelection({ kind: 'note', node });
    this.setSpin(false);
    this.flyTo(node);
  }

  clearSelection(): void {
    this.selected = null;
    this.path = null;
    this.pathFrom = null;
    this.pathPick = false;
    this.edgesDirty = true;
    this.events.onSelection(null);
  }

  /** Pick the other end of a path with the next click. */
  startPathFrom(node: GraphNode): void {
    if (this.staged) return;
    this.pathFrom = node;
    this.pathPick = true;
    this.events.onToast('Click the note to trace a path to.');
  }

  zoom(factor: number): void {
    const stage = this.staged;
    if (stage) {
      if (stage.locked) return;
      this.plugin?.onUserCamera();
      this.zoomStage(stage, factor);
      return;
    }
    this.zoomAt(this.vp.width / 2, this.vp.height / 2, factor);
  }

  fit(): void {
    const stage = this.staged;
    if (stage) {
      if (stage.locked) return;
      // The whole of the stage, seen from where the user turned it; and it stops following.
      this.plugin?.onUserCamera();
      const o = stage.overview(this.vp);
      this.animateTo({ ...this.cam, tx: o.tx, ty: o.ty, tz: o.tz, dist: o.dist });
      return;
    }
    this.animateTo({ ...this.cam, ...this.fitTarget() });
    this.userMoved = false;
  }

  setAngle(angle: AnglePreset): void {
    if (this.staged) return;
    this.setSpin(false);
    this.animateTo({ ...this.cam, ...this.fitTarget(), ...ANGLES[angle] }, 900);
    this.userMoved = true;
    this.events.onAngle(angle);
  }

  setSpin(on: boolean): void {
    // A plugin is attached: recorded, and applied when it goes.
    if (this.spinAfter !== null) {
      this.spinAfter = on;
      return;
    }
    this.spin = on && !this.reduceMotion && this.engine.is3D;
    this.events.onSpin(this.spin);
  }

  startGrowth(): void {
    if (this.staged || !this.model?.nodes.length) return;
    this.clearSelection();
    this.engine.startGrowth(performance.now());
    this.userMoved = false;
    this.tween = null;
    this.growing = true;
    this.events.onGrowth(true);
  }

  stopGrowth(): void {
    if (!this.engine.growth) return;
    this.engine.endGrowth();
    this.finishGrowth();
  }

  snapshot(): Record<string, [number, number, number]> {
    return this.engine.snapshot();
  }

  // -- Pointer and keyboard ----------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    const model = this.model;
    if (!model) return;
    if (this.staged) {
      this.stageDown(e, this.staged);
      return;
    }
    this.el.overlay.setPointerCapture(e.pointerId);
    const { x, y } = this.local(e);
    const node = pickNode(model, x, y, (n) => this.engine.appear(n, performance.now()));
    const kind = node
      ? 'node'
      : this.engine.is3D && !e.shiftKey && e.button === 0
        ? 'orbit'
        : 'pan';
    this.plugin?.onUserCamera();
    this.drag = {
      kind,
      node,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      travel: 0,
      shift: e.shiftKey,
      origin: node ? { x: node.x, y: node.y, z: node.z } : null,
    };
  }

  pointerMove(e: PointerEvent): void {
    const model = this.model;
    if (!model) return;
    if (this.staged) {
      this.stageMove(e);
      return;
    }
    const { x, y } = this.local(e);
    const drag = this.drag;
    if (!drag) {
      const node = pickNode(model, x, y, (n) => this.engine.appear(n, performance.now()));
      if (node !== this.hover) {
        this.hover = node;
        this.events.onHover(node);
      }
      const country = node ? null : this.countryAt(x, y);
      this.setHotCountry(country);
      this.el.overlay.style.cursor = node || country ? 'pointer' : 'grab';
      if (node || country) this.placeTooltip(x, y);
      return;
    }
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    drag.travel = Math.max(drag.travel, Math.hypot(x - drag.startX, y - drag.startY));
    if (drag.travel <= CLICK_SLOP) return;
    if (this.hover) {
      this.hover = null;
      this.events.onHover(null);
    }
    this.setHotCountry(null);
    this.setSpin(false);
    this.events.onAngle(null);
    this.tween = null;
    if (drag.kind === 'orbit') {
      this.cam = orbitBy(this.cam, dx, dy);
      this.el.overlay.style.cursor = 'grabbing';
    } else if (drag.kind === 'pan' || !this.engine.canPin) {
      // On the map a note stays where it is filed: dragging one moves the map instead.
      this.cam = panBy(this.cam, this.vp, dx, dy);
      this.userMoved = true;
      this.el.overlay.style.cursor = 'grabbing';
    } else if (drag.node && drag.origin) {
      // Drag in the plane facing the camera, at the node's own depth.
      const k = drag.node.sScale || pixelsPerUnit(this.cam, this.vp);
      const mx = (x - drag.startX) / k;
      const my = (y - drag.startY) / k;
      const { right, up } = basis(this.cam);
      this.engine.pin(drag.node, {
        x: drag.origin.x + right[0] * mx - up[0] * my,
        y: drag.origin.y + right[1] * mx - up[1] * my,
        z: drag.origin.z + right[2] * mx - up[2] * my,
      });
      this.userMoved = true;
    }
  }

  pointerUp(e: PointerEvent, cancelled = false): void {
    const drag = this.drag;
    this.drag = null;
    try {
      this.el.overlay.releasePointerCapture(e.pointerId);
    } catch {
      // the pointer was never captured; nothing to release
    }
    // Over a stage a drag only turns the camera: no click selects, clears or zooms to anything.
    if (this.staged) return;
    if (!drag) return;
    const click = drag.travel <= CLICK_SLOP && !cancelled;
    if (drag.kind === 'node' && drag.node) {
      this.engine.release(drag.node);
      if (click) this.clickNode(drag.node, drag.shift);
    } else if (click && !this.pathPick) {
      const { x, y } = this.local(e);
      const country = this.countryAt(x, y);
      this.clearSelection();
      if (country) this.zoomToCountry(country);
    }
    this.el.overlay.style.cursor = this.hover || this.hotCountry ? 'pointer' : 'grab';
  }

  pointerLeave(): void {
    if (this.staged || this.drag) return;
    this.setHotCountry(null);
    if (!this.hover) return;
    this.hover = null;
    this.events.onHover(null);
  }

  wheel(e: WheelEvent): void {
    e.preventDefault();
    const stage = this.staged;
    if (stage) {
      if (stage.locked) return;
      this.plugin?.onUserCamera();
      this.zoomStage(stage, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      return;
    }
    this.setSpin(false);
    this.plugin?.onUserCamera();
    const { x, y } = this.local(e);
    this.zoomAt(x, y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  doubleClick(e: MouseEvent): void {
    const model = this.model;
    if (!model || this.staged) return;
    const { x, y } = this.local(e);
    const node = pickNode(model, x, y, (n) => this.engine.appear(n, performance.now()));
    if (node) this.events.onOpen(node);
  }

  /** Arrows walk the selected note's links in the direction pressed. Returns whether it handled the key. */
  keyDown(e: KeyboardEvent): boolean {
    if (this.staged) {
      // Over a stage there is no selection to clear or walk: only the zoom keys.
      if (e.key === '+' || e.key === '=') this.zoom(1.25);
      else if (e.key === '-') this.zoom(0.8);
      else return false;
      return true;
    }
    if (e.key === 'Escape') {
      this.clearSelection();
      return true;
    }
    if (e.key === '+' || e.key === '=') {
      this.zoom(1.25);
      return true;
    }
    if (e.key === '-') {
      this.zoom(0.8);
      return true;
    }
    const selected = this.selected;
    if (!selected || !this.model) return false;
    if (e.key === 'Enter') {
      this.events.onOpen(selected);
      return true;
    }
    const dirs: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const dir = dirs[e.key];
    if (!dir) return false;
    const next = neighbourToward(this.model, selected, dir[0], dir[1]);
    if (next) this.select(next);
    return true;
  }

  minimapPoint(e: PointerEvent): void {
    const t = this.minimapTransform;
    if (!t || this.staged) return;
    const r = this.el.minimap.getBoundingClientRect();
    this.cam = {
      ...this.cam,
      tx: (e.clientX - r.left - t.ox) / t.scale,
      ty: -(e.clientY - r.top - t.oy) / t.scale,
    };
    this.userMoved = true;
    this.tween = null;
  }

  // -- Internals -------------------------------------------------------------------

  private clickNode(node: GraphNode, shift: boolean): void {
    this.setSpin(false);
    if (!(shift || this.pathPick)) {
      this.select(node);
      return;
    }
    if (!this.pathFrom || this.path) {
      this.selected = node;
      this.pathFrom = node;
      this.path = null;
      this.pathPick = true;
      this.edgesDirty = true;
      this.events.onSelection({ kind: 'note', node });
      this.events.onToast('Now Shift+click the note to trace a path to.');
      return;
    }
    if (node === this.pathFrom || !this.model) return;
    const path = findPath(this.model, this.pathFrom, node);
    this.pathPick = false;
    if (!path) {
      this.events.onToast('No path: those notes are on separate islands.');
      return;
    }
    this.path = path;
    this.pathT0 = performance.now();
    this.selected = null;
    this.edgesDirty = true;
    this.events.onSelection({ kind: 'path', path });
    const target = { ...this.cam, ...this.fitTarget(path.nodes, 1.4) };
    this.animateTo(this.withPreviewOffset(target));
    this.userMoved = true;
  }

  /** Territories: the project whose land is under the screen point (x, y). */
  private countryAt(x: number, y: number): string | null {
    if (!this.engine.isMap || this.landAlpha < 0.5) return null;
    const p = pixelsPerUnit(this.cam, this.vp);
    return this.engine.countryAt(
      this.cam.tx + (x - this.vp.width / 2) / p,
      this.cam.ty - (y - this.vp.height / 2) / p,
    );
  }

  private setHotCountry(id: string | null): void {
    if (id === this.hotCountry) return;
    this.hotCountry = id;
    const model = this.model;
    const t = this.engine.territory;
    if (!id || !model || !t) {
      this.countryRoutes = null;
      this.events.onHoverCountry(null);
      return;
    }
    this.countryRoutes = model.edges.filter(
      (e) => (e.source.project?.id === id) !== (e.target.project?.id === id) && e.kind !== 'topic',
    );
    this.focusT0 = performance.now();
    const group = model.projects.find((p) => p.id === id);
    const country = t.countries.find((c) => c.id === id);
    const folders = new Set((group?.nodes ?? []).map((n) => t.province.get(n)).filter(Boolean));
    this.events.onHoverCountry({
      id,
      label: country?.label ?? group?.label ?? '',
      vault: country?.vault ?? group?.vault ?? '',
      notes: group?.nodes.length ?? 0,
      folders: folders.size,
      routes: this.countryRoutes.length,
    });
  }

  private zoomToCountry(id: string): void {
    const nodes = this.model?.projects.find((p) => p.id === id)?.nodes;
    if (!nodes?.length) return;
    this.animateTo({ ...this.cam, ...this.fitTarget(nodes, 3.2) });
    this.userMoved = true;
  }

  private fitTarget(
    nodes?: GraphNode[],
    maxScale?: number,
  ): Pick<Camera, 'tx' | 'ty' | 'tz' | 'dist'> {
    if (this.engine.is3D && !nodes) return fitBrain(this.engine.brainScale, this.vp);
    const map = !nodes && !this.engine.growth ? this.engine.mapBounds() : null;
    if (map) return fitBounds(map, this.vp);
    const list = (nodes ?? this.model?.nodes ?? []).filter((n) => n.bornAt !== Infinity);
    const b = boundsOf(list);
    if (!b) return { tx: this.cam.tx, ty: this.cam.ty, tz: this.cam.tz, dist: this.cam.dist };
    return fitBounds(b, this.vp, { maxScale, depth: this.engine.is3D });
  }

  private withPreviewOffset(cam: Camera): Camera {
    if (this.vp.width <= 760) return cam;
    const shift = PREVIEW_OFFSET / pixelsPerUnit(cam, this.vp);
    return {
      ...cam,
      tx: cam.tx + Math.cos(cam.yaw) * shift,
      tz: cam.tz - Math.sin(cam.yaw) * shift,
    };
  }

  private flyTo(node: GraphNode): void {
    const dist = this.engine.is3D
      ? Math.min(this.cam.dist, this.engine.brainScale * 1.9)
      : Math.min(this.cam.dist, this.vp.height / 2 / (TAN_HALF_FOV * 1.35));
    // Where it is drawn: a search match may have sprung out of its place.
    this.animateTo(
      this.withPreviewOffset({
        ...this.cam,
        tx: node.x + node.ox,
        ty: node.y + node.oy,
        tz: (node.z || 0) + node.oz,
        dist,
      }),
    );
    this.userMoved = true;
  }

  private animateTo(to: Camera, duration = 700): void {
    this.tween = {
      from: { ...this.cam },
      to,
      t0: performance.now(),
      duration: this.reduceMotion ? 1 : duration,
    };
  }

  private zoomAt(x: number, y: number, factor: number): void {
    this.tween = null;
    this.userMoved = true;
    if (this.engine.is3D) {
      const s = this.engine.brainScale;
      this.cam = { ...this.cam, dist: clamp(this.cam.dist / factor, s * 0.25, s * 7) };
      return;
    }
    const limits: [number, number] = [
      this.vp.height / 2 / (TAN_HALF_FOV * 6),
      this.vp.height / 2 / (TAN_HALF_FOV * 0.04),
    ];
    this.cam = zoomFlatAt(this.cam, this.vp, x, y, factor, limits);
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.el.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private placeTooltip(x: number, y: number): void {
    this.el.tooltip.style.left = `${Math.min(x + 16, this.vp.width - 290)}px`;
    this.el.tooltip.style.top = `${Math.min(y + 16, this.vp.height - 90)}px`;
  }

  private resize(): void {
    const r = this.el.stage.getBoundingClientRect();
    this.vp = { width: Math.max(1, r.width), height: Math.max(1, r.height) };
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.overlay.width = Math.round(this.vp.width * this.dpr);
    this.el.overlay.height = Math.round(this.vp.height * this.dpr);
    // Parked, the graph's buffer stays 1×1: it takes the new size when the stage goes.
    if (!this.parked) this.scene?.resize(this.vp, this.dpr);
    this.staged?.resize(this.vp, this.dpr);
  }

  private cloud(): number {
    const n = this.model?.nodes.length ?? 0;
    // The map has its own way of zooming out: country names over the land.
    if (this.engine.isMap) return 0;
    if (this.engine.is3D)
      return (
        clamp((this.cam.dist / this.engine.brainScale - 2.1) / 0.9, 0, 1) * (n > 150 ? 1 : 0.5)
      );
    return clamp((0.62 - pixelsPerUnit(this.cam, this.vp)) / 0.3, 0, 1);
  }

  /**
   * Ease what differs between views, by time: the land fades in once the notes
   * have reached their places, the notes turn into cities, and the edges fade
   * out — on the map they are routes, drawn only for what the pointer is on.
   * Returns whether edge brightness has to be recomputed.
   */
  private easeViews(dt: number): boolean {
    const map = this.engine.isMap;
    const rate = (ms: number) => (this.reduceMotion ? 1 : 1 - Math.exp(-dt / ms));
    const k = rate(220);
    const ease = (value: number, target: number, step = k) =>
      Math.abs(target - value) < 0.004 ? target : value + (target - value) * step;
    // The land leaves faster than it comes: the notes start moving off it at once.
    const landTarget = map && !this.engine.moving ? 1 : 0;
    this.landAlpha = ease(this.landAlpha, landTarget, landTarget ? k : rate(80));
    this.mapBlend = ease(this.mapBlend, map ? 1 : 0);
    const edgeTarget = map ? (this.routesLayer ? 0.4 : 0) : 1;
    const before = this.edgeScale;
    this.edgeScale = ease(this.edgeScale, edgeTarget);
    if (this.engine.landVersion !== this.land?.version && this.engine.land && this.model) {
      this.land = {
        version: this.engine.landVersion,
        paths: landPaths(this.engine.land),
        landed: new Set(this.engine.land.sites.map((s) => s.project)),
      };
      this.scene?.setLand(this.engine.land, this.model);
    }
    return before !== this.edgeScale;
  }

  /**
   * Whether edge brightness needs recomputing this frame. An edge shows once
   * both ends have faded in, so while notes are appearing it is recomputed
   * every frame — and once more after the last one has finished. Stopping at
   * the end of the fade instead left every edge dark whenever no frame landed
   * inside it: a background tab, or a replay that ended in one frame.
   */
  private relightEdges(now: number, growing: boolean): boolean {
    const dirty = this.edgesDirty || growing || this.edgesLitAt <= this.engine.appearingUntil;
    if (dirty) this.edgesLitAt = now;
    return dirty;
  }

  /**
   * Advance the lift tweens, then turn each note's lift into a draw offset
   * for this camera: out of the brain as seen from where you look, so it
   * follows as you orbit. Returns whether the offsets changed this frame, so
   * positions need uploading: at rest, with the camera still, they do not.
   */
  private liftMatches(now: number, dt: number): boolean {
    for (const [n, t] of this.liftTweens) {
      const p = clamp((now - t.t0) / (t.to ? LIFT_MS : DROP_MS), 0, 1);
      n.lift = t.from + (t.to - t.from) * (t.to ? easeOutBack(p) : easeInOut(p));
      if (p >= 1) {
        n.lift = t.to;
        this.liftTweens.delete(n);
      }
    }
    const tweening = this.liftTweens.size > 0;
    const target = this.engine.is3D ? 1 : 0;
    const reachBefore = this.liftReach;
    this.liftReach =
      Math.abs(target - this.liftReach) < 0.004
        ? target
        : this.liftReach + (target - this.liftReach) * (1 - Math.exp(-dt / 220));
    const active = this.lifted.size > 0 || tweening;
    const c = this.cam;
    const camKey = `${c.tx},${c.ty},${c.tz},${c.yaw},${c.pitch},${c.dist},${this.engine.brainScale}`;
    const camMoved = camKey !== this.liftCam;
    this.liftCam = camKey;
    // One more frame after the last drop, to upload the notes back in place.
    const settling = this.hadLift && !active;
    this.hadLift = active;
    // Offsets depend on the lift, the reach and the camera: if none changed, neither did they.
    const reachMoving = reachBefore !== this.liftReach;
    if (!settling && !(active && (tweening || reachMoving || (camMoved && this.liftReach > 0))))
      return false;
    // Fewer matches go further: one note should leap out, fifty should not become a cloud.
    const reach =
      this.engine.brainScale *
      LIFT_REACH *
      clamp(1.15 - this.lifted.size / 80, 0.35, 1) *
      this.liftReach;
    const center: [number, number, number] = [0, -0.05 * this.engine.brainScale, 0];
    const axes = basis(this.cam);
    for (const n of this.model?.nodes ?? []) {
      if (!n.lift || !reach || !Number.isFinite(n.x)) {
        n.ox = n.oy = n.oz = 0;
        continue;
      }
      const d = outward([n.x, n.y, n.z || 0], center, axes);
      const k = reach * n.lift;
      n.ox = d[0] * k;
      n.oy = d[1] * k;
      n.oz = d[2] * k;
    }
    return true;
  }
  private hadLift = false;
  private liftCam = '';

  private finishGrowth(): void {
    this.growing = false;
    this.events.onGrowth(false);
    clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => {
      if (!this.engine.growth) this.el.timeChip.hidden = true;
    }, 1600);
  }

  // -- Stage mode ------------------------------------------------------------------
  //
  // While the plugin's `stage` is non-null the stage draws instead of the graph: its own canvas
  // between the graph's and the overlay, the graph's layout still settling unseen, the brain's
  // camera put aside and handed back when the stage goes. Nothing here runs without a stage.

  /** Enter or leave stage mode as the plugin's stage comes or goes. Once a frame. */
  private syncStage(): PluginStage | null {
    const next = (!this.disposed && this.plugin?.stage) || null;
    if (next !== this.staged) {
      this.leaveStage();
      if (next) this.enterStage(next);
    }
    return this.staged;
  }

  private enterStage(stage: PluginStage): void {
    // Saved now, not at attach: the brain's framing is final by the time a stage is ready.
    this.brain = {
      cam: { ...this.cam },
      tween: this.tween,
      userMoved: this.userMoved,
      resized: false,
    };
    this.staged = stage;
    this.tween = null;
    // A note held while the stage warmed would stay pinned, and a pin keeps the layout from
    // ever cooling: no `settled` frame for a governor, no onSettled.
    if (this.drag?.kind === 'node' && this.drag.node) this.engine.release(this.drag.node);
    this.drag = null;
    // Nothing of the brain's stays over the stage: no tooltip, no preview, no path being picked.
    if (this.hover) {
      this.hover = null;
      this.events.onHover(null);
    }
    this.previewed = null;
    this.clearSelection();
    this.hotCountry = null;
    this.countryRoutes = null;
    this.events.onHoverCountry(null);
    // A stage that holds its own camera overrides this at once.
    this.cam = { ...stage.overview(this.vp) };
    this.fade = this.reduceMotion ? 1 : 0;
    stage.canvas.style.opacity = this.fade < 1 ? '0' : '';
    this.el.overlay.before(stage.canvas);
    stage.resize(this.vp, this.dpr);
  }

  /**
   * Back to the graph: the canvas out, the buffer full size again and everything uploaded, the
   * brain's camera (and a tween it was in) restored. Leaving from outside a frame — a React
   * cleanup — may show one dark frame before the next one draws the brain: a cut, accepted.
   */
  private leaveStage(): void {
    const stage = this.staged;
    if (!stage) return;
    this.staged = null;
    stage.canvas.remove();
    stage.canvas.style.opacity = '';
    this.drag = null;
    if (this.parked) {
      this.parked = false;
      // Not on the way out: a full-size buffer for a renderer about to be freed is memory
      // for nothing.
      if (!this.disposed) this.scene?.resize(this.vp, this.dpr);
    }
    this.reupload = true;
    this.edgesDirty = true;
    const b = this.brain;
    this.brain = null;
    if (b) {
      // A tween restored with its old start finishes on the next frame: the brain lands
      // where it was going.
      this.cam = b.cam;
      this.tween = b.tween;
      this.userMoved = b.userMoved;
      // The frame eases to a new size only while the layout moves, and one that came to rest
      // unseen never would: it flies there from where it was left, at the angle a tween the
      // stage cut short was heading for.
      if (b.resized) this.animateTo({ ...(b.tween?.to ?? b.cam), ...this.fitTarget() });
    }
    this.el.overlay.style.cursor = 'grab';
  }

  /**
   * A frame in stage mode: the layout advances (it is what comes back), the camera is the
   * stage's, a tween's (Fit) or the plugin's follow, and only the stage and the plugin draw.
   * No projection, lift, view easing, focus, growth, graph render, overlay or minimap.
   */
  private stageFrame(now: number, dt: number, model: GraphModel, stage: PluginStage): void {
    const moved = this.engine.advance(now);
    const frame: PluginFrame = {
      now,
      dt,
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      model,
      reduceMotion: this.reduceMotion,
      settled: !moved && !this.engine.warming,
    };
    const held = stage.camera(frame);
    if (held) {
      this.cam = held;
      this.tween = null;
    } else if (this.tween) {
      const p = clamp((now - this.tween.t0) / this.tween.duration, 0, 1);
      this.cam = interpolate(this.tween.from, this.tween.to, p);
      if (p >= 1) this.tween = null;
    } else {
      const f = this.plugin?.follow() ?? null;
      if (f && !this.drag) {
        // Reduced motion is the page's, read once like every other motion here: a live OS
        // toggle reaches the plugin (its `still`, and the cuts its camera makes), not this ease.
        const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt / 450);
        this.cam = {
          ...this.cam,
          tx: this.cam.tx + (f.x - this.cam.tx) * k,
          ty: this.cam.ty + (f.y - this.cam.ty) * k,
          tz: this.cam.tz + (f.z - this.cam.tz) * k,
          dist: this.cam.dist + (f.dist - this.cam.dist) * k,
        };
      }
    }
    this.fadeStage(stage, dt);
    frame.cam = this.cam;
    stage.render(frame);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.overlay.width, this.el.overlay.height);
    this.plugin?.draw(this.ctx, frame);
    const cursor = this.drag ? 'grabbing' : stage.locked ? 'default' : 'grab';
    if (this.el.overlay.style.cursor !== cursor) this.el.overlay.style.cursor = cursor;
    // The layout is still saved when it comes to rest.
    const moving = this.engine.moving;
    if (this.wasMoving && !moving) this.events.onSettled();
    this.wasMoving = moving;
  }

  /**
   * Fade the stage in over the graph's last frame, which stays on screen under it (the graph
   * is not drawn in stage mode); once it covers it, park the graph's drawing buffer at 1×1.
   */
  private fadeStage(stage: PluginStage, dt: number): void {
    if (this.fade < 1) {
      this.fade = this.reduceMotion ? 1 : Math.min(1, this.fade + dt / STAGE_FADE_MS);
      stage.canvas.style.opacity = this.fade < 1 ? String(this.fade) : '';
    } else if (!this.parked) {
      // Two full-size WebGL buffers (and their multisampled copies) on a HiDPI screen is memory
      // the graph's would hold for nothing.
      this.parked = true;
      this.scene?.resize(PARKED, 1);
    }
  }

  private stageDown(e: PointerEvent, stage: PluginStage): void {
    if (stage.locked) return;
    this.el.overlay.setPointerCapture(e.pointerId);
    const { x, y } = this.local(e);
    this.plugin?.onUserCamera();
    this.tween = null;
    const kind = e.shiftKey || e.button !== 0 ? 'pan' : 'orbit';
    this.drag = {
      kind,
      node: null,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      travel: 0,
      shift: e.shiftKey,
      origin: null,
    };
  }

  /** A drag over a stage orbits or pans, past the same slop as the graph's; nothing is picked. */
  private stageMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const { x, y } = this.local(e);
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    drag.travel = Math.max(drag.travel, Math.hypot(x - drag.startX, y - drag.startY));
    if (drag.travel <= CLICK_SLOP) return;
    this.tween = null;
    this.cam = drag.kind === 'orbit' ? orbitBy(this.cam, dx, dy) : panBy(this.cam, this.vp, dx, dy);
  }

  /** Orbit zoom between the stage's limits: it is not a flat map to zoom under the pointer. */
  private zoomStage(stage: PluginStage, factor: number): void {
    this.tween = null;
    const r = stage.zoomRange(this.vp);
    this.cam = { ...this.cam, dist: clamp(this.cam.dist / factor, r.min, r.max) };
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const model = this.model;
    const dt = Math.min(64, now - (this.lastFrame || now));
    this.lastFrame = now;
    this.frameNo++;
    if (!model) return;
    const stage = this.syncStage();
    if (stage) {
      this.stageFrame(now, dt, model, stage);
      return;
    }

    const warming = this.engine.warming;
    const moved = this.engine.advance(now);
    if (warming && !this.engine.warming && !this.userMoved) {
      // The notes are shown only now; frame where they settled, as the first frame used to.
      this.cam = { ...this.cam, ...this.fitTarget() };
    } else if (this.tween) {
      const p = clamp((now - this.tween.t0) / this.tween.duration, 0, 1);
      this.cam = interpolate(this.tween.from, this.tween.to, p);
      if (p >= 1) this.tween = null;
    } else if (!this.userMoved && moved) {
      const t = this.fitTarget();
      this.cam = {
        ...this.cam,
        tx: this.cam.tx + (t.tx - this.cam.tx) * 0.08,
        ty: this.cam.ty + (t.ty - this.cam.ty) * 0.08,
        tz: this.cam.tz + (t.tz - this.cam.tz) * 0.08,
        dist: this.cam.dist + (t.dist - this.cam.dist) * 0.08,
      };
    }
    // A search pauses the spin: what it found should stay where you saw it.
    if (
      this.spin &&
      !this.tween &&
      !this.hover &&
      !this.selected &&
      !this.path &&
      !this.drag &&
      !this.matches
    ) {
      this.cam = { ...this.cam, yaw: this.cam.yaw + dt * SPIN_PER_MS };
    }

    const follow = this.plugin?.follow() ?? null;
    if (follow && !this.drag && !this.tween) {
      const k = 1 - Math.exp(-dt / 450);
      this.userMoved = true;
      this.cam = {
        ...this.cam,
        tx: this.cam.tx + (follow.x - this.cam.tx) * k,
        ty: this.cam.ty + (follow.y - this.cam.ty) * k,
        tz: this.cam.tz + (follow.z - this.cam.tz) * k,
        dist: this.cam.dist + (follow.dist - this.cam.dist) * k,
      };
    }

    const focus = this.hover ?? this.previewed ?? this.selected;
    if (focus !== this.focus) {
      this.focus = focus;
      this.focusT0 = now;
      this.hops = focus ? hopsFrom(model, focus) : null;
      this.edgesDirty = true;
    }

    const growth = this.engine.growthStatus();
    if (growth) {
      this.el.timeChip.hidden = false;
      const date = MONTH_YEAR.format(growth.at);
      this.el.timeChip.textContent = `${date} · ${growth.count} ${growth.count === 1 ? 'note' : 'notes'}`;
    } else if (this.growing) {
      this.finishGrowth();
    }

    const is3D = this.engine.is3D;
    const view = this.engine.view;
    const cloud = this.cloud();
    const visibleVaults = model.vaults.filter((v) => !v.hidden).length;
    const edgesFading = this.easeViews(dt);
    const lifting = this.liftMatches(now, dt);
    projectNodes(model, this.cam, this.vp, is3D, this.engine.brainScale, this.mapBlend);
    const appear = (n: GraphNode) => this.engine.appear(n, now);
    const pathNodes = this.path ? new Set(this.path.nodes) : null;
    this.scene?.render({
      now,
      dt,
      wallClock: Date.now(),
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      is3D,
      brainScale: this.engine.brainScale,
      cloud,
      view,
      landAlpha: this.landAlpha,
      mapBlend: this.mapBlend,
      hotCountry: this.hover ? (this.hover.project?.id ?? null) : this.hotCountry,
      edgeScale: this.edgeScale,
      hops: this.hops,
      pathNodes,
      pathEdges: this.path ? new Set(this.path.edges) : null,
      matched: this.matched,
      moved: moved || !!this.drag || lifting || this.reupload,
      edgesDirty: this.relightEdges(now, !!growth) || edgesFading,
      appear,
      flash: (n) => this.engine.flash(n, now),
      reduceMotion: this.reduceMotion,
    });
    this.edgesDirty = false;
    this.reupload = false;

    drawOverlay(this.ctx, {
      now,
      vp: this.vp,
      dpr: this.dpr,
      cam: this.cam,
      is3D,
      view,
      brainScale: this.engine.brainScale,
      cloud,
      model,
      landAlpha: this.landAlpha,
      land: this.land?.paths ?? null,
      landed: this.engine.growth ? (this.land?.landed ?? null) : null,
      territory: this.engine.territory,
      hotCountry: this.hotCountry,
      countryRoutes: this.countryRoutes,
      ring: this.engine.ring,
      hover: this.hover ?? this.previewed,
      selected: this.selected,
      pathFrom: this.pathFrom,
      path: this.path,
      pathT0: this.pathT0,
      focus: this.focus,
      focusT0: this.focusT0,
      hops: this.hops,
      matched: this.matched,
      matches: this.matches,
      searchT0: this.searchT0,
      vaultLabels: is3D && visibleVaults > 1,
      fallback: !this.webgl,
      appear,
      reduceMotion: this.reduceMotion,
      fonts: this.fonts,
    });
    this.plugin?.draw(this.ctx, {
      now,
      dt,
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      model,
      reduceMotion: this.reduceMotion,
      settled: !moved && !this.engine.warming && !growth,
    });

    if (!is3D && this.frameNo % 3 === 0 && !this.el.minimap.hidden) {
      const dpr = this.dpr;
      if (this.el.minimap.width !== 176 * dpr) {
        this.el.minimap.width = 176 * dpr;
        this.el.minimap.height = 116 * dpr;
      }
      this.minimapTransform = drawMinimap(
        this.minimapCtx,
        { width: 176, height: 116, dpr },
        model,
        this.cam,
        this.vp,
        appear,
      );
    }

    const moving = this.engine.moving;
    if (this.wasMoving && !moving && !growth) this.events.onSettled();
    this.wasMoving = moving;
  };
}
