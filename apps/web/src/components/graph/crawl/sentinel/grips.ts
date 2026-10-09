// Where the Sentinel takes hold of the threads around it, and when it lets go.
//
// Grips are simulation, not drawing: a grip that lands lights its thread, so
// the threads a crawl lights must not depend on the frame rate, on whether the
// creature is drawn at all, or on how many tentacles a quality tier draws. So
// grips are planned here by distance along the walk, a whole leg at once as it
// begins, each event from the ones before it and the threads as they were
// then — never from where the creature happens to be drawn — and per grip
// slot, never per tentacle: six slots, three a side (front, middle, rear),
// each served by one gripper of the crown.
//
// A walk is cut into events every sixth of `holdSpan`, the sides taking turns.
// On its side's turn the slot furthest behind is reconsidered: a grip left
// behind lets go, an empty slot takes hold, and a held grip moves only for a
// thread that is clearly better (hysteresis) — tentacles that flicker between
// two near-equal threads read as indecision, not as a creature. A grip torn
// past its reach lets go whenever that happens, on either side.
//
// Candidates are the threads within two hops of the stretch being walked at
// each event — a local window, never every thread of the leg at once: on a
// long leg through a hub the naive version cost milliseconds in one frame.
// Most are then rejected cheaply by their chord, bent as far as the brain's
// curve can bend, before the exact closest point.
//
// A field that knows what lies near a point (`nearby`, a spatial hash over a
// space's pipes) answers that question itself, exactly: the threads drawn
// within reach of a slot's spot. That replaces both the window and the chord
// test, which assumed the brain's gentle curve and dropped a pipe whose elbow
// came near while its ends were far. A thread found that way is planned like
// any other, linked to the walk or not.
//
// Pure: no three, no document. Distances in parameters are in creature units
// (the vault's typical link), positions in world units.

import type { Hold } from '../replay-view';
import { legPoint, type LegStretch, type ThreadField, type ThreadKey } from '../threads';
import type { Vec3 } from '../vec';

import { BODY_SCALE, GRIP_SLOTS, HOVER, SLOT_TENTACLE, TENTACLE_SPECS } from './anatomy';

export interface GripParams {
  /** Distance over which all six slots take a fresh hold once, in units: an event every sixth of it. */
  holdSpan: number;
  /** How far from its slot's natural spot a grip may land, in units. */
  reach: number;
  /** How far from its socket a new grip may land, in units. */
  maxFromAnchor: number;
  /** A grip pulled further than this from its socket tears loose, in units. */
  overstretch: number;
  /** A grip this far behind the body lets go on its slot's turn, in units. */
  behind: number;
  /** A new grip is never taken further behind the body than this, in units. */
  takeBehind: number;
  /** A held grip moves only to one that costs at least this much less. */
  hysteresis: number;
  /** Grips kept on each side while walking, when there are threads to hold. */
  minPerSide: number;
  /** Where along a thread a grip may land: never on the note dots at its ends. */
  uMin: number;
  uMax: number;
  /** How far, in threads, around the stretch being walked a grip looks for candidates. */
  candidateHops: 1 | 2;
  /** At most this many candidate threads per stretch: bounds an index note's fan. */
  maxCandidates: number;
  /** Seconds a tentacle takes to swing to its next hold, at least and at most. */
  swingMin: number;
  swingMax: number;
}

/** A gripper fully telescoped, socket to claw, in units: no grip may ask more of it. */
const GRIPPER = TENTACLE_SPECS[SLOT_TENTACLE[0]!]!;
const GRIPPER_REACH = GRIPPER.length * GRIPPER.maxStretch;

export const DEFAULT_GRIP: GripParams = {
  holdSpan: 2.0,
  reach: 0.93,
  // From the gripper's own reach (anatomy.ts), not a round number: a grip
  // planned past it leaves the claw short of the thread it lights. New grips
  // keep some slack for the body trailing the cursor they are planned from.
  maxFromAnchor: 0.92 * GRIPPER_REACH,
  overstretch: GRIPPER_REACH,
  behind: 0.8,
  takeBehind: 0.2,
  // Tuned in the lab: a held thread is kept unless the next one is clearly better, so grips hold longer.
  hysteresis: 0.41,
  minPerSide: 2,
  uMin: 0.08,
  uMax: 0.92,
  candidateHops: 2,
  maxCandidates: 120,
  swingMin: 0.08,
  swingMax: 0.18,
};

