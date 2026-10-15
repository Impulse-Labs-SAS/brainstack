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
  pickNearest,
  pickNode,
  projectNodes,
  type KeepClear,
  type LandPaths,
  type MinimapTransform,
} from './graph-overlay';
import type { CamOffset, ReturnEntry, ReturnStep } from './graph-return';
import { GraphScene } from './graph-scene';
import { LabelMemory, type Rect } from './labels/placer';
import { tooltipSlot, type TooltipSide } from './labels/tooltip';

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
  /**
   * The graph kept out of sight while true: a plugin whose stage is on its way would otherwise
   * show the brain for the second or two it takes to start. Read once a frame; the layout
   * still settles and the plugin still draws. Absent or false: the graph shows, as ever.
   */
  readonly veil?: boolean;
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

/** A note or a path: what is selected, and what Back remembers. */
type Picked = { kind: 'note'; node: GraphNode } | { kind: 'path'; path: GraphPath };

export type Selection = Picked & {
  /** What Back returns to, by name: a note's label, a path's two ends. Absent with none. */
  back?: string;
};

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
  /** How far it may travel and still be a click: further for a finger than for a mouse. */
  slop: number;
  /** A tap between two notes too close to tell apart: it zooms in rather than pick one. */
  ambiguous: boolean;
  /** The second press of a double click: it picked nothing, and its click does nothing. */
  repeat: boolean;
};

/** A plain click or tap: what it picked, where it was pressed, when it ended and with what. */
type Click = { node: GraphNode | null; x: number; y: number; at: number; type: string };

type Tween = { from: Camera; to: Camera; t0: number; duration: number };

/** A selection Back can return to: the camera it was seen from, and in which view. */
type TrailStep = { selection: Picked; cam: Camera; view: GraphView };

/** A horizontal strip of the stage, in CSS pixels from its top. */
type Band = { top: number; bottom: number };

/** The note the camera came back to from that note's page, and where it was relative to it. */
type Follow = { node: GraphNode; cam: CamOffset };

type Point = { x: number; y: number; z: number };

const CLICK_SLOP = 4;
/** A finger wobbles more than a mouse: a tap that moved this little is still a tap. */
const TAP_SLOP = 10;
/** On a touch screen a note answers this far from its centre however small it is drawn: 44px across. */
const TOUCH_RADIUS = 22;
/** A tap whose two nearest notes are within this many px of the same distance meant neither for sure. */
const AMBIGUOUS_PX = 8;
/** How much an ambiguous tap zooms in, so the two notes it fell between come apart. */
const AMBIGUOUS_ZOOM = 2;
/** Two clicks or taps this close in time are one double click. */
const DOUBLE_TAP_MS = 500;
/** How near the first click a mouse's second lands, in a double click; a finger's, TOUCH_RADIUS. */
const REPEAT_PX = 6;
/** How many selections Back remembers: past that, the oldest goes. */
const TRAIL_MAX = 50;
/** How quickly the camera catches up with a note it came back to as the layout carries it, ms. */
const FOLLOW_MS = 250;
const MONTH_YEAR = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });
/** How far left of centre a framed note goes, clear of the preview docked beside the graph. */
const PREVIEW_OFFSET = 160;
/**
 * Where the preview docks beside the graph; narrower, it is a sheet along the bottom. The
 * sheet's own breakpoint, Tailwind's md, which reads the window: wider than the stage by the rail.
 */
const PREVIEW_BESIDE = '(min-width: 768px)';
/** The sheet at its tallest, as a share of the stage, and how far it stands off the stage's bottom. */
const SHEET_MAX = 0.52;
const SHEET_INSET = 8;
/** Where the toolbar's first row ends: the top of the free band before the chrome is measured. */
const TOOLBAR_BOTTOM = 56;
/** The least band kept above the sheet when the chrome reaches down to it, a phone on its side. */
const BAND_MIN = 80;
/** The tooltip's size until it is measured: as wide as it may grow, three lines tall. */
const TOOLTIP_SIZE = { w: 280, h: 90 };
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

const samePick = (a: Picked, b: Picked) =>
  a.kind === 'note'
    ? b.kind === 'note' && a.node === b.node
    : b.kind === 'path' && a.path === b.path;

/** What the Back button names: a note by its label, a path by its two ends. */
function pickLabel(p: Picked): string {
  if (p.kind === 'note') return p.node.label;
  return `${p.path.nodes[0]!.label} → ${p.path.nodes.at(-1)!.label}`;
}

/**
 * `steps` without what left the model, without a second step to the same note in a row, and
 * without a last one to what is selected (`now`): a Back that would go nowhere.
 */
