// The Sentinel view's replay, apart from anything that draws it: where the walk
// is, which threads it has lit, which notes it has found, what the panel says
// — and what each of the Sentinel's grip slots holds. Pure: no document, no
// three, so it runs the same in a test as in the view.
//
// The 2D spider the Sentinel replaced kept all of this beside its legs, whose
// feet lit the threads they landed on, so what a crawl lit depended on the
// frame rate and on the spider being drawn at all. Here grips are planned by
// distance along each leg (sentinel/grips.ts), all of them as the leg begins,
// and land on the replay's own clock: the light trail, the Sentinel and a
// jump to the end all light exactly the same threads. While the layout still
// moves, a leg is planned from where the notes were in the frame that began
// it — its way and its grips alike — so what it lights can differ by a thread
// from one frame rate to another; at rest it never does.
//
// A leg's distance follows a profile in time — a walk eases in and out, a
// crossing of the void feels its way first — but it lasts exactly as long as
// it always did, so the panel's timings do not move.
//
// Each leg and each pause starts exactly where the last one ended, on that
// profile, not at the first frame that notices: what is left of the frame
// goes to the next. A replay used to lose up to a frame at every step, so its
// clock — and anything stamped on it — drifted with the frame rate. Now the
// history it keeps (`ReplayView.history`: the threads gone along, the notes
// reached and found, each stamped) is the same at any frame rate and after a
// jump to the end, and whatever draws a dormant network lights from it alone.
//
// Everything is remembered by note id and thread key, never by graph object.
// The graph builds new edge objects whenever it is rebuilt (a layer toggled, a
// note added), and a Map keyed by edge counted the same thread twice after
// every rebuild.
//
// By default it walks the brain: the threads graph-scene draws, measured along
// the brain's curve, in units of its typical link. A space of the Sentinel's own
// (space/space.ts) puts the notes elsewhere and draws its threads as pipes or
// arcs, so it hands the replay its own field, unit and pace instead. Then
// every length, every place and the way between two notes come from that
// field, and — given its unit too — the brain's positions in the model are
// never read: they say nothing about where a note stands in the space, or
// which way is short there.
//
// Over a space's field a walk may also start from, and come back to, a place
// that is no note: a perch, the frame round the prompt the Sentinel clings to
// (prompt/). It rests there holding the frame until a crawl is loaded, sets
// out across the void to the crawl's first note, and is called back from
// wherever it is. The frame's rails are threads its claws hold, but they are
// no part of the vault: nothing lights them, counts them or stamps them.

import { hash01, type GraphEdge, type GraphModel, type GraphNode } from '@/lib/graph-model';

import {
  findWalk,
  nodePlace,
  planCrawl,
  walkable,
  type CrawlPlan,
  type CrawlResult,
  type CrawlStep,
  type Reach as PlannedReach,
  type ReachKind,
} from './crawl-plan';
import { emptySnapshot, type CrawlSnapshot } from './crawl-snapshot';
import type {
  Hold,
  LegSegment,
  Lit,
  Passage,
  Reach,
  ReplayEvent,
  ReplayHistory,
  ReplayView,
  Swing,
  WalkLeg,
} from './replay-view';
import { GRIP_SLOTS, TENTACLE_SPECS } from './sentinel/anatomy';
import {
  CROWD_RADIUS,
  DEFAULT_GRIP,
  PERCH_ORDER,
  planPerchGrips,
  planWalkGrips,
  swingDuration,
  type GripParams,
} from './sentinel/grips';
import {
  at,
  graphThreadField,
  legPoint,
  segmentLength,
  threadKey,
  typicalLink,
  type ThreadField,
  type ThreadKey,
} from './threads';
import { dist, type Vec3 } from './vec';

/**
 * Distance walked `t` seconds into a leg of `duration`: it speeds up over
 * `ramp`, cruises, slows down over `ramp` again, and is at `total` exactly at
 * `duration` — a body with weight, on the same clock the panel shows.
 */
export function walkProgress(t: number, total: number, duration: number, ramp: number): number {
  if (!(duration > 0) || t >= duration) return total;
  if (t <= 0) return 0;
  const r = Math.max(0, Math.min(ramp, duration / 2));
  // The trapezoid's area is the distance: cruising speed × (duration − ramp).
  const v = total / (duration - r);
  if (t < r) return (v * t * t) / (2 * r);
  if (t <= duration - r) return v * (t - r / 2);
  const left = duration - t;
  return total - (v * left * left) / (2 * r);
}

/** Seconds a walk of any length but the shortest takes to reach cruising speed, and to stop. */
const RAMP = 0.3;

/** Seconds a walk takes to reach cruising speed, and to stop. */
export const walkRamp = (duration: number): number => Math.min(RAMP, duration / 4);

/**
 * How long a walk of `total` takes when it cruises at exactly `pace`:
 * `walkProgress` cruises at total / (duration − ramp), and the ramp itself
 * depends on the duration, so this solves for it on each side of where the
 * ramp stops growing (a duration of 4 × RAMP).
 */
export function pacedDuration(total: number, pace: number): number {
  const long = total / pace + RAMP;
  return long >= 4 * RAMP ? long : (4 * total) / (3 * pace);
}

/** Of a crossing through the void, the first 40 % of the time covers 25 % of the distance: feeling the way. */
const VOID_SPLIT = 0.4;
const VOID_COVERED = 0.25;
/** The change of pace is spread over this much of the crossing, so speed never jumps. */
const VOID_BLEND = 0.15;

/** The integral from 0 to `x` of smoothstep, x²(3 − 2x): speed eases in and out along it. */
const smoothArea = (x: number) => x * x * x - (x * x * x * x) / 2;

/**
 * Distance covered `t` seconds into a crossing of the void: slow at first
 * while it feels for the far note, then across, starting and ending at rest,
 * with no jump in speed anywhere — and at `total` exactly at `duration`.
 */
export function voidProgress(t: number, total: number, duration: number): number {
  if (!(duration > 0) || t >= duration) return total;
  if (t <= 0) return 0;
  const x = t / duration;
  // Everything below is in fractions of the crossing's time and distance.
  const r = Math.min(0.3 / duration, 0.25);
  const w = VOID_BLEND;
  const a = VOID_SPLIT - r / 2;
  const b = 1 - VOID_SPLIT - r / 2;
  const c = (3 * w) / 32;
  // Slow and fast speeds such that the split lands where it should and the whole adds up to 1.
  const fast = (a * (1 - VOID_COVERED) - c) / (a * b - c * a - b * c);
  const slow = (1 - fast * b) / a;
  const s0 = VOID_SPLIT - w / 2;
  const s1 = VOID_SPLIT + w / 2;
  let f: number;
  if (x <= r) f = slow * r * smoothArea(x / r);
  else if (x <= s0) f = slow * (r / 2 + x - r);
  else if (x <= s1) {
    const at0 = slow * (r / 2 + s0 - r);
    f = at0 + slow * (x - s0) + (fast - slow) * w * smoothArea((x - s0) / w);
  } else if (x <= 1 - r) {
    const at1 = slow * (r / 2 + s0 - r) + slow * w + ((fast - slow) * w) / 2;
    f = at1 + fast * (x - s1);
  } else f = 1 - fast * r * smoothArea((1 - x) / r);
  return Math.min(total, f * total);
}

/** How long a walk to nowhere — a step that stays on its note — waits before reading. */
const EMPTY_WAIT = 0.5;
/** Silk across the void sags this many units at its middle under its weight. */
const SILK_SAG = 0.6;
/** A crossing touches the far note once it is this many units away: an explorer's full reach, telescoped. */
const EXPLORER = TENTACLE_SPECS.find((t) => t.role === 'explorer')!;
const CONTACT_REACH = EXPLORER.length * EXPLORER.maxStretch;
/** Events kept for a reader that stopped draining them. */
const MAX_EVENTS = 256;
/** A reach touches what it reaches for this long after it sets out, seconds: that is when it is found. */
const REACH_TOUCH = 0.4;
/**
 * Resting on a perch, a claw re-grips first this many seconds in, then every
 * FIDGET_EVERY plus up to FIDGET_SPREAD more, each swing taking FIDGET_SWING:
 * often enough to read as alive, seldom enough to read as calm. The swing is
 * slow: at a third of a second, and every three to six seconds, a re-grip
 * read as a twitch on a creature otherwise at rest.
 */