/** A slot takes hold of a thread — or lets go, `key` null — `s` world units into the leg. */
export interface GripEvent {
  s: number;
  slot: number;
  key: ThreadKey | null;
  /** Along the thread, from its key's first id. */
  u: number;
}

/** A slot takes hold — or lets go, `key` null — `t` seconds into a dwell. */
export interface PerchGrip {
  t: number;
  slot: number;
  key: ThreadKey | null;
  u: number;
}

/**
 * Where the body perches over a note it reads, in units: this far above it
 * and this far behind, so the eye looks at it instead of covering it. The
 * body (body.ts, through DEFAULT_MOTION) perches at the same spot, or the
 * grips planned here would be measured from somewhere it is not.
 */
export const PERCH_UP = 0.5;
export const PERCH_BACK = 0.6;

/** When the i-th perch grip lands: all six well inside the shortest dwell (0.9 s). */
export const perchTime = (i: number): number => 0.06 + 0.07 * i;

/** Seconds a swing takes at `speed` world units a second: about the time the body takes to cover 0.8 units. */
export function swingDuration(
  unit: number,
  speed: number,
  params: Partial<GripParams> = {},
): number {
  const p = { ...DEFAULT_GRIP, ...params };
  const t = speed > 1e-9 ? (0.8 * unit) / speed : p.swingMax;
  return Math.max(p.swingMin, Math.min(p.swingMax, t));
}

// Cost weights (design-motion §3): distance to the natural spot dominates; the
// rest break ties the way a body would.
const AXIS_WEIGHT = 0.6;
const CROWD_WEIGHT = 1.5;
/** Grips closer than this to another, in units, crowd each other. */
const CROWD_RADIUS = 0.35;
const REGRIP_PENALTY = 0.4;
const LIT_BONUS = 0.15;
/** Keys a slot remembers letting go of: it is slow to take them straight back. */
const MEMORY = 2;

/** Left front, right front, left middle, …: grips around a perch land alternating sides. */
const PERCH_ORDER: readonly number[] = [0, 3, 1, 4, 2, 5];

/**
 * A thread worth a closer look. The drawn curve is its chord bent sideways by
 * at most `bow` (a quadratic's offset from its chord peaks at the middle), so
 * the distance to the chord, less `bow`, rejects most threads cheaply before
 * the exact closest point.
 */
interface Candidate {
  key: ThreadKey;
  a: Vec3;
  b: Vec3;
  bow: number;
}

interface Grip {
  key: ThreadKey;
  u: number;
  /** Where it holds, world space: threads do not move while a leg is planned. */
  q: Vec3;
}

interface Choice extends Grip {
  cost: number;
}

type Status = 'empty' | 'gone' | 'walked' | 'over' | 'behind' | 'ok';

const isHard = (s: Status) => s === 'gone' || s === 'walked' || s === 'over';

const ORIGIN: Vec3 = [0, 0, 0];

function d2(a: Vec3, b: Vec3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

/** Distance from `q` to the segment from `a` to `b`. */
function segmentDistance(q: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby + (q[2] - a[2]) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + abx * t - q[0], a[1] + aby * t - q[1], a[2] + abz * t - q[2]);
}

/** The planning state of the six slots, and the body frame they are measured against. */
class Planner {
  readonly holds: (Grip | null)[];
  private readonly released: ThreadKey[][] = GRIP_SLOTS.map(() => []);
  private readonly anchors: Vec3[] = GRIP_SLOTS.map(() => [0, 0, 0]);
  private readonly axes: Vec3[] = GRIP_SLOTS.map(() => [0, 0, 1]);
  private readonly naturals: Vec3[] = GRIP_SLOTS.map(() => [0, 0, 0]);
  private readonly body: Vec3 = [0, 0, 0];
  private readonly fwd: Vec3 = [0, 0, 1];
  private readonly up: Vec3 = [0, 1, 0];
  private readonly right: Vec3 = [1, 0, 0];
  private readonly windows = new Map<string, Candidate[]>();
  private readonly threads = new Map<ThreadKey, Candidate | null>();

  constructor(
    private readonly field: ThreadField,
    private readonly unit: number,
    private readonly p: GripParams,
    private readonly lit: ReadonlySet<ThreadKey>,
    held: readonly (Hold | null)[],
  ) {
    this.holds = GRIP_SLOTS.map((_, i) => {
      const h = held[i];
      if (!h) return null;
      const q: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
      // A thread gone since it was taken keeps a NaN point: `status` lets it go.
      field.point(h.key, h.u, q);
      return { key: h.key, u: h.u, q };
    });
  }