function tidyTrail(
  steps: readonly TrailStep[],
  present: ReadonlySet<GraphNode>,
  now: Picked | null,
): TrailStep[] {
  const kept: TrailStep[] = [];
  for (const step of steps) {
    const s = step.selection;
    if (!(s.kind === 'note' ? present.has(s.node) : s.path.nodes.every((n) => present.has(n))))
      continue;
    // The same note twice running, once what was between them left: the later camera stays.
    if (kept.length && samePick(kept.at(-1)!.selection, s)) kept.pop();
    kept.push(step);
  }
  if (now && kept.length && samePick(kept.at(-1)!.selection, now)) kept.pop();
  return kept;
}

/** The path through `nodes` in that order, or null where two of them are no longer linked. */
function pathThrough(model: GraphModel, nodes: GraphNode[]): GraphPath | null {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const links = (model.adjacency.get(nodes[i - 1]!) ?? []).filter((l) => l.node === nodes[i]);
    // What people wrote before what is only drawn, as `findPath` goes.
    const link =
      links.find((l) => l.edge.kind === 'link' || l.edge.kind === 'structure') ?? links[0];
    if (!link) return null;
    edges.push(link.edge);
  }
  return { nodes, edges, implicit: edges.some((e) => e.kind === 'affinity' || e.kind === 'topic') };
}

/** Where a note is drawn, a search's spring included: what a flight to it frames. */
const drawn = (n: GraphNode): Point => ({ x: n.x + n.ox, y: n.y + n.oy, z: (n.z || 0) + n.oz });
/** Where a note is laid out: what the camera follows, the spring of a search aside. */
const laidOut = (n: GraphNode): Point => ({ x: n.x, y: n.y, z: n.z || 0 });

/** `cam` relative to a note at `p`; null for a note with no place yet. */
function offsetFrom(cam: Camera, p: Point): CamOffset | null {
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return null;
  const { yaw, pitch, dist } = cam;
  return { dx: cam.tx - p.x, dy: cam.ty - p.y, dz: cam.tz - p.z, yaw, pitch, dist };
}

/** The camera at `o` from a note at `p`. */
function placeAt(o: CamOffset, p: Point): Camera {
  return {
    tx: p.x + o.dx,
    ty: p.y + o.dy,
    tz: p.z + o.dz,
    yaw: o.yaw,
    pitch: o.pitch,
    dist: o.dist,
  };
}