const FIDGET_FIRST = 3;
const FIDGET_EVERY = 4;
const FIDGET_SPREAD = 3;
const FIDGET_SWING = 0.7;
/** A re-grip lands this far from where the claw first took hold, creature units, plus up to FIDGET_SHIFT_SPREAD more. */
const FIDGET_SHIFT = 0.1;
const FIDGET_SHIFT_SPREAD = 0.12;

/**
 * How long a crossing of the void takes, by its length: `speed` creature
 * units a second on average, never under `min` seconds nor over `max`. A
 * crossing given a fixed time goes the faster the further it is, and body.ts
 * snaps a body whose goal moves more than 3 units in a frame instead of
 * moving it there.
 */
export interface CrossingPace {
  speed: number;
  min: number;
  max: number;
}

/**
 * The fastest a paced crossing may go on average, creature units a second,
 * whatever its `max` says. `voidProgress` peaks at 1.35 to 1.6 times its
 * average — the most on the shortest crossings, whose ramps take the largest
 * share of them — so the cursor stays under 2.6 units in a 64 ms frame,
 * short of the 3 at which the body is snapped across. Only a crossing far
 * longer than any a cluster of today's vaults asks for reaches it.
 */
const CROSSING_MOST = 25;

/** Seconds a crossing of `length` world units takes at `pace`, measured in creature units of `unit`. */
export function crossingTime(length: number, unit: number, pace: CrossingPace): number {
  const units = length / unit;
  const paced =
    pace.speed > 0 ? Math.min(pace.max, Math.max(pace.min, units / pace.speed)) : pace.max;
  return Math.max(paced, units / CROSSING_MOST);
}

/**
 * A place the walk sets out from and comes back to that is no note: the frame
 * round the prompt the Sentinel clings to. The injected field places it
 * (`node(id)`) and draws its rails; the model knows nothing of it.
 */
export interface ReplayPerch {
  id: string;
  /** The way the Sentinel faces on it, world space: its grips are planned along it. */
  heading: Vec3;
  /**
   * Where a crossing from it sets out and one back to it lands, world space:
   * the spot its body floats `hover` above as it clings there. A walk floats
   * there too, so the body neither jumps as it lets go nor skims the frame on
   * its way. Absent, the perch's node.
   */
  at?: Vec3 | null;
  /**
   * Threads that belong to it — the frame's rails — which a grip holds but
   * never lights: they are no part of the vault, and nothing counts them.
   */
  keys: ReadonlySet<ThreadKey>;
  /** The grip planner's parameters on it, over its defaults: a claw may reach further for the frame. */
  grip?: Partial<GripParams>;
  /**
   * How long the crossing from it to the crawl's first note takes: seconds,
   * or paced by its length. Absent or null, as long as any crossing that long.
   */
  crossing?: number | CrossingPace | null;
  /**
   * Seconds it holds still, letting go of the perch, before that crossing
   * moves: it is seen to let go, rather than torn away. None by default.
   */
  release?: number;
}

/**
 * What a replay may be handed besides the crawl and its model, to walk a
 * space of its own instead of the brain. Each is optional: with none of them
 * it walks the brain exactly as it always has.
 */
export interface ReplayOptions {
  /**
   * How far each note has faded in, 0 to 1: the brain's field hides a note
   * below 0.6. An injected `field` never reads it — whoever built the field
   * decides what it shows — so alongside one, `appear` and `setAppear` change
   * nothing.
   */
  appear?: (n: GraphNode) => number;
  /**
   * The notes and threads to walk. Lengths come from its `length` when it has
   * one (measured along it otherwise), places from its `node`, and each leg
   * takes the way that is shortest along its threads. Kept across `rebind`
   * until a `load` without one.
   */
  field?: ThreadField;
  /** World units per creature unit; the brain's typical link by default. Ignored unless positive. */
  unit?: number;
  /**
   * The fastest a walk may go, world units a second: its cruising speed,
   * between easing in and out, never passes it. At the brain's pace a long
   * leg rushes through a pipe's elbows; a space with sharp ones slows it
   * down. A crossing of the void takes as long as a walk of its length would.
   * Null or absent: no limit.
   */
  pace?: number | null;
  /**
   * On `load`, the walk sets out from this perch, holding it, its first leg a
   * crossing of the void to the crawl's first note; on `rest`, it rests
   * there. Needs `field`, which must place it. Not kept: `replay()` starts at
   * the first note, as ever.
   */
  perch?: ReplayPerch | null;
}

/** How far each note has faded in, as the scene draws it. */
type Appear = (n: GraphNode) => number;

/** `load` and `rebind` used to take an appear function alone, and still do. */
function optionsOf(opts: ReplayOptions | Appear | undefined): ReplayOptions {
  return typeof opts === 'function' ? { appear: opts } : (opts ?? {});
}

/** A positive, finite number, or null: a unit or a pace the replay can divide by. */
function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : null;
}

/**
 * A thread's length as a field draws it, world units: its own word when it
 * has `length`, measured along eight chords otherwise. NaN when it is gone.
 */
function drawnLength(field: ThreadField, key: ThreadKey): number {
  if (field.length) return field.length(key);
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [0, 0, 0];
  if (!field.point(key, 0, a)) return Number.NaN;
  let total = 0;
  for (let i = 1; i <= 8; i++) {
    if (!field.point(key, i / 8, b)) return Number.NaN;
    total += dist(a, b);
    a[0] = b[0];
    a[1] = b[1];
    a[2] = b[2];
  }
  return total;
}

export interface ReplayLabel {
  nodeId: string | null;
  /** Where it hangs when there is no note: the void. */
  point: Vec3 | null;
  text: string;
  kind: ReachKind | 'ask';
  /** Replay clock when it appeared. */
  born: number;
}

/** A reach while dwelling, with what it hands over when it touches. */
interface Reaching {
  view: Reach;
  /** Seconds into the dwell when it sets out. */
  at: number;
  applied: boolean;
  found: PlannedReach | null;
}

/** A swing setting out (`land` false) or landing, `time` seconds into the leg or dwell. */
interface Action {
  time: number;
  land: boolean;
  swing: Swing;
}

const NOWHERE: ThreadField = {
  has: () => false,
  point: () => false,
  closest: () => null,
  node: () => false,
  around: () => [],
  up: (_p, out) => {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
  },
};

function firstVisit(plan: CrawlPlan): Extract<CrawlStep, { kind: 'visit' }> | undefined {
  return plan.steps.find((s): s is Extract<CrawlStep, { kind: 'visit' }> => s.kind === 'visit');
}