  /**
   * Places the body over `at` — a point on a thread, or a note — heading along
   * `forward`: it floats `lift` units above along the field's up and sits
   * `back` units behind. The slots' sockets and natural spots follow it, in
   * the body's frame: the field's up squared to the heading.
   */
  setFrame(at: Vec3, forward: Vec3, lift: number, back: number): void {
    const f = this.fwd;
    const l = Math.hypot(forward[0], forward[1], forward[2]);
    if (l > 1e-9) {
      f[0] = forward[0] / l;
      f[1] = forward[1] / l;
      f[2] = forward[2] / l;
    }
    const up: Vec3 = [0, 1, 0];
    this.field.up(at, up);
    let k = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
    let ux = up[0] - k * f[0];
    let uy = up[1] - k * f[1];
    let uz = up[2] - k * f[2];
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 0.1) {
      // The thread runs along up: keep the last up, squared to the new heading.
      const prev = this.up;
      k = prev[0] * f[0] + prev[1] * f[1] + prev[2] * f[2];
      ux = prev[0] - k * f[0];
      uy = prev[1] - k * f[1];
      uz = prev[2] - k * f[2];
      ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) {
        // No usable up at all: any direction square to the heading will do.
        const a: Vec3 = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
        k = a[0] * f[0] + a[1] * f[1] + a[2] * f[2];
        ux = a[0] - k * f[0];
        uy = a[1] - k * f[1];
        uz = a[2] - k * f[2];
        ul = Math.hypot(ux, uy, uz);
      }
    }
    const u = this.up;
    u[0] = ux / ul;
    u[1] = uy / ul;
    u[2] = uz / ul;
    // Right = up × forward, the body frame's x.
    const r = this.right;
    r[0] = u[1] * f[2] - u[2] * f[1];
    r[1] = u[2] * f[0] - u[0] * f[2];
    r[2] = u[0] * f[1] - u[1] * f[0];
    // The body itself floats along the field's own up and backs off level, as
    // body.ts places it; only its axes are squared to the heading.
    const fu = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
    const level: Vec3 = [f[0] - fu * up[0], f[1] - fu * up[1], f[2] - fu * up[2]];
    const ll = Math.hypot(level[0], level[1], level[2]);
    for (let i = 0; i < 3; i++) level[i] = ll > 1e-6 ? level[i]! / ll : f[i]!;
    const h = lift * this.unit;
    const b = back * this.unit;
    for (let i = 0; i < 3; i++) this.body[i] = at[i]! + up[i]! * h - level[i]! * b;
    for (let g = 0; g < GRIP_SLOTS.length; g++) {
      const spec = TENTACLE_SPECS[SLOT_TENTACLE[g]!]!;
      // Where the drawn body puts the socket: the hull and its collar are scaled, the crown is not.
      this.toWorld(spec.socket, this.anchors[g]!, this.unit * BODY_SCALE, this.body);
      this.toWorld(spec.axis, this.axes[g]!, 1, ORIGIN);
      this.toWorld(GRIP_SLOTS[g]!.natural, this.naturals[g]!, this.unit, this.body);
    }
  }

  /** A body-frame vector `v`, scaled by `k` and moved to `o`, in world space. */
  private toWorld(v: Vec3, out: Vec3, k: number, o: Vec3): void {
    for (let i = 0; i < 3; i++) {
      out[i] = o[i]! + (this.right[i]! * v[0] + this.up[i]! * v[1] + this.fwd[i]! * v[2]) * k;
    }
  }

  /** How far ahead of the body a point is, along its heading. */
  private ahead(q: Vec3): number {
    const b = this.body;
    const f = this.fwd;
    return (q[0] - b[0]) * f[0] + (q[1] - b[1]) * f[1] + (q[2] - b[2]) * f[2];
  }

  status(slot: number, walked: ThreadKey | null, walking: boolean): Status {
    const h = this.holds[slot];
    if (!h) return 'empty';
    // Threads do not move or vanish while a leg is planned: a hold whose
    // thread was gone at the start has had a NaN point since.
    if (!Number.isFinite(h.q[0] + h.q[1] + h.q[2])) return 'gone';
    if (walking && h.key === walked) return 'walked';
    const over = this.p.overstretch * this.unit;
    if (d2(h.q, this.anchors[slot]!) > over * over) return 'over';
    if (walking && this.ahead(h.q) < -this.p.behind * this.unit) return 'behind';
    return 'ok';
  }

  /** How far behind the body a held grip is: the more behind, the sooner its turn. */
  aheadOf(slot: number): number {
    const h = this.holds[slot];
    return h ? this.ahead(h.q) : Infinity;
  }

  /**
   * Threads around these notes that can be held: the local window an event
   * looks in. Empty over a field that has `nearby`, which `reachable` asks
   * instead.
   */
  window(ids: readonly string[]): Candidate[] {
    if (this.field.nearby) return [];
    const id = ids.join('\u0000');
    const hit = this.windows.get(id);
    if (hit) return hit;
    const out: Candidate[] = [];
    for (const key of this.field.around(ids, this.p.candidateHops, this.p.maxCandidates)) {
      const c = this.candidate(key);
      if (c) out.push(c);
    }
    this.windows.set(id, out);
    return out;
  }

  /** A thread's chord and bow, measured once per plan: neighbouring stretches share most of their window. */
  private candidate(key: ThreadKey): Candidate | null {
    const known = this.threads.get(key);
    if (known !== undefined) return known;
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    const m: Vec3 = [0, 0, 0];
    let c: Candidate | null = null;
    if (
      this.field.point(key, 0, a) &&
      this.field.point(key, 1, b) &&
      this.field.point(key, 0.5, m)
    ) {
      const bow = Math.hypot(
        m[0] - (a[0] + b[0]) / 2,
        m[1] - (a[1] + b[1]) / 2,
        m[2] - (a[2] + b[2]) / 2,
      );
      if (Number.isFinite(bow + a[0] + a[1] + a[2] + b[0] + b[1] + b[2])) c = { key, a, b, bow };
    }
    this.threads.set(key, c);
    return c;
  }

  /**
   * The threads that may come within `reach` of a slot's spot, worth the
   * exact closest point: what the field finds near it when it can, else the
   * window's threads whose bent chord comes that close.
   */
  private reachable(
    natural: Vec3,
    reach: number,
    window: readonly Candidate[],
  ): readonly ThreadKey[] {
    if (this.field.nearby) return this.field.nearby(natural, reach, this.p.maxCandidates);
    const out: ThreadKey[] = [];
    for (const c of window) {
      if (segmentDistance(natural, c.a, c.b) - c.bow <= reach) out.push(c.key);
    }
    return out;
  }

  private cost(slot: number, key: ThreadKey, q: Vec3, holding: boolean): number {
    const reach = this.p.reach * this.unit;
    const anchor = this.anchors[slot]!;
    const axis = this.axes[slot]!;
    let cost = d2(q, this.naturals[slot]!) / (reach * reach);
    const dx = q[0] - anchor[0];
    const dy = q[1] - anchor[1];
    const dz = q[2] - anchor[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    cost += AXIS_WEIGHT * (1 - (axis[0] * dx + axis[1] * dy + axis[2] * dz) / dl);
    const crowd = CROWD_RADIUS * this.unit;
    for (let k = 0; k < this.holds.length; k++) {
      const other = this.holds[k];
      // A hold on a thread that is gone has a NaN point: it crowds nothing, and
      // a NaN cost would make every comparison with it false.
      if (k === slot || !other || !Number.isFinite(other.q[0])) continue;
      cost += CROWD_WEIGHT * Math.max(0, 1 - Math.sqrt(d2(q, other.q)) / crowd);
    }
    if (!holding && this.released[slot]!.includes(key)) cost += REGRIP_PENALTY;
    if (this.lit.has(key)) cost -= LIT_BONUS;
    return cost;
  }

  /** What the slot's current grip costs, where it is now. */
  costHeld(slot: number): number {
    const h = this.holds[slot];
    return h ? this.cost(slot, h.key, h.q, true) : Infinity;
  }

  /** The cheapest thread a slot can take now, within the hard limits; null when none is in reach. */
  best(
    slot: number,
    candidates: readonly Candidate[],
    walking: boolean,
    walked: ThreadKey | null,
  ): Choice | null {
    const p = this.p;
    const reach = p.reach * this.unit;
    const fromAnchor = p.maxFromAnchor * this.unit;
    const natural = this.naturals[slot]!;
    const anchor = this.anchors[slot]!;
    // Walking, a slot looks no further back than a new grip may land: a rear
    // slot's own spot is behind that line, and the point of a thread closest
    // to it would be refused every time.
    let probe = natural;
    const behind = this.ahead(natural) + p.takeBehind * this.unit;
    if (walking && behind < 0) {
      const f = this.fwd;
      probe = [natural[0] - f[0] * behind, natural[1] - f[1] * behind, natural[2] - f[2] * behind];
    }
    let best: Choice | null = null;
    for (const key of this.reachable(natural, reach, candidates)) {
      if (key === walked) continue;
      const hit = this.field.closest(key, probe, p.uMin, p.uMax);
      if (!hit || d2(hit.p, natural) > reach * reach) continue;
      const q = hit.p;
      if (d2(q, anchor) > fromAnchor * fromAnchor) continue;
      if (walking && this.ahead(q) < -p.takeBehind * this.unit) continue;
      const cost = this.cost(slot, key, q, false);
      if (!best || cost < best.cost) best = { key, u: hit.u, q, cost };
    }
    return best;
  }

  /** Moves a slot to a new grip, or lets it go: false when that changes nothing. */
  set(slot: number, next: Grip | null): boolean {
    const cur = this.holds[slot] ?? null;
    if (!cur && !next) return false;
    if (cur && next && cur.key === next.key && Math.abs(cur.u - next.u) < 1e-9) return false;
    const memory = this.released[slot]!;
    if (cur) {
      memory.push(cur.key);
      if (memory.length > MEMORY) memory.shift();
    }
    this.holds[slot] = next ? { key: next.key, u: next.u, q: next.q } : null;
    return true;
  }

  heldOn(side: -1 | 1): number {
    let n = 0;
    for (let g = 0; g < GRIP_SLOTS.length; g++)
      if (GRIP_SLOTS[g]!.side === side && this.holds[g]) n++;
    return n;
  }
}