export class GraphController {
  readonly webgl: boolean;
  private readonly engine: GraphEngine;
  private readonly scene: GraphScene | null;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly minimapCtx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly fonts: { sans: string; mono: string };
  /** A note label's size: a point larger where a finger points, on a touch screen. */
  private readonly labelPx: number;
  private readonly labels = new LabelMemory();
  /** What floats over the graph, from the view (`setChrome`): no label goes under it. */
  private chrome: readonly Rect[] = [];
  private cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 800 };
  private vp: Viewport = { width: 800, height: 600 };
  private dpr = 1;
  private tween: Tween | null = null;
  private userMoved = false;
  private spin = false;

  private hover: GraphNode | null = null;
  /** Where the pointer last moved over the graph: the tooltip keeps clear of the cursor. */
  private pointerAt: { x: number; y: number } | null = null;
  /** Which side of what it names the tooltip took last frame; null when it was not shown. */
  private tooltipSide: TooltipSide | null = null;
  private selected: GraphNode | null = null;
  private pathFrom: GraphNode | null = null;
  private path: GraphPath | null = null;
  private pathT0 = 0;
  private pathPick = false;
  /** What was selected before, oldest first: where Back goes, and the camera it was seen from. */
  private trail: TrailStep[] = [];
  /** Back from a note (`restore`): the graph as it was left, held until the first layout shows. */
  private returning: ReturnEntry | null = null;
  /** Then the note the camera rides with, until the user takes the camera or picks another. */
  private following: Follow | null = null;
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
  /** The pointers down on the overlay, where they are now: a second one turns a drag into a pinch. */
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  /** Two fingers down: how far apart and where between them at the last move. */
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  /** The last press was a finger: a double tap then opens what a finger could tap. */
  private lastTouch = false;
  /**
   * The last plain click or tap, and the note it picked: none on empty space, or when it zoomed
   * in between two notes. A note it picks flies to the side, so a press soon after and close by
   * is the rest of a double click, not a pick of whatever has come under the pointer since.
   */
  private lastClick: Click | null = null;
  /** The first click of the pair a double click would complete: what the double click opens. */
  private pairStart: Click | null = null;
  private raf = 0;
  private lastFrame = 0;
  private frameNo = 0;
  private minimapTransform: MinimapTransform | null = null;
  private wasMoving = false;
  private growing = false;
  private chipTimer = 0;
  private plugin: GraphPlugin | null = null;
  /** A plugin is on its way (`awaitPlugin`): the graph stays out of sight until it comes. */
  private awaiting = false;
  /** The graph's canvas hidden, as the last frame left it. */
  private hidden = false;

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
    this.labelPx =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
        ? 13
        : 12;
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

  /**
   * A plugin is on its way, or no longer: the page knows it opens on a view that brings one
   * before the plugin's code has even arrived, and the graph should not show meanwhile. Once a
   * plugin is attached, its own `veil` decides.
   */
  awaitPlugin(on: boolean): void {
    this.awaiting = on;
    // At once, not at the next frame with a model: nothing may show before that frame comes.
    this.syncVeil();
  }

  /** The graph's canvas hidden or shown as `veiled` says; true while it is hidden. */
  private syncVeil(): boolean {
    const veiled = this.veiled;
    if (veiled !== this.hidden) {
      this.hidden = veiled;
      this.el.gl.style.visibility = veiled ? 'hidden' : '';
      if (!veiled) {
        this.reupload = true;
        this.edgesDirty = true;
      }
    }
    return veiled;
  }

  /** The graph kept out of sight: a plugin on its way, or an attached one starting. */
  private get veiled(): boolean {
    return this.plugin ? this.plugin.veil === true : this.awaiting;
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
    this.pruneTrail(present);
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
    this.stopFollowing();
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

  /** What floats over the graph now, in CSS pixels from the stage's corner: labels keep clear of it. */
  setChrome(rects: readonly Rect[]): void {
    this.chrome = rects;
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
    this.stopFollowing();
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
    this.stopFollowing();
    this.leave({ kind: 'note', node });
    this.selected = node;
    this.path = null;
    this.pathFrom = null;
    this.pathPick = false;
    this.edgesDirty = true;
    this.announce({ kind: 'note', node });
    this.setSpin(false);
    this.flyTo(node);
  }

  clearSelection(): void {
    this.stopFollowing();
    this.selected = null;
    this.path = null;
    this.pathFrom = null;
    this.pathPick = false;
    this.lastClick = null;
    this.pairStart = null;
    // Closed, the walk is over: Back starts again from the next selection.
    this.trail = [];
    this.edgesDirty = true;
    this.events.onSelection(null);
  }

  /**
   * Back to what was selected before, seen from where it was; framed afresh when that was in
   * another view, whose camera fits another layout. False with nothing to go back to, or over a
   * stage.
   */
  back(): boolean {
    if (this.staged) return false;
    const step = this.trail.pop();
    if (!step) return false;
    this.stopFollowing();
    const s = step.selection;
    this.selected = s.kind === 'note' ? s.node : null;
    this.path = s.kind === 'path' ? s.path : null;
    // A path keeps the note it was traced from, as it did when it was found.
    this.pathFrom = s.kind === 'path' ? s.path.nodes[0]! : null;
    this.pathPick = false;
    this.pathT0 = performance.now();
    this.edgesDirty = true;
    this.announce(s);
    this.setSpin(false);
    if (step.view !== this.engine.view) {
      if (s.kind === 'note') this.flyTo(s.node);
      else this.framePath(s.path);
    } else {
      // Seen from another angle than now: the preset the view shows as chosen no longer holds.
      const going = this.tween?.to ?? this.cam;
      if (step.cam.yaw !== going.yaw || step.cam.pitch !== going.pitch) this.events.onAngle(null);
      this.animateTo({ ...step.cam });
    }
    this.userMoved = true;
    return true;
  }

  /**
   * The graph as it is, for coming back to it from `node`, about to be opened: the camera relative
   * to the note, where it is drawn, and the way back. A note other than the one selected (a double
   * click that picked nothing first) comes back framed as a click on it would frame it, with what
   * is selected now on the way back, as that click would leave it. Null over a stage, or for a
   * note the graph does not hold.
   */
  returnState(node: GraphNode): ReturnEntry | null {
    if (this.staged || !this.model?.nodes.includes(node)) return null;
    const step = node === this.selected ? null : this.stepLeaving({ kind: 'note', node });
    const cam = offsetFrom(
      node === this.selected ? (this.tween?.to ?? this.cam) : this.noteTarget(node),
      drawn(node),
    );
    if (!cam) return null;
    const trail: ReturnStep[] = [];
    for (const t of step ? [...this.trail, step] : this.trail) {
      const s = t.selection;
      const at = offsetFrom(t.cam, drawn(s.kind === 'note' ? s.node : s.path.nodes[0]!));
      if (!at) continue;
      if (s.kind === 'note') trail.push({ node: s.node.id, cam: at, view: t.view });
      else trail.push({ path: s.path.nodes.map((n) => n.id), cam: at, view: t.view });
    }
    return { view: this.engine.view, node: node.id, cam, trail };
  }

  /**
   * Back from a note's page to the graph as `returnState` left it: the note selected, the camera
   * where it was relative to the note, the way back as it was, less whatever the graph no longer
   * holds (without the note itself, nothing comes back). Applied once the first layout shows — at
   * once where there is none to wait for, as in Territories — after which the camera rides with
   * the note while the layout cools, or a refetch reheats it, until the user takes the camera or
   * the selection changes. Ignored over a stage, or for another view than this one.
   */
  restore(entry: ReturnEntry): void {
    if (!this.model || this.staged || entry.view !== this.engine.view) return;
    this.returning = entry;
    if (!this.engine.warming) this.applyReturn();
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
    this.stopFollowing();
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
    this.stopFollowing();
    this.animateTo({ ...this.cam, ...this.fitTarget() });
    this.userMoved = false;
  }

  setAngle(angle: AnglePreset): void {
    if (this.staged) return;
    this.stopFollowing();
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
    this.stopFollowing();
    const { x, y } = this.local(e);
    // A primary pointer is the first of its kind down. Any of its kind still recorded is a ghost
    // whose lifting never reached the page (an app switch, a system gesture): left, it would
    // turn the next touch into a pinch with a finger that is not there.
    if (e.isPrimary) this.forgetPointers(e.pointerType);
    this.pointers.set(e.pointerId, { x, y, type: e.pointerType });
    // A second finger: the drag the first one began becomes a pinch. A third does nothing.
    if (this.pointers.size === 2) {
      this.startPinch(e);
      return;
    }
    if (this.pointers.size > 2) return;
    if (this.staged) {
      this.stageDown(e, this.staged);
      return;
    }
    try {
      this.el.overlay.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser no longer tracks cannot be captured; the drag works without it
    }
    const touch = e.pointerType === 'touch';
    this.lastTouch = touch;
    // The second press of a double click comes down where the first click's note was, and that
    // note is flying off: picking again would select another, clear it, or zoom to a country.
    const last = e.shiftKey ? null : this.clickNear(x, y);
    const repeat = !!last && last.type === e.pointerType;
    const appear = (n: GraphNode) => this.engine.appear(n, performance.now());
    // A finger gets a target a finger can hit, and the benefit of the doubt between two notes
    // only in the flat views: in the brain, notes that look close may lie far apart in depth.
    const hit = repeat
      ? { node: null, dist: Infinity, next: Infinity }
      : pickNearest(model, x, y, appear, touch ? TOUCH_RADIUS : 0);
    const node = hit.node;
    // A finger dragged across notes means to move the view: on a touch screen notes stay put.
    const kind =
      node && !touch ? 'node' : this.engine.is3D && !e.shiftKey && e.button === 0 ? 'orbit' : 'pan';
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
      slop: touch ? TAP_SLOP : CLICK_SLOP,
      ambiguous: touch && !!node && !this.engine.is3D && hit.next - hit.dist < AMBIGUOUS_PX,
      repeat,
    };
  }

  pointerMove(e: PointerEvent): void {
    const model = this.model;
    if (!model) return;
    const { x, y } = this.local(e);
    const down = this.pointers.get(e.pointerId);
    if (down) {
      down.x = x;
      down.y = y;
    }
    if (this.pinch) {
      if (down) this.pinchMove();
      return;
    }
    if (this.staged) {
      this.stageMove(e);
      return;
    }
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
      // Placed by the next frame, beside the label it draws: not here, under the pointer.
      this.pointerAt = { x, y };
      return;
    }
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    drag.travel = Math.max(drag.travel, Math.hypot(x - drag.startX, y - drag.startY));
    if (drag.travel <= drag.slop) return;
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
    const known = this.pointers.delete(e.pointerId);
    try {
      this.el.overlay.releasePointerCapture(e.pointerId);
    } catch {
      // the pointer was never captured; nothing to release
    }
    if (this.pinch) {
      // Of three fingers one lifted: the pinch goes on between the two left, measured afresh.
      if (this.pointers.size >= 2) this.pinch = this.pinchSpan();
      else this.endPinch();
      return;
    }
    // A pointer that came down before the graph had notes began nothing here to end.
    if (!known) return;
    const drag = this.drag;
    this.drag = null;
    // Over a stage a drag only turns the camera: no click selects, clears or zooms to anything.
    if (this.staged) return;
    if (!drag) return;
    const click = drag.travel <= drag.slop && !cancelled;
    if (drag.kind === 'node' && drag.node) this.engine.release(drag.node);
    // Read before clickNode, which starts and ends a path pick: only a plain click begins a
    // double click.
    const plain = !drag.shift && !this.pathPick;
    const here = { x: drag.startX, y: drag.startY, at: performance.now(), type: e.pointerType };
    // The click before this one: if the browser makes a double click of the two, it began it.
    const before = this.lastClick;
    if (click && drag.repeat) {
      // The rest of a double click: the first click's record stays, for the double click to open.
      this.pairStart = before;
    } else if (click && drag.ambiguous && this.zoomBetween(drag.startX, drag.startY)) {
      // Zoomed in between two notes: the next tap can tell them apart, and the double tap this
      // one began opens nothing.
      this.lastClick = { node: null, ...here };
      this.pairStart = before;
    } else if (click && drag.node) {
      this.clickNode(drag.node, drag.shift);
      this.lastClick = plain ? { node: drag.node, ...here } : null;
      this.pairStart = plain ? before : null;
    } else if (click && !drag.node && !this.pathPick) {
      const { x, y } = this.local(e);
      const country = this.countryAt(x, y);
      this.clearSelection();
      if (country) this.zoomToCountry(country);
      this.lastClick = plain ? { node: null, ...here } : null;
      this.pairStart = plain ? before : null;
    } else {
      this.lastClick = null;
      this.pairStart = null;
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
    this.stopFollowing();
    this.plugin?.onUserCamera();
    const { x, y } = this.local(e);
    this.zoomAt(x, y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  doubleClick(e: MouseEvent): void {
    const model = this.model;
    if (!model || this.staged) return;
    const { x, y } = this.local(e);
    // What its first click picked, before that note flew off from under the pointer; nothing
    // when it fell on empty space or zoomed in between two notes. Not timed again: the event
    // is the browser's word that the two clicks were one double click, by the system's own
    // speed, however long the second press was held. Without a second click on record (it was
    // dragged, or never reached the canvas), the last one if it was just now and here.
    const first = this.pairStart ?? this.clickNear(x, y);
    this.pairStart = null;
    this.lastClick = null;
    if (first && this.near(first, x, y)) {
      if (first.node) this.events.onOpen(first.node);
      return;
    }
    const appear = (n: GraphNode) => this.engine.appear(n, performance.now());
    // A double tap reaches as far as a tap does.
    const node = pickNearest(model, x, y, appear, this.lastTouch ? TOUCH_RADIUS : 0).node;
    if (node) this.events.onOpen(node);
  }

  /**
   * Arrows walk the selected note's links in the direction pressed, Backspace goes back along
   * what was selected, Escape steps out a level at a time. Returns whether it handled the key.
   */
  keyDown(e: KeyboardEvent): boolean {
    if (this.staged) {
      // Over a stage there is no selection to clear or walk: only the zoom keys.
      if (e.key === '+' || e.key === '=') this.zoom(1.25);
      else if (e.key === '-') this.zoom(0.8);
      else return false;
      return true;
    }
    if (e.key === 'Escape') return this.escape();
    if (e.key === 'Backspace') return this.back();
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
    this.stopFollowing();
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

  /**
   * Escape, one level at a time: a path's other end being picked, then what is selected, then
   * the camera the user moved, back over the whole graph (the whole map, in Territories). Past
   * that the key is the page's: false.
   */
  private escape(): boolean {
    if (this.pathPick) {
      // The pick ends and the note it began from stays: the next click selects, not traces.
      this.pathPick = false;
      this.pathFrom = this.path?.nodes[0] ?? null;
      return true;
    }
    if (this.selected || this.path) {
      this.clearSelection();
      return true;
    }
    if (!this.userMoved) return false;
    this.fit();
    return true;
  }

  /** What is selected now, as the trail keeps it. */
  private get picked(): Picked | null {
    if (this.path) return { kind: 'path', path: this.path };
    return this.selected ? { kind: 'note', node: this.selected } : null;
  }

  /**
   * `next` takes the place of what is selected, which goes on the trail with the camera it was
   * seen from: where its flight was going, if it had not landed. Selecting it again keeps no step.
   */
  private leave(next: Picked): void {
    const step = this.stepLeaving(next);
    if (!step) return;
    this.trail.push(step);
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  /** The step `leave(next)` puts on the trail: none with nothing selected, or `next` itself. */
  private stepLeaving(next: Picked): TrailStep | null {
    const now = this.picked;
    if (!now || samePick(now, next)) return null;
    return { selection: now, cam: { ...(this.tween?.to ?? this.cam) }, view: this.engine.view };
  }

  /** The selection to the view, with what Back would return to while there is anything. */
  private announce(s: Picked): void {
    const last = this.trail.at(-1);
    this.events.onSelection(last ? { ...s, back: pickLabel(last.selection) } : s);
  }

  /**
   * Notes left the model: every step they were in goes, and so does a second step to the same
   * note in a row, or one to what is selected — a Back that would go nowhere. When that changes
   * what Back names, the view hears it.
   */
  private pruneTrail(present: ReadonlySet<GraphNode>): void {
    if (!this.trail.length) return;
    const top = this.trail.at(-1);
    const now = this.picked;
    this.trail = tidyTrail(this.trail, present, now);
    if (now && this.trail.at(-1) !== top) this.announce(now);
  }

  /**
   * `restore`, now that the notes show: the note and the way back found in this model by id, and
   * the camera cut to where it was left rather than flown there from the whole graph. From here
   * it follows the note (`followNote`).
   */
  private applyReturn(): void {
    const entry = this.returning;
    const model = this.model;
    this.returning = null;
    if (!entry || !model) return;
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const node = byId.get(entry.node);
    if (!node) return;
    const steps: TrailStep[] = [];
    for (const step of entry.trail) {
      const nodes = ('node' in step ? [step.node] : step.path).map((id) => byId.get(id));
      if (!nodes.every((n): n is GraphNode => n !== undefined)) continue;
      let selection: Picked = { kind: 'note', node: nodes[0]! };
      if ('path' in step) {
        const path = pathThrough(model, nodes);
        if (!path) continue;
        selection = { kind: 'path', path };
      }
      steps.push({ selection, cam: placeAt(step.cam, laidOut(nodes[0]!)), view: step.view });
    }
    const picked: Picked = { kind: 'note', node };
    this.selected = node;
    this.path = null;
    this.pathFrom = null;
    this.pathPick = false;
    this.trail = tidyTrail(steps, new Set(model.nodes), picked);
    this.edgesDirty = true;
    this.announce(picked);
    this.setSpin(false);
    this.tween = null;
    this.cam = placeAt(entry.cam, laidOut(node));
    this.userMoved = true;
    this.following = { node, cam: entry.cam };
  }

  /**
   * The camera eased after the note it came back to, at the offset it was left at: as the layout
   * cools, or a refetch reheats it, the note stays where it was on the screen. Taken over the
   * ease to the whole graph that a reheat starts.
   */
  private followNote(f: Follow, dt: number): void {
    const to = placeAt(f.cam, laidOut(f.node));
    const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt / FOLLOW_MS);
    this.cam = {
      ...this.cam,
      tx: this.cam.tx + (to.tx - this.cam.tx) * k,
      ty: this.cam.ty + (to.ty - this.cam.ty) * k,
      tz: this.cam.tz + (to.tz - this.cam.tz) * k,
    };
  }

  /**
   * The user took the camera, or the selection changed: a way back not yet applied goes, and the
   * camera stops following the note it came back to. So does a stage coming up, which clears
   * the selection, and the note leaving the model, which does too.
   */
  private stopFollowing(): void {
    this.returning = null;
    this.following = null;
  }

  /** The last plain click, when (x, y) is near enough to it in time and place to be its double. */
  private clickNear(x: number, y: number): Click | null {
    const last = this.lastClick;
    if (!last || performance.now() - last.at >= DOUBLE_TAP_MS) return null;
    return this.near(last, x, y) ? last : null;
  }

  /** Whether (x, y) lands where `click` did, as near as a second press of its double would. */
  private near(click: Click, x: number, y: number): boolean {
    const reach = click.type === 'touch' ? TOUCH_RADIUS : REPEAT_PX;
    return Math.hypot(x - click.x, y - click.y) <= reach;
  }

  private clickNode(node: GraphNode, shift: boolean): void {
    this.setSpin(false);
    if (!(shift || this.pathPick)) {
      this.select(node);
      return;
    }
    if (!this.pathFrom || this.path) {
      this.leave({ kind: 'note', node });
      this.selected = node;
      this.pathFrom = node;
      this.path = null;
      this.pathPick = true;
      this.edgesDirty = true;
      this.announce({ kind: 'note', node });
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
    this.leave({ kind: 'path', path });
    this.path = path;
    this.pathT0 = performance.now();
    this.selected = null;
    this.edgesDirty = true;
    this.announce({ kind: 'path', path });
    this.framePath(path);
    this.userMoved = true;
  }

  /** The whole of a path in view, clear of the preview: beside it, or between it and the chrome. */
  private framePath(path: GraphPath): void {
    const band = this.sheetBand();
    const target = {
      ...this.cam,
      ...this.fitTarget(path.nodes, 1.4, band ? band.bottom - band.top : undefined),
    };
    this.animateTo(this.withPreviewOffset(target, band));
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

  /** `frameHeight`: `nodes` fitted into a band that tall rather than into the whole stage. */
  private fitTarget(
    nodes?: GraphNode[],
    maxScale?: number,
    frameHeight?: number,
  ): Pick<Camera, 'tx' | 'ty' | 'tz' | 'dist'> {
    if (this.engine.is3D && !nodes) return fitBrain(this.engine.brainScale, this.vp);
    const map = !nodes && !this.engine.growth ? this.engine.mapBounds() : null;
    if (map) return fitBounds(map, this.vp);
    const list = (nodes ?? this.model?.nodes ?? []).filter((n) => n.bornAt !== Infinity);
    const b = boundsOf(list);
    if (!b) return { tx: this.cam.tx, ty: this.cam.ty, tz: this.cam.tz, dist: this.cam.dist };
    return fitBounds(b, this.vp, { maxScale, depth: this.engine.is3D, frameHeight });
  }

  /**
   * Where the preview is a sheet along the bottom, the strip of graph left free above it: from
   * the lowest chrome that ends above the middle (the toolbar's rows, the buttons beside them)
   * down to the sheet at its tallest. The sheet is not on screen yet when the first flight is
   * aimed, so where it can reach is all there is to go by. Null where the preview docks beside
   * the graph. Asked when a flight is aimed, not once: a phone turns.
   */
  private sheetBand(): Band | null {
    // No media queries to ask (Node): the stage's own width stands in for the window's.
    const beside =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(PREVIEW_BESIDE).matches
        : this.vp.width > 760;
    if (beside) return null;
    const h = this.vp.height;
    let top = -Infinity;
    for (const r of this.chrome) if (r.y + r.h < h / 2) top = Math.max(top, r.y + r.h);
    if (top === -Infinity) top = TOOLBAR_BOTTOM;
    const bottom = h - h * SHEET_MAX - SHEET_INSET;
    return { top: Math.min(top, bottom - BAND_MIN), bottom };
  }

  /**
   * `cam` moved so what it centres lands clear of the preview: left of centre beside it, or in
   * the middle of `band`, above the sheet. Up the screen is the camera's up, so in the brain it
   * lands exactly at the target's depth.
   */
  private withPreviewOffset(cam: Camera, band: Band | null): Camera {
    if (band) {
      const s = (this.vp.height / 2 - (band.top + band.bottom) / 2) / pixelsPerUnit(cam, this.vp);
      const { up } = basis(cam);
      return { ...cam, tx: cam.tx - up[0] * s, ty: cam.ty - up[1] * s, tz: cam.tz - up[2] * s };
    }
    const shift = PREVIEW_OFFSET / pixelsPerUnit(cam, this.vp);
    return {
      ...cam,
      tx: cam.tx + Math.cos(cam.yaw) * shift,
      tz: cam.tz - Math.sin(cam.yaw) * shift,
    };
  }

  private flyTo(node: GraphNode): void {
    this.animateTo(this.noteTarget(node));
    this.userMoved = true;
  }

  /** Where a flight to `node` goes from here: close enough to read it, clear of the preview. */
  private noteTarget(node: GraphNode): Camera {
    const dist = this.engine.is3D
      ? Math.min(this.cam.dist, this.engine.brainScale * 1.9)
      : Math.min(this.cam.dist, this.vp.height / 2 / (TAN_HALF_FOV * 1.35));
    // Where it is drawn: a search match may have sprung out of its place.
    const { x, y, z } = drawn(node);
    return this.withPreviewOffset({ ...this.cam, tx: x, ty: y, tz: z, dist }, this.sheetBand());
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

  /**
   * The tooltip beside the note or country pointed at, from what the overlay just drew: placed
   * every frame, so it rides along with a flight, clear of the note's label, the selection's and
   * the chrome. With no room it is hidden rather than put over them; the label still names the
   * note.
   */
  private placeTooltip(drawn: KeepClear): void {
    const pointer = this.pointerAt;
    if (!(this.hover || this.hotCountry) || !pointer) {
      this.tooltipSide = null;
      return;
    }
    const tip = this.el.tooltip;
    const slot = tooltipSlot({
      // As shown; 0 while React has yet to show it, and in the tests' stand-in, with no layout.
      size: { w: tip.offsetWidth || TOOLTIP_SIZE.w, h: tip.offsetHeight || TOOLTIP_SIZE.h },
      anchor: this.hover ? drawn.anchor : null,
      pointer,
      keep: drawn.keep,
      chrome: this.chrome,
      vp: this.vp,
      previous: this.tooltipSide,
    });
    this.tooltipSide = slot?.side ?? null;
    if (slot) {
      this.tooltipStyle('left', `${slot.rect.x}px`);
      this.tooltipStyle('top', `${slot.rect.y}px`);
    }
    this.tooltipStyle('visibility', slot ? '' : 'hidden');
  }

  /** Only what changed: at rest a frame writes nothing, rather than restyle the tooltip. */
  private tooltipStyle(key: 'left' | 'top' | 'visibility', value: string): void {
    const style = this.el.tooltip.style;
    if (style[key] !== value) style[key] = value;
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
      slop: e.pointerType === 'touch' ? TAP_SLOP : CLICK_SLOP,
      ambiguous: false,
      repeat: false,
    };
  }

  /** A drag over a stage orbits or pans, past the same slop as the graph's; nothing is picked. */
  private stageMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || this.staged?.locked) return;
    const { x, y } = this.local(e);
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    drag.travel = Math.max(drag.travel, Math.hypot(x - drag.startX, y - drag.startY));
    if (drag.travel <= drag.slop) return;
    this.tween = null;
    this.cam = drag.kind === 'orbit' ? orbitBy(this.cam, dx, dy) : panBy(this.cam, this.vp, dx, dy);
  }

  /**
   * A second finger came down. Whatever the first had begun is over: a note it held lets go,
   * and nothing either finger does from here is a click. Over a locked stage the pinch holds
   * the camera still, as the wheel does there.
   */
  private startPinch(e: PointerEvent): void {
    try {
      this.el.overlay.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser no longer tracks cannot be captured; the pinch works without it
    }
    if (this.drag?.kind === 'node' && this.drag.node) this.engine.release(this.drag.node);
    this.drag = null;
    this.lastClick = null;
    this.pairStart = null;
    if (this.hover) {
      this.hover = null;
      this.events.onHover(null);
    }
    this.setHotCountry(null);
    this.pinch = this.pinchSpan();
    if (this.staged?.locked) return;
    this.setSpin(false);
    this.events.onAngle(null);
    this.tween = null;
    this.plugin?.onUserCamera();
  }

  /** How far apart the first two pointers down are, and the point between them. Called with two or more down. */
  private pinchSpan(): { dist: number; cx: number; cy: number } {
    const down = [...this.pointers.values()];
    const a = down[0]!;
    const b = down[1]!;
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  /**
   * The fingers moved: zoom by how much they spread, about the point that was between them,
   * then carry that point to where it is between them now.
   */
  private pinchMove(): void {
    const pinch = this.pinch;
    if (!pinch || this.pointers.size < 2) return;
    const now = this.pinchSpan();
    this.pinch = now;
    const stage = this.staged;
    if (stage?.locked) return;
    if (stage) this.zoomStage(stage, now.dist / pinch.dist);
    else this.zoomAt(pinch.cx, pinch.cy, now.dist / pinch.dist);
    this.cam = panBy(this.cam, this.vp, now.cx - pinch.cx, now.cy - pinch.cy);
    this.userMoved = true;
  }

  /**
   * One of the two fingers lifted. The other, still down, moves the view from where it is —
   * orbiting the brain and the stage, panning the flat views — and its lifting is no tap. Over
   * a stage that holds its camera it moves nothing, as no drag would there.
   */
  private endPinch(): void {
    this.pinch = null;
    const rest = [...this.pointers.values()][0];
    if (!rest || this.staged?.locked) return;
    this.drag = {
      kind: this.engine.is3D || this.staged ? 'orbit' : 'pan',
      node: null,
      startX: rest.x,
      startY: rest.y,
      lastX: rest.x,
      lastY: rest.y,
      travel: Infinity,
      shift: false,
      origin: null,
      slop: TAP_SLOP,
      ambiguous: false,
      repeat: false,
    };
  }

  /** Forget every pointer of `type` still recorded, and whatever drag or pinch they made. */
  private forgetPointers(type: string): void {
    let forgot = false;
    for (const [id, p] of this.pointers) {
      if (p.type !== type) continue;
      this.pointers.delete(id);
      forgot = true;
    }
    if (!forgot) return;
    this.pinch = null;
    if (this.drag?.kind === 'node' && this.drag.node) this.engine.release(this.drag.node);
    this.drag = null;
  }

  /**
   * An ambiguous tap zooms in about where it fell, so the notes it fell between come apart.
   * False when the zoom is already as far in as it goes: then the tap picks the nearer note.
   */
  private zoomBetween(x: number, y: number): boolean {
    const before = this.cam.dist;
    this.zoomAt(x, y, AMBIGUOUS_ZOOM);
    return this.cam.dist !== before;
  }

  /** Orbit zoom between the stage's limits: it is not a flat map to zoom under the pointer. */
  private zoomStage(stage: PluginStage, factor: number): void {
    this.tween = null;
    const r = stage.zoomRange(this.vp);
    this.cam = { ...this.cam, dist: clamp(this.cam.dist / factor, r.min, r.max) };
  }

  /**
   * A frame with the graph out of sight, or false to draw it. Its canvas is hidden rather than
   * cleared (a WebGL canvas keeps showing its last frame until it draws again) and the overlay
   * holds only what the plugin draws; the layout settles meanwhile. Coming back, everything
   * is uploaded again, as after a stage.
   */
  private veiledFrame(now: number, dt: number, model: GraphModel, moved: boolean): boolean {
    if (!this.syncVeil()) return false;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.overlay.width, this.el.overlay.height);
    this.plugin?.draw(this.ctx, {
      now,
      dt,
      cam: this.cam,
      vp: this.vp,
      dpr: this.dpr,
      model,
      reduceMotion: this.reduceMotion,
      settled: !moved && !this.engine.warming,
    });
    const moving = this.engine.moving;
    if (this.wasMoving && !moving) this.events.onSettled();
    this.wasMoving = moving;
    return true;
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
    // Back from a note: once the notes show, the graph comes up as it was left, not framed whole.
    if (this.returning && !this.engine.warming) this.applyReturn();
    if (warming && !this.engine.warming && !this.userMoved) {
      // The notes are shown only now; frame where they settled, as the first frame used to.
      this.cam = { ...this.cam, ...this.fitTarget() };
    } else if (this.tween) {
      const p = clamp((now - this.tween.t0) / this.tween.duration, 0, 1);
      this.cam = interpolate(this.tween.from, this.tween.to, p);
      if (p >= 1) this.tween = null;
    } else if (this.following && !this.drag) {
      this.followNote(this.following, dt);
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

    if (this.veiledFrame(now, dt, model, moved)) return;

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

    const drawn = drawOverlay(this.ctx, {
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
      chrome: this.chrome,
      labels: this.labels,
      labelPx: this.labelPx,
    });
    this.placeTooltip(drawn);
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