export class CrawlReplay {
  private model: GraphModel | null = null;
  private appear: Appear = () => 1;
  private field: ThreadField = NOWHERE;
  /** A space's own field, handed in; null walks the brain's, built from the model. */
  private injected: ThreadField | null = null;
  /** The fastest a walk may go, world units a second; null for no limit. */
  private pace: number | null = null;
  private byId = new Map<string, GraphNode>();
  private plan: CrawlPlan | null = null;
  private scale = 1;
  private clock = 0;
  private stepIndex = 0;
  private mode: ReplayView['mode'] = 'idle';
  /** Seconds into the current leg or dwell. */
  private t = 0;
  /** Replay clock when the current leg or dwell began. */
  private phaseStart = 0;
  private dwell = 1;
  private here: GraphNode | null = null;
  /** Where the current leg goes; null when it stays on its note. */
  private target: GraphNode | null = null;
  private segments: LegSegment[] = [];
  /** World units from the leg's start to the end of each stretch. */
  private ends: number[] = [];
  private k = 0;
  private travelled = 0;
  private total = 0;
  private duration = 0;
  private crossing = false;
  private touched = false;
  private readonly dir: Vec3 = [0, 0, 1];
  private readonly lit = new Map<ThreadKey, Lit>();
  private crossed: LegSegment[] = [];
  private labelList: ReplayLabel[] = [];
  private reaching: Reaching[] = [];
  private readonly reachViews: Reach[] = [];
  private readonly found = new Map<string, ReachKind>();
  private readonly passages: Passage[] = [];
  private readonly reachedAt = new Map<string, number>();
  private readonly foundAt = new Map<string, number>();
  private readonly history: ReplayHistory = {
    passages: this.passages,
    reached: this.reachedAt,
    foundAt: this.foundAt,
    epoch: 0,
  };
  /** Seconds into the current leg when it reaches the end of each stretch: the last is its duration. */
  private leaves: number[] = [];
  /** Legs and pauses begun so far: a frame runs on until one stops ending. */
  private phases = 0;
  private readonly holds: (Hold | null)[] = GRIP_SLOTS.map(() => null);
  private readonly swings: Swing[] = [];
  /** Swings on the current leg or dwell's clock, in order; `next` is the first still to happen. */
  private actions: Action[] = [];
  private next = 0;
  /** When each slot's last swing lands: the next one never sets out before. */
  private readonly slotLand: number[] = GRIP_SLOTS.map(() => 0);
  private events: ReplayEvent[] = [];
  private following = true;
  private snap: CrawlSnapshot = emptySnapshot();
  private readonly leg: WalkLeg = {
    segments: [],
    total: 0,
    duration: 0,
    t: 0,
    travelled: 0,
    void: false,
  };
  private readonly dwelling = { t: 0, duration: 0 };
  private readonly out: ReplayView;
  private readonly scratch: Vec3 = [0, 0, 0];
  /** The perch it rests on, sets out from or goes back to; null while it walks a crawl alone. */
  private perch: ReplayPerch | null = null;
  /** It stands on the perch, not on a note: `here` is null, or the note it last left. */
  private perched = false;
  /** Resting on the perch with no crawl to walk: nothing happens but re-grips. */
  private restingNow = false;
  /** The current leg goes back to the perch. */
  private homing = false;
  /** Seconds at the start of the current leg it holds still before it moves: letting go of the perch. */
  private hold = 0;
  /** Re-grips so far in this rest, and when the next is due, seconds into it. */
  private fidgets = 0;
  private nextFidget = 0;
  /** What each slot held once the rest's grips landed: a re-grip shifts about that, never about the last. */
  private readonly restGrips: (Hold | null)[] = GRIP_SLOTS.map(() => null);

  constructor(private readonly onChange: (s: CrawlSnapshot) => void) {
    this.out = {
      mode: 'idle',
      clock: 0,
      unit: 1,
      stepIndex: 0,
      hereId: null,
      nextId: null,
      dir: this.dir,
      walk: null,
      dwell: null,
      holds: this.holds,
      swings: this.swings,
      reaches: this.reachViews,
      lit: this.lit,
      found: this.found,
      history: this.history,
      field: this.field,
    };
  }

  // -- Loading -------------------------------------------------------------------

  /**
   * Replay a crawl over this model: over the brain, or over the field `opts`
   * hands in. An appear function alone is `{ appear }`.
   */
  load(result: CrawlResult, model: GraphModel, opts?: ReplayOptions | Appear): void {
    const o = optionsOf(opts);
    this.appear = o.appear ?? (() => 1);
    this.injected = o.field ?? null;
    this.pace = positive(o.pace);
    this.bind(model);
    const plan = planCrawl(result, model);
    this.plan = plan;
    this.scale = positive(o.unit) ?? typicalLink(model);
    const first = firstVisit(plan);
    // A crawl with no note to walk to has nowhere to cross to: it starts as ever.
    const perch = first ? this.placed(o.perch) : null;
    // Loaded while it rests there, its claws hold what they held — they let
    // go as the crossing sets out, not a frame before. The clock starts over,
    // so they have held since its start.
    const kept =
      perch && this.restingNow && this.perch?.id === perch.id ? this.settledHolds() : null;
    this.reset();
    this.snap = {
      ...emptySnapshot(),
      coverage: plan.coverage,
      offGraph: plan.offGraph,
      following: true,
    };
    if (perch) {
      this.perch = perch;
      this.perched = true;
      this.here = null;
      this.face(perch.heading);
      if (kept) kept.forEach((h, g) => (this.holds[g] = h));
      else this.gripPerch(this.clock, true);
      this.begin();
      this.emit();
      return;
    }
    this.here = first
      ? this.node(first.at)
      : (model.nodes.find((n) => n.kind === 'note' && !n.foreign) ?? null);
    if (!this.here) {
      this.mode = 'idle';
      this.emit();
      return;
    }
    this.setOut();
    this.emit();
  }

  /**
   * The model was rebuilt (a layer toggled, a note added): find the same notes
   * and threads in it. A grip on a thread the graph no longer draws lets go.
   * Whatever `opts` hands in replaces what the replay had, and the rest stays:
   * a field injected at `load` is kept unless a new one comes. A new unit or
   * pace shapes the legs that begin from now on.
   */
  rebind(model: GraphModel, opts?: ReplayOptions | Appear): void {
    const o = optionsOf(opts);
    if (o.appear) this.appear = o.appear;
    if (o.field) this.injected = o.field;
    this.scale = positive(o.unit) ?? this.scale;
    if (o.pace !== undefined) this.pace = positive(o.pace);
    this.bind(model);
    if (this.here) this.here = this.node(this.here);
    if (this.target) this.target = this.node(this.target);
    for (let g = 0; g < this.holds.length; g++) {
      const h = this.holds[g];
      if (!h || this.field.has(h.key)) continue;
      this.holds[g] = null;
      this.push({ kind: 'release', clock: this.clock, slot: g, key: h.key });
    }
  }

  /**
   * How far each note has faded in, as of this frame. The scene's appear reads
   * the frame's clock, so the one handed to `load` stops at that moment: a
   * note still fading in then would stay hidden to the replay. Cheap enough
   * to call every frame. Over an injected field it changes nothing: that
   * field's owner decides what it shows, and keeps it up to date itself.
   */
  setAppear(appear: Appear): void {
    this.appear = appear;
  }

  clear(): void {
    this.reset();
    this.plan = null;
    this.mode = 'idle';
    this.here = null;
    this.snap = emptySnapshot();
    this.emit();
  }

  replay(): void {
    const plan = this.plan;
    if (!plan || !this.model) return;
    this.reset();
    this.snap = {
      ...emptySnapshot(),
      coverage: plan.coverage,
      offGraph: plan.offGraph,
      following: true,
    };
    const first = firstVisit(plan);
    if (first) this.here = this.node(first.at);
    this.setOut();
    this.emit();
  }

  /**
   * Rests on the perch with no crawl: holding it, dwelling there until a
   * crawl is loaded — the prompt scene. Its grips are taken at once: it is
   * found holding on, not seen landing. While it rests, every few seconds on
   * its own clock one claw lets go and takes hold again a little along its
   * edge: the same at any frame rate. Needs `opts.field` placing
   * `opts.perch`; without them it clears (mode 'idle').
   */
  rest(model: GraphModel, opts: ReplayOptions): void {
    this.appear = opts.appear ?? (() => 1);
    this.injected = opts.field ?? null;
    this.pace = positive(opts.pace);
    this.bind(model);
    this.plan = null;
    this.scale = positive(opts.unit) ?? typicalLink(model);
    this.reset();
    this.snap = emptySnapshot();
    this.here = null;
    const perch = this.placed(opts.perch);
    if (!perch) {
      this.mode = 'idle';
      this.emit();
      return;
    }
    this.perch = perch;
    this.settleOnPerch(this.clock, 0, true);
    this.emit();
  }