/** Which stretch of a leg a cursor `s` is on. */
function stretchAt(leg: readonly LegStretch[], s: number): number {
  let k = 0;
  let d = s;
  while (k < leg.length - 1 && d > leg[k]!.length) {
    d -= leg[k]!.length;
    k++;
  }
  return k;
}

const PLACE_ORDER = { front: 0, mid: 1, rear: 2 } as const;

export interface WalkGripInput {
  leg: readonly LegStretch[];
  total: number;
  field: ThreadField;
  unit: number;
  lit: ReadonlySet<ThreadKey>;
  /** What each slot holds as the leg begins. */
  held: readonly (Hold | null)[];
  params?: Partial<GripParams>;
}

/**
 * The grips of one walk along threads, planned one event at a time: when (by
 * distance along the leg) each slot takes hold of which thread, and when it
 * lets go. Each event depends only on the ones before it.
 */
class WalkGrips {
  /** Where each event falls, world units into the leg. */
  readonly positions: readonly number[];
  private readonly plan: Planner;
  private readonly p: GripParams;
  private readonly first: -1 | 1;
  private readonly at: Vec3 = [0, 0, 0];
  private readonly heading: Vec3 = [0, 0, 1];
  private index = 0;

  constructor(private readonly input: WalkGripInput) {
    const { leg, total, field, unit, lit } = input;
    this.p = { ...DEFAULT_GRIP, ...input.params };
    this.plan = new Planner(field, unit, this.p, lit, input.held);
    const ok = leg.length > 0 && total > 0 && unit > 0;
    const spacing = (this.p.holdSpan * unit) / GRIP_SLOTS.length;
    const count = ok ? Math.max(1, Math.round(total / spacing)) : 0;
    this.positions = Array.from({ length: count }, (_, i) => ((i + 0.5) * total) / count);
    // The side holding less goes first.
    this.first = this.plan.heldOn(-1) <= this.plan.heldOn(1) ? -1 : 1;
  }