  /**
   * Calls the walk back to a perch — the prompt scene's "new search" — from
   * wherever it is: a note it stands on, partway along a leg, or
   * mid-crossing. It goes straight across the void from exactly where the
   * cursor was, letting go of what it holds, then takes hold of the perch and
   * rests there as `rest` does, its grips landing one after another. The leg
   * it was on is cut, not run to its end: grips it would have taken further
   * along never land, so nothing new lights. What the crawl lit and found
   * stays, so whatever draws it fades it out on its own. `crossing` is the
   * seconds the way back takes, or a pace for its length; absent, as long as
   * any crossing that long. False, and nothing changes, when the field does
   * not place the perch or it already rests.
   */
  recall(perch: ReplayPerch, crossing?: number | CrossingPace | null): boolean {
    if (this.restingNow || !this.placed(perch)) return false;
    const cursor = this.cursorPoint();
    const from: Vec3 | null = cursor ? [cursor[0], cursor[1], cursor[2]] : null;
    this.cut();
    this.perch = perch;
    this.reaching = [];
    this.reachViews.length = 0;
    this.target = null;
    this.touched = false;
    const to = this.perchPoint(perch);
    if (!from || !to) {
      // Nowhere to come back from — nothing was loaded: it is simply there.
      this.settleOnPerch(this.clock, 0, true);
      this.emit();
      return true;
    }
    // A step the plan has not: there is no step to read, and the motion sees a new phase.
    this.stepIndex = Math.max(this.stepIndex + 1, this.plan?.steps.length ?? 0);
    this.homing = true;
    this.perched = false;
    this.restingNow = false;
    this.crossing = true;
    this.hold = 0;
    const length = Math.max(dist(from, to), 1e-6);
    this.segments = [
      {
        fromId: this.here?.id ?? perch.id,
        toId: perch.id,
        key: null,
        length,
        from,
        ...(perch.at ? { to: [perch.at[0], perch.at[1], perch.at[2]] as Vec3 } : {}),
      },
    ];
    this.ends = [length];
    this.total = length;
    this.k = 0;
    this.travelled = 0;
    this.duration = this.crossingDuration(length, crossing);
    this.leaves = [this.duration];
    this.t = 0;
    this.phaseStart = this.clock;
    this.mode = 'walk';
    this.push({ kind: 'begin', clock: this.clock, stepIndex: this.stepIndex, nextId: perch.id });
    this.letGo();
    this.snap = { ...this.snap, state: 'walking' };
    this.log('walk', 'go back', 'to the prompt');
    return true;
  }

  /** Resting on a perch: after `rest`, or once a `recall` has landed. Nothing more happens but re-grips. */
  get resting(): boolean {
    return this.restingNow;
  }

  /**
   * Runs the replay to its end in the steps an animation would take: it
   * lights exactly what the animation lights. A walk going back to its perch
   * ends resting there, its grips landed; a replay already resting stays
   * where it is, but its claw mid re-grip lands.
   */
  skipToEnd(): void {
    let guard = 0;
    while (this.mode !== 'done' && this.mode !== 'idle' && !this.restingNow && guard++ < 20000) {
      this.update(0.05);
    }
    if (this.restingNow) this.flush();
  }

  /** Advances the replay `dt` seconds — already scaled by the playback speed, and 0 while paused. */
  update(dt: number): void {
    const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
    this.clock += step;
    for (const l of this.lit.values()) l.glow = Math.max(l.floor, l.glow - step * 0.9);
    if (this.mode === 'done' || this.mode === 'idle') return;
    this.t += step;
    // A leg or a pause that ends partway through the frame hands the rest of
    // it to the next, which starts where it ended; one long frame may see
    // several through. Each step of the plan is a leg and a pause at most, and
    // once done nothing begins again.
    const most = 2 * (this.plan?.steps.length ?? 0) + 2;
    for (let n = 0; n < most; n++) {
      const phases = this.phases;
      if (this.mode === 'walk') this.walk();
      else if (this.mode === 'dwell') this.read();
      if (this.phases === phases) break;
    }
  }

  // -- Camera --------------------------------------------------------------------

  follow(): { x: number; y: number; z: number; dist: number } | null {
    if (!this.following || this.mode === 'idle') return null;
    if (this.mode === 'done') {
      const pts: Vec3[] = [];
      for (const id of this.found.keys()) {
        const n = this.byId.get(id);
        const p = n ? this.where(n) : null;
        if (p) pts.push(p);
      }
      if (pts.length === 0) return null;
      const c: Vec3 = [0, 0, 0];
      for (const p of pts) for (let i = 0; i < 3; i++) c[i]! += p[i]! / pts.length;
      const r = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
      return { x: c[0], y: c[1], z: c[2], dist: r * 3 + this.scale * 8 };
    }
    const p = this.cursorPoint();
    if (!p) return null;
    return { x: p[0], y: p[1], z: p[2], dist: this.scale * 12 };
  }

  onUserCamera(): void {
    if (!this.following) return;
    this.following = false;
    this.snap = { ...this.snap, following: false };
    this.emit();
  }

  followAgain(): void {
    this.following = true;
    this.snap = { ...this.snap, following: true };
    this.emit();
  }

  // -- What it shows -------------------------------------------------------------

  /** The replay as whatever draws it reads it. The same object every call, updated in place. */
  get view(): ReplayView {
    const v = this.out;
    v.mode = this.mode;
    v.clock = this.clock;
    v.unit = this.scale;
    v.stepIndex = this.stepIndex;
    v.hereId = this.perched && this.perch ? this.perch.id : (this.here?.id ?? null);
    v.nextId =
      this.mode === 'walk'
        ? this.homing
          ? (this.perch?.id ?? null)
          : (this.target?.id ?? null)
        : this.restingNow
          ? null
          : this.upcoming();
    v.field = this.field;
    if (this.mode === 'walk') {
      const leg = this.leg;
      leg.segments = this.segments;
      leg.total = this.total;
      leg.duration = this.duration;
      leg.t = this.t;
      leg.travelled = this.travelled;
      leg.void = this.crossing;
      v.walk = leg;
    } else v.walk = null;
    if (this.mode === 'dwell') {
      this.dwelling.t = this.t;
      this.dwelling.duration = this.dwell;
      v.dwell = this.dwelling;
    } else v.dwell = null;
    return v;
  }

  /** What happened since the last call: grips, arrivals, notes found. */
  drain(): ReplayEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  get snapshot(): CrawlSnapshot {
    return this.snap;
  }

  get labels(): readonly ReplayLabel[] {
    return this.labelList;
  }

  /** Stretches of the void the walk has set out across, for the trail's silk. */
  get silk(): readonly LegSegment[] {
    return this.crossed;
  }

  /** World units per creature unit: the vault's typical link, or the unit a space handed in. */
  get unit(): number {
    return this.scale;
  }

  /**
   * Where the walk is this moment, world units: along the leg it walks, on the
   * perch it holds, or on the note it stands on; null with nowhere to be. What
   * shows the walker as light alone, when no creature is drawn, reads it every
   * frame. A copy: the replay's own point is reused.
   */
  get cursor(): Vec3 | null {
    const p = this.cursorPoint();
    return p ? [p[0], p[1], p[2]] : null;
  }

  // -- The replay ----------------------------------------------------------------

  private bind(model: GraphModel): void {
    this.model = model;
    // Through `this`, so `setAppear` reaches the brain's field without rebuilding its maps.
    this.field = this.injected ?? graphThreadField(model, (n) => this.appear(n));
    this.byId = new Map(model.nodes.map((n) => [n.id, n]));
  }

  /** The same note in the current model: a plan made before a rebuild still names the old objects. */
  private node(n: GraphNode): GraphNode {
    return this.byId.get(n.id) ?? n;
  }

  /**
   * Where a note stands: where the brain draws it, or where an injected
   * field puts it — null when that field does not show it.
   */
  private where(n: GraphNode): Vec3 | null {
    if (!this.injected) return at(n);
    const p: Vec3 = [0, 0, 0];
    return this.injected.node(n.id, p) ? p : null;
  }

  /**
   * How far silk across the void sags at its middle, world units. In a space
   * of its own a crossing is measured as the straight way across, so it is
   * walked straight too.
   */
  private get voidSag(): number {
    return this.injected ? 0 : this.scale * SILK_SAG;
  }

  /**
   * How long a stretch of a leg is: along the brain's curve or its silk, or
   * along an injected field's thread, or straight across between where that
   * field puts the two notes. NaN when a note has no place yet.
   */
  private stretchLength(from: GraphNode, to: GraphNode, edge: GraphEdge | null): number {
    const field = this.injected;
    if (!field) return segmentLength({ from, to, edge }, this.scale);
    if (edge) return Math.max(drawnLength(field, threadKey(from, to)), 1e-6);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    if (!field.node(from.id, a) || !field.node(to.id, b)) return Number.NaN;
    return Math.max(dist(a, b), 1e-6);
  }

  /**
   * The shortest walk along an injected field's threads, by their drawn
   * length: `findWalk`, with the space's lengths instead of the brain's
   * distances, and only over threads the field draws. Threads already lit cost
   * a little less, as there, so it keeps to its own path when one is as good.
   * Null when no drawn thread joins them.
   */
  private fieldWalk(
    model: GraphModel,
    field: ThreadField,
    from: GraphNode,
    to: GraphNode,
  ): GraphNode[] | null {
    if (from === to) return [from];
    const best = new Map<GraphNode, number>([[from, 0]]);
    const prev = new Map<GraphNode, GraphNode>();
    const done = new Set<GraphNode>();
    // A linear scan for the next note, as `findWalk` does: a few thousand notes at most.
    const open = new Set<GraphNode>([from]);
    while (open.size > 0) {
      let u: GraphNode | null = null;
      let du = Infinity;
      for (const n of open) {
        const d = best.get(n)!;
        if (d < du) {
          du = d;
          u = n;
        }
      }
      if (!u || u === to) break;
      open.delete(u);
      done.add(u);
      for (const { node: v, edge } of model.adjacency.get(u) ?? []) {
        if (!walkable(edge) || done.has(v)) continue;
        const key = threadKey(u, v);
        if (!field.has(key)) continue;
        const w = drawnLength(field, key) * (this.lit.has(key) ? 0.8 : 1);
        if (!(w >= 0)) continue;
        if (du + w < (best.get(v) ?? Infinity)) {
          best.set(v, du + w);
          prev.set(v, u);
          open.add(v);
        }
      }
    }
    if (!prev.has(to)) return null;
    const path = [to];
    while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
    return path;
  }

  private reset(): void {
    this.lit.clear();
    this.crossed = [];
    this.labelList = [];
    this.reaching = [];
    this.reachViews.length = 0;
    this.found.clear();
    this.passages.length = 0;
    this.reachedAt.clear();
    this.foundAt.clear();
    this.history.epoch++;
    this.leaves = [];
    this.holds.fill(null);
    this.swings.length = 0;
    this.actions = [];
    this.next = 0;
    this.slotLand.fill(0);
    this.events = [];
    this.clock = 0;
    this.stepIndex = 0;
    this.following = true;
    this.target = null;
    this.segments = [];
    this.perch = null;
    this.perched = false;
    this.restingNow = false;
    this.homing = false;
    this.hold = 0;
    this.fidgets = 0;
    this.nextFidget = 0;
    this.restGrips.fill(null);
    // Grips around the first note are planned along the heading: a replay
    // must not inherit the last run's.
    this.dir[0] = 0;
    this.dir[1] = 0;
    this.dir[2] = 1;
  }

  // -- The perch -----------------------------------------------------------------

  /** `perch` when the injected field places it; null otherwise, or without one. */
  private placed(perch: ReplayPerch | null | undefined): ReplayPerch | null {
    return perch && this.injected && this.field.node(perch.id, this.scratch) ? perch : null;
  }

  /** Where a crossing from the perch sets out and one back to it lands, a new triple; null when it is gone. */
  private perchPoint(perch: ReplayPerch): Vec3 | null {
    if (perch.at) return [perch.at[0], perch.at[1], perch.at[2]];
    const p: Vec3 = [0, 0, 0];
    return this.field.node(perch.id, p) ? p : null;
  }

  /** Faces `heading`, when it has a length. */
  private face(heading: Vec3): void {
    const l = Math.hypot(heading[0], heading[1], heading[2]);
    if (!(l > 1e-9)) return;
    this.dir[0] = heading[0] / l;
    this.dir[1] = heading[1] / l;
    this.dir[2] = heading[2] / l;
  }

  /** What the slots hold once everything on the clock has landed, as of the clock's start. */
  private settledHolds(): (Hold | null)[] {
    this.flush();
    return this.holds.map((h) => (h ? { key: h.key, u: h.u, since: 0 } : null));
  }

  /**
   * Takes hold of the perch's frame as it does round a note it reads: the
   * grips planned about the perch's node along its heading, with the perch's
   * own parameters. `atOnce`, they hold from `start` — it is found holding
   * on; otherwise they land one after another, `start` being when the dwell
   * began. What each slot then holds is where its re-grips return to.
   */
  private gripPerch(start: number, atOnce: boolean): void {
    const perch = this.perch;
    if (!perch) return;
    const p = { ...DEFAULT_GRIP, ...perch.grip };
    const grips = planPerchGrips({
      hereId: perch.id,
      forward: this.dir,
      field: this.field,
      unit: this.scale,
      lit: new Set(),
      held: this.holds,
      params: perch.grip,
    });
    for (let g = 0; g < this.holds.length; g++) {
      const h = this.holds[g];
      this.restGrips[g] = h ? { key: h.key, u: h.u, since: h.since } : null;
    }
    for (const g of grips) {
      const hold = g.key ? { key: g.key, u: g.u, since: start + (atOnce ? 0 : g.t) } : null;
      this.restGrips[g.slot] = hold;
      if (atOnce) {
        this.holds[g.slot] = hold ? { ...hold } : null;
        continue;
      }
      this.enqueue(g.slot, g.key, g.u, Math.max(0, g.t - p.swingMax), g.t);
      this.slotLand[g.slot] = g.t;
    }
  }

  /**
   * Comes to rest on the perch, `carry` seconds of the rest already gone:
   * holding its frame, dwelling there for good until a crawl is loaded.
   * Taken `atOnce`, its grips hold from `start`; otherwise it has just
   * landed, and they land one after another as round a note it arrives at.
   */
  private settleOnPerch(start: number, carry: number, atOnce: boolean): void {
    const perch = this.perch;
    if (!perch) return;
    this.newPhase();
    this.homing = false;
    this.perched = true;
    this.restingNow = true;
    this.target = null;
    this.segments = [];
    this.crossing = false;
    this.hold = 0;
    this.mode = 'dwell';
    this.dwell = Infinity;
    this.t = carry;
    this.phaseStart = start;
    this.reaching = [];
    this.reachViews.length = 0;
    this.face(perch.heading);
    this.fidgets = 0;
    this.nextFidget = FIDGET_FIRST;
    this.gripPerch(start, atOnce);
    if (!atOnce) this.push({ kind: 'arrive', clock: start, nodeId: perch.id });
    this.snap = { ...this.snap, state: 'idle' };
  }