  get done(): boolean {
    return this.index >= this.positions.length;
  }

  /** Plans the next event position: what lands and lets go there, often nothing. */
  next(): GripEvent[] {
    const i = this.index++;
    const s = this.positions[i];
    if (s === undefined) return [];
    const { leg, field } = this.input;
    const plan = this.plan;
    const p = this.p;
    const side: -1 | 1 = i % 2 === 0 ? this.first : this.first === -1 ? 1 : -1;
    if (!legPoint(leg, s, field, 0, this.at, this.heading)) return [];
    plan.setFrame(this.at, this.heading, HOVER, 0);
    const st = leg[stretchAt(leg, s)]!;
    const walked = st.key;
    const window = plan.window([st.fromId, st.toId]);
    const events: GripEvent[] = [];
    const emit = (slot: number, next: Choice | null) => {
      if (plan.set(slot, next)) events.push({ s, slot, key: next?.key ?? null, u: next?.u ?? 0 });
    };

    const status = GRIP_SLOTS.map((_, g) => plan.status(g, walked, true));
    // What cannot stay goes now: on the other side it only lets go — the
    // sides take turns to grip — and on this side it takes the best it can.
    for (let g = 0; g < GRIP_SLOTS.length; g++) {
      if (!isHard(status[g]!)) continue;
      emit(g, GRIP_SLOTS[g]!.side === side ? plan.best(g, window, true, walked) : null);
    }

    // This side's turn: grips left behind first, then empty slots from the
    // front, then the held grip furthest back.
    const mine = GRIP_SLOTS.map((_, g) => g).filter(
      (g) => GRIP_SLOTS[g]!.side === side && !isHard(status[g]!),
    );
    const behind = mine
      .filter((g) => status[g] === 'behind')
      .sort((a, b) => plan.aheadOf(a) - plan.aheadOf(b));
    const empty = mine
      .filter((g) => status[g] === 'empty')
      .sort((a, b) => PLACE_ORDER[GRIP_SLOTS[a]!.place] - PLACE_ORDER[GRIP_SLOTS[b]!.place]);
    const held = mine
      .filter((g) => status[g] === 'ok')
      .sort((a, b) => plan.aheadOf(a) - plan.aheadOf(b));

    let acted = false;
    for (const g of behind) {
      const next = plan.best(g, window, true, walked);
      if (next) {
        emit(g, next);
        acted = true;
        break;
      }
      // Nothing to take instead: let go only if the side keeps enough grips.
      if (plan.heldOn(side) - 1 >= p.minPerSide) {
        emit(g, null);
        acted = true;
        break;
      }
    }
    for (const g of acted ? [] : empty) {
      const next = plan.best(g, window, true, walked);
      if (next) {
        emit(g, next);
        acted = true;
        break;
      }
    }
    const last = held[0];
    if (!acted && last !== undefined) {
      const next = plan.best(last, window, true, walked);
      if (next && plan.costHeld(last) - next.cost > p.hysteresis) emit(last, next);
    }
    return events;
  }
}