  /**
   * While it rests, now and then one claw lets go of the frame and takes hold
   * again a little along its edge: alive, not frozen. Each re-grip is due on
   * the rest's own clock and decided from what had landed by then, so it is
   * the same at any frame rate. Each lands about where that claw first took
   * hold, never about where it last did: shifts added one to the next would
   * walk the claws along the rails, past the arm's reach and onto each other.
   * One that would land on another claw is skipped.
   */
  private fidget(): void {
    const perch = this.perch;
    if (!perch) return;
    const p = { ...DEFAULT_GRIP, ...perch.grip };
    const crowd = CROWD_RADIUS * this.scale;
    const q: Vec3 = [0, 0, 0];
    const other: Vec3 = [0, 0, 0];
    const clear = (slot: number, key: ThreadKey, u: number): boolean => {
      if (!this.field.point(key, u, q)) return false;
      return this.holds.every(
        (h, k) =>
          k === slot || !h || !this.field.point(h.key, h.u, other) || dist(q, other) >= crowd,
      );
    };
    while (this.t >= this.nextFidget) {
      const n = this.fidgets++;
      const when = this.nextFidget;
      this.nextFidget += FIDGET_EVERY + FIDGET_SPREAD * hash01(`fidget:${n}:wait`);
      this.run(when);
      for (let j = 0; j < PERCH_ORDER.length; j++) {
        const g = PERCH_ORDER[(n + j) % PERCH_ORDER.length]!;
        const h = this.holds[g];
        const home = this.restGrips[g];
        if (!h || !home || home.key !== h.key || !perch.keys.has(h.key)) continue;
        if (this.slotLand[g]! > when) continue;
        const length = drawnLength(this.field, h.key);
        if (!(length > 0)) continue;
        const shift =
          ((FIDGET_SHIFT + FIDGET_SHIFT_SPREAD * hash01(`fidget:${n}:shift`)) * this.scale) /
          length;
        const way = hash01(`fidget:${n}:way`) < 0.5 ? -1 : 1;
        const u = [home.u + way * shift, home.u - way * shift].find(
          (v) => v >= p.uMin && v <= p.uMax && clear(g, h.key, v),
        );
        if (u !== undefined) {
          this.enqueue(g, h.key, u, when, when + FIDGET_SWING);
          this.slotLand[g] = when + FIDGET_SWING;
        }
        break;
      }
    }
  }

  /**
   * Cuts the current leg or dwell where it stands — a walk called back
   * midway. A swing in flight lets go where it is, and whatever had not set
   * out never will. Unlike `newPhase`, nothing left on the clock is run: the
   * grips the walk would have taken further along would all land, and light,
   * at once — threads it never reached lit up, and claws pinned far ahead.
   */
  private cut(): void {
    // A swing that set out has already let go of what it held.
    this.swings.length = 0;
    this.actions = [];
    this.next = 0;
    this.slotLand.fill(0);
    this.phases++;
  }

  /** Seconds a crossing of `length` takes: as it is told — seconds, or a pace — or as long as any leg that long. */
  private crossingDuration(
    length: number,
    crossing: number | CrossingPace | null | undefined,
  ): number {
    if (typeof crossing === 'number') return crossing > 0 ? crossing : this.legDuration(length);
    return crossing ? crossingTime(length, this.scale, crossing) : this.legDuration(length);
  }

  /**
   * How long a leg of `total` world units takes. A long leg goes faster, so
   * no walk takes more than 3.4 s — unless the space caps the pace. Then it
   * takes at least as long as cruising at that pace would: its average,
   * capped instead, let it cruise up to a third faster than the cap on a
   * short leg, the ramps being part of its time.
   */
  private legDuration(total: number): number {
    const brisk = Math.max(this.scale * 4.5, total / 3.4);
    return this.pace === null
      ? total / brisk
      : Math.max(total / brisk, pacedDuration(total, this.pace));
  }

  /** Sets out from the first note: reached at the start, facing the way it will go, and the first step begun. */
  private setOut(): void {
    if (this.here) {
      this.markReached(this.here.id, this.clock);
      this.headOut(this.here);
    }
    this.begin();
  }

  /**
   * The heading it starts with, which the first note's grips are planned
   * along. The brain's has always been +z, and still is: its first grips
   * never move. A space of its own faces the first note it walks to instead,
   * level with where it stands — or +z, failing a level way there.
   */
  private headOut(here: GraphNode): void {
    if (!this.injected) return;
    const at = this.where(here);
    if (!at) return;
    const up: Vec3 = [0, 1, 0];
    this.field.up(at, up);
    const next = this.plan?.steps.find(
      (s): s is Extract<CrawlStep, { kind: 'visit' }> =>
        s.kind === 'visit' && s.at.id !== here.id && this.where(this.node(s.at)) !== null,
    );
    const to = next ? this.where(this.node(next.at)) : null;
    const level = (v: Vec3): boolean => {
      const k = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
      const x = v[0] - k * up[0];
      const y = v[1] - k * up[1];
      const z = v[2] - k * up[2];
      const l = Math.hypot(x, y, z);
      if (!(l > 1e-6)) return false;
      this.dir[0] = x / l;
      this.dir[1] = y / l;
      this.dir[2] = z / l;
      return true;
    };
    if (to && level([to[0] - at[0], to[1] - at[1], to[2] - at[2]])) return;
    if (!level([0, 0, 1])) level([1, 0, 0]);
  }

  private step(): CrawlStep | null {
    return this.plan?.steps[this.stepIndex] ?? null;
  }

  /** Where the step after this dwell goes, when it moves at all. */
  private upcoming(): string | null {
    const next = this.plan?.steps[this.stepIndex + 1];
    if (!next || next.kind !== 'visit' || !this.here) return null;
    return next.at.id === this.here.id ? null : next.at.id;
  }

  /** Threads lit so far, as the current model's edges: `findWalk` prefers them. */
  private walkedEdges(model: GraphModel): Set<GraphEdge> {
    const walked = new Set<GraphEdge>();
    for (const e of model.edges) if (this.lit.has(threadKey(e.source, e.target))) walked.add(e);
    return walked;
  }

  /**
   * The current step's leg, starting at `start` on the replay clock — where
   * the pause before it ended — with `carry` seconds of it already gone.
   */
  private begin(start = this.clock, carry = 0): void {
    const st = this.step();
    const model = this.model;
    if (!st || !model || (!this.here && !this.perched)) return;
    this.newPhase();
    const phase: 0 | 1 | 2 = st.kind === 'finish' ? 2 : st.kind === 'visit' ? st.phase : 0;
    if (phase !== this.snap.phase)
      this.log(
        'done',
        'phase',
        ['read the prompt', 'follow links', 'hand over the context'][phase]!,
      );
    this.snap = { ...this.snap, phase, state: 'walking' };
    this.segments = [];
    this.target = null;
    this.crossing = false;
    this.touched = false;
    this.hold = 0;
    const perch = this.perched ? this.perch : null;
    if (perch && st.kind === 'visit') this.crossFromPerch(perch, this.node(st.at));
    else if (st.kind === 'visit' && this.here && st.at.id !== this.here.id) {
      const target = this.node(st.at);
      const path = this.injected
        ? this.fieldWalk(model, this.injected, this.here, target)
        : findWalk(model, this.here, target, this.walkedEdges(model));
      const nodes = path ?? [this.here, target];
      const stretches: LegSegment[] = [];
      for (let i = 0; i + 1 < nodes.length; i++) {
        const from = nodes[i]!;
        const to = nodes[i + 1]!;
        const edge = path
          ? (model.adjacency.get(from)?.find((nb) => nb.node === to && walkable(nb.edge))?.edge ??
            null)
          : null;
        stretches.push({
          fromId: from.id,
          toId: to.id,
          key: edge ? threadKey(from, to) : null,
          length: this.stretchLength(from, to, edge),
        });
      }
      // A note the layout has not placed yet (every note starts at NaN, and a
      // growth replay puts them back there) has no distance to walk: a leg of
      // NaN length never ends. It hops there instead, as a step that stays put.
      if (stretches.every((s) => Number.isFinite(s.length))) {
        this.segments = stretches;
        for (const s of stretches) if (!s.key) this.crossed.push(s);
        this.crossing = !path;
      }
      this.target = target;
      this.log(
        'walk',
        path ? 'walk' : 'spin silk',
        path ? `${this.segments.length} links` : 'no link joins them',
      );
    }
    this.ends = [];
    let total = 0;
    for (const s of this.segments) {
      total += s.length;
      this.ends.push(total);
    }
    this.total = total;
    this.k = 0;
    this.travelled = 0;
    this.duration =
      this.segments.length === 0
        ? EMPTY_WAIT
        : perch && this.crossing
          ? this.hold + this.crossingDuration(total, perch.crossing)
          : this.legDuration(total);
    this.t = carry;
    this.phaseStart = start;
    this.mode = 'walk';
    // When it reaches the end of each stretch, from the leg's own profile: the
    // history is stamped with these, never with the frame that saw it happen.
    const last = this.segments.length - 1;
    this.leaves = this.ends.map((end, k) => (k === last ? this.duration : this.timeAt(end)));
    if (this.segments.length > 0) {
      this.light(this.segments[0]!.key, 1.2, 'walk');
      this.pass(0);
    }
    this.push({
      kind: 'begin',
      clock: this.phaseStart,
      stepIndex: this.stepIndex,
      nextId: this.target?.id ?? null,
    });
    if (this.crossing) this.letGo();
    else if (this.segments.length > 0) this.planWalk();
  }