/**
 * Every grip of a walk along threads, planned in one go, on the threads as
 * they are now: a millisecond or two on a long leg through a hub, in the same
 * frame as the search for the way that costs ten times that.
 */
export function planWalkGrips(input: WalkGripInput): GripEvent[] {
  const grips = new WalkGrips(input);
  const out: GripEvent[] = [];
  while (!grips.done) out.push(...grips.next());
  return out;
}

/**
 * Grips around a note the Sentinel has walked to, landing one after another
 * while it reads. `forward` is the heading it arrived with; the body perches
 * above and behind the note.
 */
export function planPerchGrips(input: {
  hereId: string;
  forward: Vec3;
  field: ThreadField;
  unit: number;
  lit: ReadonlySet<ThreadKey>;
  held: readonly (Hold | null)[];
  params?: Partial<GripParams>;
}): PerchGrip[] {
  const { hereId, field, unit, lit } = input;
  const p: GripParams = { ...DEFAULT_GRIP, ...input.params };
  const note: Vec3 = [0, 0, 0];
  if (!(unit > 0) || !field.node(hereId, note)) return [];
  const plan = new Planner(field, unit, p, lit, input.held);
  plan.setFrame(note, input.forward, PERCH_UP, PERCH_BACK);
  const window = plan.window([hereId]);
  const out: PerchGrip[] = [];
  for (const g of PERCH_ORDER) {
    const status = plan.status(g, null, false);
    const next = plan.best(g, window, false, null);
    // A grip that can stay moves only for a clearly better one.
    if (status === 'ok' && (!next || plan.costHeld(g) - next.cost <= p.hysteresis)) continue;
    if (plan.set(g, next)) {
      out.push({ t: perchTime(out.length), slot: g, key: next?.key ?? null, u: next?.u ?? 0 });
    }
  }
  return out;
}