  /**
   * The first leg from the perch: straight across the void to the crawl's
   * first note, from the spot it clings above, after holding still while its
   * claws let go. Not silk: nothing joins the frame to the vault, and the
   * trail draws none from it.
   */
  private crossFromPerch(perch: ReplayPerch, target: GraphNode): void {
    this.target = target;
    const from = this.perchPoint(perch);
    const to: Vec3 = [0, 0, 0];
    if (from && this.field.node(target.id, to)) {
      const length = Math.max(dist(from, to), 1e-6);
      this.segments = [{ fromId: perch.id, toId: target.id, key: null, length, from }];
      this.crossing = true;
      this.hold = Math.max(0, perch.release ?? 0);
    }
    this.log('walk', 'set out', 'across from the prompt');
  }

  /**
   * The leg's grips, all planned as it begins and put on its clock: each
   * lands — and lights — exactly where the planner put it along the leg.
   * Planned in one go, they all come from the layout as it was then, the same
   * moment `findWalk` chose the way; planned frame by frame, a layout still
   * moving would give each frame rate its own grips.
   */
  private planWalk(): void {
    const events = planWalkGrips({
      leg: this.segments,
      total: this.total,
      field: this.field,
      unit: this.scale,
      lit: new Set(this.lit.keys()),
      held: this.holds,
    });
    let s = Number.NaN;
    let land = 0;
    let duration = 0;
    for (const e of events) {
      if (e.s !== s) {
        s = e.s;
        land = this.timeAt(s);
        duration = swingDuration(this.scale, this.speedAt(land));
      }
      // Never before the slot's previous swing has landed.
      const start = Math.max(0, land - duration, this.slotLand[e.slot]!);
      this.slotLand[e.slot] = land;
      this.enqueue(e.slot, e.key, e.u, start, land);
    }
  }

  /** Setting out across the void, it lets go of everything, one tentacle after another. */
  private letGo(): void {
    let i = 0;
    for (let g = 0; g < this.holds.length; g++) {
      if (!this.holds[g]) continue;
      const start = 0.04 * i++;
      this.enqueue(g, null, 0, start, start + DEFAULT_GRIP.swingMax);
    }
  }

  /** A new leg or dwell: whatever was on the last one's clock has happened. */
  private newPhase(): void {
    this.flush();
    this.actions = [];
    this.next = 0;
    this.slotLand.fill(0);
    this.phases++;
  }

  /** A swing on this leg or dwell's clock, `start` and `land` in seconds into it. */
  private enqueue(
    slot: number,
    key: ThreadKey | null,
    u: number,
    start: number,
    land: number,
  ): void {
    const swing: Swing = {
      slot,
      from: null,
      to: key ? { key, u, since: this.phaseStart + land } : null,
      start: this.phaseStart + start,
      land: this.phaseStart + land,
    };
    this.insert({ time: start, land: false, swing });
    this.insert({ time: land, land: true, swing });
  }

  /** Keeps the clock in order; at the same instant, what was queued first goes first. */
  private insert(a: Action): void {
    let lo = this.next;
    let hi = this.actions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.actions[mid]!.time <= a.time) lo = mid + 1;
      else hi = mid;
    }
    this.actions.splice(lo, 0, a);
  }

  /** Every swing due by `t` seconds into the leg or dwell, in order. */
  private run(t: number): void {
    while (this.next < this.actions.length && this.actions[this.next]!.time <= t) {
      const a = this.actions[this.next++]!;
      const s = a.swing;
      if (!a.land) {
        const held = this.holds[s.slot] ?? null;
        s.from = held;
        if (held) this.push({ kind: 'release', clock: s.start, slot: s.slot, key: held.key });
        this.holds[s.slot] = null;
        this.swings.push(s);
        continue;
      }
      const i = this.swings.indexOf(s);
      if (i >= 0) this.swings.splice(i, 1);
      // A thread the graph stopped drawing mid-swing is not there to land on.
      if (!s.to || !this.field.has(s.to.key)) continue;
      this.holds[s.slot] = s.to;
      this.light(s.to.key, 1.5, 'walk');
      this.push({ kind: 'grip', clock: s.land, slot: s.slot, key: s.to.key, u: s.to.u });
    }
  }

  /** Whatever is still on the clock happens now: a new leg or dwell starts from settled grips. */
  private flush(): void {
    this.run(Infinity);
  }

  /** Distance along the leg `t` seconds in; a crossing that holds still first moves only after `hold`. */
  private progress(t: number): number {
    return this.crossing
      ? voidProgress(t - this.hold, this.total, this.duration - this.hold)
      : walkProgress(t, this.total, this.duration, walkRamp(this.duration));
  }

  /** Seconds into the leg when the cursor reaches `s`. */
  private timeAt(s: number): number {
    let lo = 0;
    let hi = this.duration;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.progress(mid) < s) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  private speedAt(t: number): number {
    const h = Math.max(1e-4, this.duration * 1e-3);
    const a = Math.max(0, t - h);
    const b = Math.min(this.duration, t + h);
    return b > a ? (this.progress(b) - this.progress(a)) / (b - a) : 0;
  }

  private walk(): void {
    if (this.segments.length > 0) {
      this.travelled = this.progress(this.t);
      while (this.k < this.segments.length - 1 && this.travelled >= this.ends[this.k]!) {
        this.markReached(this.segments[this.k]!.toId, this.phaseStart + this.leaves[this.k]!);
        this.k++;
        this.light(this.segments[this.k]!.key, 1.2, 'walk');
        this.pass(this.k);
      }
      legPoint(this.segments, this.travelled, this.field, this.voidSag, this.scratch, this.dir);
      this.run(this.t);
      if (
        this.crossing &&
        !this.touched &&
        this.t >= 0.2 * this.duration &&
        this.total - this.travelled <= CONTACT_REACH * this.scale
      )
        this.touch();
    }
    if (this.t >= this.duration) this.arrive();
  }

  private touch(): void {
    this.touched = true;
    const id = this.homing ? (this.perch?.id ?? null) : (this.target?.id ?? null);
    if (id) this.push({ kind: 'contact', clock: this.clock, nodeId: id });
  }

  private read(): void {
    if (this.restingNow) {
      this.fidget();
      this.run(this.t);
      return;
    }
    this.run(this.t);
    for (const r of this.reaching) {
      if (!r.applied && this.t >= r.at + REACH_TOUCH) this.reach(r);
      r.view.reached = this.t >= r.at + REACH_TOUCH;
    }
    if (this.t >= this.dwell && this.plan && this.stepIndex < this.plan.steps.length - 1) {
      this.stepIndex++;
      this.begin(this.phaseStart + this.dwell, this.t - this.dwell);
    }
  }

  private arrive(): void {
    // The leg ended at its duration exactly, however late in the frame that was.
    const end = this.phaseStart + this.duration;
    const carry = Math.max(0, this.t - this.duration);
    if (this.homing) {
      // Back on the perch: there is no step to read, only the frame to take hold of.
      if (!this.touched) this.touch();
      this.settleOnPerch(end, carry, false);
      this.emit();
      return;
    }
    const st = this.step();
    if (!st) return;
    this.newPhase();
    if (this.crossing && !this.touched) this.touch();
    if (this.target) {
      this.here = this.node(this.target);
      this.perched = false;
      this.markReached(this.here.id, end);
    }
    this.mode = 'dwell';
    this.t = carry;
    this.phaseStart = end;
    this.reaching = [];
    this.reachViews.length = 0;
    this.snap = { ...this.snap, state: 'reading' };
    if (st.kind === 'visit') {
      this.dwell = 0.9 + st.reach.length * 0.35;
      st.reach.forEach((r, i) =>
        this.addReach({ nodeId: r.node.id, point: null, kind: r.kind }, 0.1 + i * 0.33, r),
      );
    } else if (st.kind === 'ask') {
      this.dwell = 1.4;
      this.ask(st);
    } else {
      this.dwell = 0.2;
      this.mode = 'done';
      this.snap = { ...this.snap, state: 'done', phase: 2 };
      const n = this.found.size;
      this.log(
        'done',
        'done',
        `${n} ${n === 1 ? 'note' : 'notes'} · ${this.snap.asks.length} to ask`,
      );
      this.push({ kind: 'done', clock: end });
    }
    if (st.kind !== 'finish' && this.here) {
      this.push({ kind: 'arrive', clock: end, nodeId: this.here.id });
      const perch = planPerchGrips({
        hereId: this.here.id,
        forward: this.dir,
        field: this.field,
        unit: this.scale,
        lit: new Set(this.lit.keys()),
        held: this.holds,
      });
      for (const g of perch)
        this.enqueue(g.slot, g.key, g.u, Math.max(0, g.t - DEFAULT_GRIP.swingMax), g.t);
    }
    this.emit();
  }

  private addReach(
    view: Omit<Reach, 'start' | 'reached'>,
    at: number,
    found: PlannedReach | null,
  ): void {
    const full: Reach = { ...view, start: this.phaseStart + at, reached: false };
    this.reaching.push({ view: full, at, applied: found === null, found });
    this.reachViews.push(full);
  }

  /** A reference nothing settled: reach to the notes it could mean, or into the void. */
  private ask(st: Extract<CrawlStep, { kind: 'ask' }>): void {
    const here = (this.here && this.where(this.here)) ?? ([0, 0, 0] as Vec3);
    const up: Vec3 = [0, 1, 0];
    this.field.up(here, up);
    const text = `? ${st.term} · ${st.why}`;
    if (st.candidates.length > 0) {
      st.candidates.forEach((n, i) =>
        this.addReach({ nodeId: n.id, point: null, kind: 'ask' }, 0.1 + i * 0.3, null),
      );
      const u = this.scale * 0.8;
      this.labelList.push({
        nodeId: null,
        point: [here[0] + up[0] * u, here[1] + up[1] * u, here[2] + up[2] * u],
        text,
        kind: 'ask',
        born: this.clock,
      });
    } else {
      const out = this.outward(here, up);
      const k = this.scale * 3;
      const h = this.scale * 1.4;
      const point: Vec3 = [
        here[0] + out[0] * k + up[0] * h,
        here[1] + out[1] * k + up[1] * h,
        here[2] + out[2] * k + up[2] * h,
      ];
      this.addReach({ nodeId: null, point, kind: 'ask' }, 0.1, null);
      this.labelList.push({ nodeId: null, point, text, kind: 'ask', born: this.clock });
    }
    this.snap = { ...this.snap, asks: [...this.snap.asks, { term: st.term, why: st.why }] };
    this.log('ask', 'ask', st.term);
  }

  /**
   * Level and away from the middle of the vault's own notes, as drawn: the
   * void is outside the brain, wherever the brain happens to sit.
   */
  private outward(here: Vec3, up: Vec3): Vec3 {
    const c: Vec3 = [0, 0, 0];
    const p: Vec3 = [0, 0, 0];
    let n = 0;
    for (const node of this.model?.nodes ?? []) {
      if (node.kind !== 'note' || node.foreign || !this.field.node(node.id, p)) continue;
      c[0] += p[0];
      c[1] += p[1];
      c[2] += p[2];
      n++;
    }
    if (n > 0) for (let i = 0; i < 3; i++) c[i]! /= n;
    const level = (v: Vec3): Vec3 | null => {
      const k = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
      const x = v[0] - k * up[0];
      const y = v[1] - k * up[1];
      const z = v[2] - k * up[2];
      const l = Math.hypot(x, y, z);
      return l > 1e-6 ? [x / l, y / l, z / l] : null;
    };
    return (
      level([here[0] - c[0], here[1] - c[1], here[2] - c[2]]) ??
      level(this.dir) ??
      level([1, 0, 0]) ?? [0, 0, 1]
    );
  }

  private reach(r: Reaching): void {
    r.applied = true;
    const f = r.found;
    if (!f || this.found.has(f.node.id)) return;
    // When it touched, on the dwell's own clock: the frame that noticed may be later.
    const touched = this.phaseStart + r.at + REACH_TOUCH;
    this.found.set(f.node.id, f.kind);
    this.foundAt.set(f.node.id, touched);
    if (f.kind !== 'named' && this.here) {
      // Whatever joins them, link or not, is the thread it reached along —
      // even one the space draws no line for, which whatever draws the
      // passage has to allow for.
      const nb = this.model?.adjacency.get(this.here)?.find((x) => x.node.id === f.node.id);
      if (nb) {
        const key = threadKey(this.here, nb.node);
        this.light(key, 1.6, f.kind);
        this.passages.push({
          key,
          fromId: this.here.id,
          toId: f.node.id,
          enter: this.phaseStart + r.at,
          leave: touched,
          kind: f.kind,
        });
      }
    }
    this.labelList.push({
      nodeId: f.node.id,
      point: null,
      text: f.label,
      kind: f.kind,
      born: this.clock,
    });
    const found = { ...this.snap.found };
    found[f.kind]++;
    this.snap = { ...this.snap, found, reached: [...this.snap.reached, nodePlace(f.node)] };
    this.log(
      f.kind,
      f.kind === 'named' ? 'read' : f.kind === 'linked' ? 'link' : 'decision',
      f.node.label,
    );
    this.push({ kind: 'found', clock: touched, nodeId: f.node.id, reachKind: f.kind });
  }

  /** A note reached by the walk, the first time only. */
  private markReached(id: string, clock: number): void {
    if (!this.reachedAt.has(id)) this.reachedAt.set(id, clock);
  }

  /** The current leg sets out along stretch `k`: a passage, when there is a thread to go along. */
  private pass(k: number): void {
    const s = this.segments[k];
    if (!s?.key) return;
    this.passages.push({
      key: s.key,
      fromId: s.fromId,
      toId: s.toId,
      enter: this.phaseStart + (k > 0 ? this.leaves[k - 1]! : 0),
      leave: this.phaseStart + this.leaves[k]!,
      kind: 'walk',
    });
  }

  private light(key: ThreadKey | null, glow: number, kind: Lit['kind']): void {
    // The perch's rails are held, never lit: they are no thread of the vault.
    if (!key || this.perch?.keys.has(key)) return;
    const l = this.lit.get(key) ?? { glow: 0, floor: 0, kind: 'walk' as Lit['kind'] };
    l.glow = Math.max(l.glow, glow);
    l.floor = Math.max(l.floor, kind === 'walk' ? 0.32 : 0.9);
    if (kind !== 'walk') l.kind = kind;
    const isNew = !this.lit.has(key);
    this.lit.set(key, l);
    if (isNew) {
      this.snap = { ...this.snap, threads: this.lit.size };
      this.emit();
    }
  }

  /** Where the walk is: on its thread, on the silk across the void, on its note, or on its perch. */
  private cursorPoint(): Vec3 | null {
    if (
      this.mode === 'walk' &&
      this.segments.length > 0 &&
      legPoint(this.segments, this.travelled, this.field, this.voidSag, this.scratch)
    )
      return this.scratch;
    if (this.perched && this.perch) return this.perchPoint(this.perch);
    return this.here ? this.where(this.here) : null;
  }

  private push(e: ReplayEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // -- Panel ---------------------------------------------------------------------

  private log(kind: CrawlSnapshot['log'][number]['kind'], verb: string, text: string): void {
    this.snap = {
      ...this.snap,
      log: [{ t: this.clock, kind, verb, text }, ...this.snap.log].slice(0, 40),
    };
    this.emit();
  }

  private emit(): void {
    this.onChange(this.snap);
  }
}
