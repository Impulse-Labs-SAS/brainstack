// The Crawl view's replay: a spider walking the brain's own threads.
//
// It plugs into the graph controller as a GraphPlugin — drawn over the overlay,
// asking the camera to follow it — and touches nothing the other views draw.
// Everything is in world units scaled by the vault's typical link length, so
// the spider is the same size against its threads in a vault of ten notes or
// ten thousand.
//
// The body and legs are computed in 3D and drawn in 2D, with thick strokes:
// WebGL lines are one pixel wide, and a spider one pixel wide reads as any bug.

import { projector, type Viewport } from '@/lib/graph-camera';
import type { GraphEdge, GraphModel, GraphNode } from '@/lib/graph-model';

import type { GraphPlugin, PluginFrame } from '../graph-controller';

import {
  findWalk,
  planCrawl,
  walkable,
  type CrawlPlan,
  type CrawlResult,
  type CrawlStep,
  type ReachKind,
} from './crawl-plan';

type Vec = [number, number, number];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec): Vec => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp = (a: Vec, b: Vec, t: number): Vec => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const dist = (a: Vec, b: Vec) => len(sub(a, b));
const UP: Vec = [0, 1, 0];

export const CRAWL_COLORS = {
  named: '#b8a6ff',
  linked: '#5eead4',
  decision: '#4ade80',
  ask: '#fbbf24',
  spider: '#5eead4',
  core: '#f472b6',
} as const;

/** Where a node is drawn, search lift included — the threads are drawn from there. */
function at(n: GraphNode): Vec {
  return [n.x + n.ox, n.y + n.oy, (n.z || 0) + n.oz];
}

/** A point on a thread: the same gentle curve graph-scene and graph-overlay draw. */
function onEdge(e: GraphEdge, t: number): Vec {
  const s = at(e.source);
  const g = at(e.target);
  const dx = g[0] - s[0];
  const dy = g[1] - s[1];
  const c: Vec = [(s[0] + g[0]) / 2 - dy * 0.1, (s[1] + g[1]) / 2 + dx * 0.1, (s[2] + g[2]) / 2];
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const z = t * t;
  return [
    a * s[0] + b * c[0] + z * g[0],
    a * s[1] + b * c[1] + z * g[1],
    a * s[2] + b * c[2] + z * g[2],
  ];
}

/** One stretch of a walk: along a thread, or on silk spun where no thread joins two notes. */
interface Segment {
  from: GraphNode;
  to: GraphNode;
  edge: GraphEdge | null;
  length: number;
}
function pointOn(seg: Segment, t: number, unit: number): Vec {
  if (seg.edge) return onEdge(seg.edge, seg.edge.source === seg.from ? t : 1 - t);
  // Silk sags a little under the spider's weight.
  const p = lerp(at(seg.from), at(seg.to), t);
  return add(p, mul(UP, -Math.sin(Math.PI * t) * unit * 0.6));
}
function lengthOf(seg: Omit<Segment, 'length'>, unit: number): number {
  let total = 0;
  let prev = pointOn({ ...seg, length: 0 }, 0, unit);
  for (let i = 1; i <= 8; i++) {
    const p = pointOn({ ...seg, length: 0 }, i / 8, unit);
    total += dist(prev, p);
    prev = p;
  }
  return Math.max(total, 1e-6);
}

interface Foot {
  side: -1 | 1;
  j: number;
  group: 0 | 1;
  planted: Vec;
  from: Vec;
  to: Vec;
  target: Vec;
  targetEdge: GraphEdge | null;
  edge: GraphEdge | null;
  stepT: number;
  hip: Vec;
  knee: Vec;
  foot: Vec;
}
const LEG_ANGLE = [0.5, 1.12, 1.9, 2.55];
const LEG_REACH = [1.0, 0.84, 0.84, 1.0];

interface Lit {
  glow: number;
  floor: number;
  kind: 'walk' | ReachKind;
}
interface Label {
  node: GraphNode | null;
  point: Vec | null;
  text: string;
  kind: ReachKind | 'ask';
  born: number;
}
interface Tentacle {
  node: GraphNode | null;
  point: Vec | null;
  kind: ReachKind | 'ask';
  at: number;
  applied: boolean;
  reach: { node: GraphNode; kind: ReachKind; label: string } | null;
}

/** What the panel shows, sent only when it changes. */
export interface CrawlSnapshot {
  state: 'idle' | 'walking' | 'reading' | 'done';
  phase: 0 | 1 | 2;
  log: Array<{ t: number; kind: ReachKind | 'ask' | 'walk' | 'done'; verb: string; text: string }>;
  found: { named: number; linked: number; decision: number };
  asks: Array<{ term: string; why: string }>;
  threads: number;
  coverage: { resolved: number; total: number } | null;
  offGraph: number;
  following: boolean;
}

export class CrawlLayer implements GraphPlugin {
  spiderOn = true;
  speed = 1;
  playing = true;

  private model: GraphModel | null = null;
  private plan: CrawlPlan | null = null;
  private unit = 1;
  private clock = 0;
  private stepIndex = 0;
  private mode: 'idle' | 'walk' | 'dwell' | 'done' = 'idle';
  private t = 0;
  private dwell = 1;
  private here: GraphNode | null = null;
  private segments: Segment[] = [];
  private k = 0;
  private f = 0;
  private travelled = 0;
  private total = 0;
  private walkSpeed = 1;
  private dir: Vec = [0, 0, 1];
  private body = { base: [0, 0, 0] as Vec, fwd: [0, 0, 1] as Vec, up: UP, side: [1, 0, 0] as Vec };
  private feet: Foot[] = [];
  private nextGroup: 0 | 1 = 0;
  private lit = new Map<GraphEdge, Lit>();
  private silk: Segment[] = [];
  private flashes: Array<{ p: Vec; t0: number }> = [];
  private labels: Label[] = [];
  private tentacles: Tentacle[] = [];
  private found = new Map<GraphNode, ReachKind>();
  private following = true;
  private snapshot: CrawlSnapshot = emptySnapshot();
  private fonts = { mono: 'ui-monospace, monospace' };

  constructor(
    private readonly onChange: (s: CrawlSnapshot) => void,
    private readonly reduceMotion: boolean,
  ) {
    const css = getComputedStyle(document.documentElement);
    this.fonts.mono = css.getPropertyValue('--font-mono').trim() || this.fonts.mono;
    for (const side of [-1, 1] as const) {
      for (let j = 0; j < 4; j++) {
        const z: Vec = [0, 0, 0];
        this.feet.push({
          side,
          j,
          group: ((j + (side > 0 ? 1 : 0)) % 2) as 0 | 1,
          planted: z,
          from: z,
          to: z,
          target: z,
          targetEdge: null,
          edge: null,
          stepT: -1,
          hip: z,
          knee: z,
          foot: z,
        });
      }
    }
  }

  // -- Loading -------------------------------------------------------------------

  /** Replay a crawl over this model. */
  load(result: CrawlResult, model: GraphModel): void {
    this.model = model;
    this.plan = planCrawl(result, model);
    this.unit = typicalLink(model);
    this.lit.clear();
    this.silk = [];
    this.flashes = [];
    this.labels = [];
    this.tentacles = [];
    this.found.clear();
    this.clock = 0;
    this.stepIndex = 0;
    this.following = true;
    this.snapshot = {
      ...emptySnapshot(),
      coverage: this.plan.coverage,
      offGraph: this.plan.offGraph,
      following: true,
    };
    const first = this.plan.steps.find(
      (s): s is Extract<CrawlStep, { kind: 'visit' }> => s.kind === 'visit',
    );
    this.here = first?.at ?? model.nodes.find((n) => n.kind === 'note' && !n.foreign) ?? null;
    if (!this.here) {
      this.mode = 'idle';
      this.emit();
      return;
    }
    this.body.base = at(this.here);
    for (const ft of this.feet) {
      ft.planted = this.body.base;
      ft.foot = this.body.base;
      ft.stepT = -1;
    }
    this.begin();
    if (this.reduceMotion) this.skipToEnd();
    this.emit();
  }

  clear(): void {
    this.plan = null;
    this.mode = 'idle';
    this.here = null;
    this.lit.clear();
    this.labels = [];
    this.found.clear();
    this.snapshot = emptySnapshot();
    this.emit();
  }

  replay(): void {
    const plan = this.plan;
    if (plan && this.model) {
      this.lit.clear();
      this.silk = [];
      this.flashes = [];
      this.labels = [];
      this.tentacles = [];
      this.found.clear();
      this.clock = 0;
      this.stepIndex = 0;
      this.following = true;
      this.snapshot = {
        ...emptySnapshot(),
        coverage: plan.coverage,
        offGraph: plan.offGraph,
        following: true,
      };
      const first = plan.steps.find(
        (s): s is Extract<CrawlStep, { kind: 'visit' }> => s.kind === 'visit',
      );
      if (first) this.here = first.at;
      this.begin();
      this.emit();
    }
  }

  skipToEnd(): void {
    let guard = 0;
    while (this.mode !== 'done' && this.mode !== 'idle' && guard++ < 20000) {
      this.update(0.05);
      this.updateFeet(0.05);
    }
  }

  follow(): { x: number; y: number; z: number; dist: number } | null {
    if (!this.following || this.mode === 'idle') return null;
    if (this.mode === 'done') {
      const pts = [...this.found.keys()].map(at);
      if (pts.length === 0) return null;
      const c = mul(pts.reduce(add, [0, 0, 0] as Vec), 1 / pts.length);
      const r = Math.max(...pts.map((p) => dist(p, c)));
      return { x: c[0], y: c[1], z: c[2], dist: r * 3 + this.unit * 8 };
    }
    const b = this.body.base;
    return { x: b[0], y: b[1], z: b[2], dist: this.unit * 12 };
  }

  onUserCamera(): void {
    if (!this.following) return;
    this.following = false;
    this.snapshot = { ...this.snapshot, following: false };
    this.emit();
  }

  followAgain(): void {
    this.following = true;
    this.snapshot = { ...this.snapshot, following: true };
    this.emit();
  }

  // -- The replay ----------------------------------------------------------------

  private step(): CrawlStep | null {
    return this.plan?.steps[this.stepIndex] ?? null;
  }

  private begin(): void {
    const st = this.step();
    const model = this.model;
    if (!st || !model || !this.here) return;
    const phase: 0 | 1 | 2 = st.kind === 'finish' ? 2 : st.kind === 'visit' ? st.phase : 0;
    if (phase !== this.snapshot.phase)
      this.log(
        'done',
        'phase',
        ['read the prompt', 'follow links', 'hand over the context'][phase]!,
      );
    this.snapshot = { ...this.snapshot, phase, state: 'walking' };
    this.segments = [];
    if (st.kind === 'visit' && st.at !== this.here) {
      const walked = new Set(this.lit.keys());
      const path = findWalk(model, this.here, st.at, walked);
      const nodes = path ?? [this.here, st.at];
      for (let i = 0; i + 1 < nodes.length; i++) {
        const from = nodes[i]!;
        const to = nodes[i + 1]!;
        const edge = path
          ? (model.adjacency.get(from)?.find((nb) => nb.node === to && walkable(nb.edge))?.edge ??
            null)
          : null;
        const seg = { from, to, edge };
        const full = { ...seg, length: lengthOf(seg, this.unit) };
        this.segments.push(full);
        if (!edge) this.silk.push(full);
      }
      this.log(
        'walk',
        path ? 'walk' : 'spin silk',
        path ? `${this.segments.length} links` : 'no link joins them',
      );
    }
    this.k = 0;
    this.f = 0;
    this.travelled = 0;
    this.total = this.segments.reduce((s, x) => s + x.length, 0);
    this.walkSpeed = Math.max(this.unit * 4.5, this.total / 3.4);
    this.t = 0;
    this.mode = 'walk';
    if (this.segments.length > 0) this.light(this.segments[0]!.edge, 1.2, 'walk');
  }

  private arrive(): void {
    const st = this.step();
    if (!st) return;
    if (this.segments.length > 0) this.here = this.segments[this.segments.length - 1]!.to;
    this.mode = 'dwell';
    this.t = 0;
    this.tentacles = [];
    this.snapshot = { ...this.snapshot, state: 'reading' };
    if (st.kind === 'visit') {
      this.dwell = 0.9 + st.reach.length * 0.35;
      st.reach.forEach((r, i) =>
        this.tentacles.push({
          node: r.node,
          point: null,
          kind: r.kind,
          at: 0.1 + i * 0.33,
          applied: false,
          reach: r,
        }),
      );
    } else if (st.kind === 'ask') {
      this.dwell = 1.4;
      const here = at(this.here!);
      if (st.candidates.length > 0) {
        st.candidates.forEach((n, i) =>
          this.tentacles.push({
            node: n,
            point: null,
            kind: 'ask',
            at: 0.1 + i * 0.3,
            applied: true,
            reach: null,
          }),
        );
        this.labels.push({
          node: null,
          point: add(here, mul(UP, this.unit * 0.8)),
          text: `? ${st.term} · ${st.why}`,
          kind: 'ask',
          born: this.clock,
        });
      } else {
        // Nothing to walk to: reach into the void, outwards from the brain.
        const out = norm(here[0] === 0 && here[2] === 0 ? [1, 0, 0] : [here[0], 0, here[2]]);
        const point = add(add(here, mul(out, this.unit * 3)), mul(UP, this.unit * 1.4));
        this.tentacles.push({
          node: null,
          point,
          kind: 'ask',
          at: 0.1,
          applied: true,
          reach: null,
        });
        this.labels.push({
          node: null,
          point,
          text: `? ${st.term} · ${st.why}`,
          kind: 'ask',
          born: this.clock,
        });
      }
      this.snapshot = {
        ...this.snapshot,
        asks: [...this.snapshot.asks, { term: st.term, why: st.why }],
      };
      this.log('ask', 'ask', st.term);
    } else {
      this.dwell = 0.2;
      this.mode = 'done';
      this.snapshot = { ...this.snapshot, state: 'done', phase: 2 };
      this.log('done', 'done', `${this.found.size} notes · ${this.snapshot.asks.length} to ask`);
    }
    this.emit();
  }

  private reach(tn: Tentacle): void {
    tn.applied = true;
    const r = tn.reach;
    if (!r || this.found.has(r.node)) return;
    this.found.set(r.node, r.kind);
    if (r.kind !== 'named' && this.here) {
      const edge =
        this.model?.adjacency.get(this.here)?.find((nb) => nb.node === r.node)?.edge ?? null;
      this.light(edge, 1.6, r.kind);
    }
    this.labels.push({ node: r.node, point: null, text: r.label, kind: r.kind, born: this.clock });
    const found = { ...this.snapshot.found };
    found[r.kind]++;
    this.snapshot = { ...this.snapshot, found };
    this.log(
      r.kind,
      r.kind === 'named' ? 'read' : r.kind === 'linked' ? 'link' : 'decision',
      r.node.label,
    );
  }

  private light(edge: GraphEdge | null, glow: number, kind: Lit['kind']): void {
    if (!edge) return;
    const l = this.lit.get(edge) ?? { glow: 0, floor: 0, kind: 'walk' as Lit['kind'] };
    l.glow = Math.max(l.glow, glow);
    l.floor = Math.max(l.floor, kind === 'walk' ? 0.32 : 0.9);
    if (kind !== 'walk') l.kind = kind;
    const isNew = !this.lit.has(edge);
    this.lit.set(edge, l);
    if (isNew) {
      this.snapshot = { ...this.snapshot, threads: this.lit.size };
      this.emit();
    }
  }

  private pathPoint(off: number): { p: Vec; seg: Segment | null } {
    if (this.segments.length === 0 || !this.here) return { p: at(this.here!), seg: null };
    let k = this.k;
    let d = this.f * this.segments[k]!.length + off;
    while (d < 0 && k > 0) {
      k--;
      d += this.segments[k]!.length;
    }
    while (d > this.segments[k]!.length && k < this.segments.length - 1) {
      d -= this.segments[k]!.length;
      k++;
    }
    const seg = this.segments[k]!;
    return { p: pointOn(seg, Math.max(0, Math.min(1, d / seg.length)), this.unit), seg };
  }

  private update(dt: number): void {
    this.clock += dt;
    for (const l of this.lit.values()) l.glow = Math.max(l.floor, l.glow - dt * 0.9);
    if (this.mode === 'done' || this.mode === 'idle') return;
    this.t += dt;
    if (this.mode === 'walk') {
      if (this.segments.length === 0) {
        if (this.t >= 0.5) this.arrive();
        return;
      }
      const move = dt * this.walkSpeed;
      this.travelled += move;
      this.f += move / this.segments[this.k]!.length;
      while (this.f >= 1 && this.k < this.segments.length - 1) {
        const left = (this.f - 1) * this.segments[this.k]!.length;
        this.k++;
        this.light(this.segments[this.k]!.edge, 1.2, 'walk');
        this.f = left / this.segments[this.k]!.length;
      }
      if (this.f > 1) this.f = 1;
      const seg = this.segments[this.k]!;
      const ahead = pointOn(seg, Math.min(1, this.f + 0.05), this.unit);
      const now = pointOn(seg, Math.max(0, this.f - 0.05), this.unit);
      if (dist(ahead, now) > 1e-6) this.dir = norm(sub(ahead, now));
      if (this.travelled >= this.total && this.k >= this.segments.length - 1) this.arrive();
    } else {
      for (const tn of this.tentacles) if (!tn.applied && this.t >= tn.at + 0.4) this.reach(tn);
      if (this.t >= this.dwell && this.plan && this.stepIndex < this.plan.steps.length - 1) {
        this.stepIndex++;
        this.begin();
      }
    }
  }

  // -- Body and legs ---------------------------------------------------------------

  private placeBody(dt: number): void {
    if (!this.here) return;
    const base =
      this.mode === 'walk' && this.segments.length > 0 ? this.pathPoint(0).p : at(this.here);
    const k = Math.min(1, dt * 8 + 0.02);
    const fwd = norm(lerp(this.body.fwd, this.dir, k));
    let side = cross(fwd, UP);
    if (len(side) < 1e-3) side = [1, 0, 0];
    side = norm(side);
    this.body = { base, fwd, side, up: norm(cross(side, fwd)) };
  }

  /** Threads a foot may hold: those around the note it stands on, or around both ends of the one it walks — but not that one. */
  private footholds(): GraphEdge[] {
    const model = this.model;
    if (!model || !this.here) return [];
    const walking = this.mode === 'walk' && this.segments.length > 0;
    const seg = walking ? this.segments[this.k]! : null;
    const around = seg ? [seg.from, seg.to] : [this.here];
    const set = new Set<GraphEdge>();
    for (const n of around) {
      for (const nb of model.adjacency.get(n) ?? []) {
        if (!walkable(nb.edge)) continue;
        set.add(nb.edge);
        for (const nb2 of model.adjacency.get(nb.node) ?? [])
          if (walkable(nb2.edge)) set.add(nb2.edge);
      }
    }
    if (seg?.edge) set.delete(seg.edge);
    return [...set];
  }

  private updateFeet(dt: number): void {
    const u = this.unit;
    const walking = this.mode === 'walk' && this.segments.length > 0;
    const holds = this.footholds();
    for (const ft of this.feet) {
      const a = LEG_ANGLE[ft.j]!;
      const r = LEG_REACH[ft.j]! * u;
      const natural = add(
        add(this.body.base, mul(this.body.fwd, Math.cos(a) * r)),
        mul(this.body.side, ft.side * Math.sin(a) * r),
      );
      let best: Vec | null = null;
      let bestEdge: GraphEdge | null = null;
      let bd = 0.4 * u;
      for (const e of holds) {
        for (let i = 0; i <= 12; i++) {
          const q = onEdge(e, i / 12);
          const d = dist(q, natural);
          if (d < bd) {
            bd = d;
            best = q;
            bestEdge = e;
          }
        }
      }
      ft.target = best ?? natural;
      ft.targetEdge = bestEdge;
    }
    // Four legs at a time, the two groups taking turns, the way a spider walks.
    if (!this.feet.some((ft) => ft.stepT >= 0)) {
      const reach = (walking ? 0.25 : 0.08) * u;
      for (let tries = 0; tries < 2; tries++) {
        const g = this.nextGroup;
        if (this.feet.some((ft) => ft.group === g && dist(ft.planted, ft.target) > reach)) {
          for (const ft of this.feet) if (ft.group === g) this.startStep(ft);
          this.nextGroup = (1 - g) as 0 | 1;
          break;
        }
        this.nextGroup = (1 - g) as 0 | 1;
      }
    }
    for (const ft of this.feet)
      if (ft.stepT < 0 && dist(ft.planted, this.body.base) > 1.45 * u) this.startStep(ft);

    const up = this.body.up;
    for (const ft of this.feet) {
      if (ft.stepT >= 0) {
        ft.stepT += dt / 0.09;
        const e = Math.min(1, ft.stepT);
        ft.foot = add(lerp(ft.from, ft.to, e), mul(up, Math.sin(Math.PI * e) * 0.2 * u));
        if (e >= 1) {
          ft.stepT = -1;
          ft.planted = ft.to;
          // A foot set down on a thread lights it.
          if (ft.edge) {
            this.light(ft.edge, 1.5, 'walk');
            if (this.spiderOn && !this.reduceMotion)
              this.flashes.push({ p: ft.planted, t0: this.clock });
          }
        }
      } else ft.foot = ft.planted;
      ft.hip = add(
        add(add(this.body.base, mul(up, 0.2 * u)), mul(this.body.fwd, (0.15 - ft.j * 0.045) * u)),
        mul(this.body.side, ft.side * 0.08 * u),
      );
      ft.knee = add(
        lerp(ft.hip, ft.foot, 0.42),
        mul(up, (ft.j === 0 || ft.j === 3 ? 0.48 : 0.42) * u),
      );
    }
    if (this.flashes.length > 60) this.flashes.splice(0, this.flashes.length - 60);
  }

  private startStep(ft: Foot): void {
    ft.from = ft.planted;
    ft.to = ft.target;
    ft.edge = ft.targetEdge;
    ft.stepT = 0;
  }

  // -- Panel ---------------------------------------------------------------------

  private log(kind: CrawlSnapshot['log'][number]['kind'], verb: string, text: string): void {
    this.snapshot = {
      ...this.snapshot,
      log: [{ t: this.clock, kind, verb, text }, ...this.snapshot.log].slice(0, 40),
    };
    this.emit();
  }

  private emit(): void {
    this.onChange(this.snapshot);
  }

  // -- Drawing -------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, f: PluginFrame): void {
    if (this.mode === 'idle' || !this.here) return;
    if (this.model !== f.model) this.rebind(f.model);
    const dt = this.playing ? (f.dt / 1000) * this.speed : 0;
    if (this.playing) this.update(dt);
    this.placeBody(f.dt / 1000);
    this.updateFeet(dt);

    const project = projector(f.cam, f.vp);
    const P = (p: Vec) => project(p[0], p[1], p[2]);
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    const time = f.now / 1000;

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Threads it has walked: they stay lit, so the path it took remains on the brain.
    for (const [edge, l] of this.lit) {
      const a = P(at(edge.source));
      const m = P(onEdge(edge, 0.5));
      const b = P(at(edge.target));
      if (!a || !m || !b) continue;
      ctx.strokeStyle = hexA(
        l.kind === 'decision' ? CRAWL_COLORS.decision : CRAWL_COLORS.linked,
        Math.min(1, 0.35 + l.glow * 0.5),
      );
      ctx.lineWidth = 1.2 + l.glow;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2, b.x, b.y);
      ctx.stroke();
    }
    for (const s of this.silk) {
      ctx.strokeStyle = 'rgba(240,240,250,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const p = P(pointOn(s, i / 12, this.unit));
        if (!p) continue;
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // Where a foot came down, a small flash on the thread.
    for (const fl of this.flashes) {
      const age = this.clock - fl.t0;
      // A flash from before a replay restarted the clock has a negative age,
      // and a negative radius throws.
      if (age < 0 || age > 0.6) continue;
      const p = P(fl.p);
      if (!p) continue;
      ctx.strokeStyle = hexA(CRAWL_COLORS.linked, 0.9 * (1 - age / 0.6));
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2 + age * 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Notes handed over, lit in the colour of why.
    for (const [node, kind] of this.found) {
      const p = P(at(node));
      if (!p) continue;
      const r =
        Math.max(3, node.radius * p.scale * 1.6) *
        (this.mode === 'done' && !f.reduceMotion
          ? 1 + 0.2 * Math.sin(time * 3 + node.phase * 6)
          : 1);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      g.addColorStop(0, hexA(CRAWL_COLORS[kind], 0.9));
      g.addColorStop(1, hexA(CRAWL_COLORS[kind], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Reaching out to what it reads.
    const body = P(this.body.base);
    if (this.mode === 'dwell' && body) {
      for (const tn of this.tentacles) {
        const g = Math.min(1, (this.t - tn.at) / 0.4);
        if (g <= 0) continue;
        const target = tn.node ? P(at(tn.node)) : tn.point ? P(tn.point) : null;
        if (!target) continue;
        const mx = (body.x + target.x) / 2 + (target.y - body.y) * 0.22;
        const my = (body.y + target.y) / 2 - (target.x - body.x) * 0.22;
        ctx.strokeStyle = hexA(CRAWL_COLORS[tn.kind], 0.95);
        ctx.lineWidth = 1.4;
        ctx.setLineDash([2, 4]);
        ctx.lineDashOffset = f.reduceMotion ? 0 : -time * 40;
        ctx.beginPath();
        ctx.moveTo(body.x, body.y);
        for (let i = 1; i <= 20; i++) {
          const u = Math.min(g, i / 20);
          ctx.lineTo(
            (1 - u) * (1 - u) * body.x + 2 * (1 - u) * u * mx + u * u * target.x,
            (1 - u) * (1 - u) * body.y + 2 * (1 - u) * u * my + u * u * target.y,
          );
          if (u >= g) break;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    if (this.spiderOn) this.drawSpider(ctx, P);
    else if (body) this.drawSignal(ctx, body.x, body.y, time, f.reduceMotion);
    this.drawLabels(ctx, P, f.vp);
  }

  /** The model was rebuilt (a layer toggled, a note added): find the same notes in it. */
  private rebind(model: GraphModel): void {
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const swap = (n: GraphNode | null) => (n ? (byId.get(n.id) ?? n) : n);
    this.model = model;
    this.here = swap(this.here);
  }

  private drawSignal(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    time: number,
    still: boolean,
  ): void {
    const r = 9 + (still ? 0 : 2 * Math.sin(time * 6));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
    g.addColorStop(0, hexA(CRAWL_COLORS.spider, 1));
    g.addColorStop(0.3, hexA(CRAWL_COLORS.spider, 0.55));
    g.addColorStop(1, hexA(CRAWL_COLORS.spider, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSpider(
    ctx: CanvasRenderingContext2D,
    P: (p: Vec) => { x: number; y: number; scale: number } | null,
  ): void {
    const u = this.unit;
    const { base, up, fwd } = this.body;
    const pc = P(add(add(base, mul(up, 0.22 * u)), mul(fwd, 0.14 * u)));
    const pa = P(add(add(base, mul(up, 0.26 * u)), mul(fwd, -0.22 * u)));
    const pb = P(base);
    if (!pc || !pa || !pb) return;
    const k = pa.scale * u; // pixels per spider unit
    // Where it stands: a halo on the note or the thread.
    const halo = ctx.createRadialGradient(pb.x, pb.y, 0, pb.x, pb.y, 0.85 * k);
    halo.addColorStop(0, hexA(CRAWL_COLORS.linked, 0.28));
    halo.addColorStop(1, hexA(CRAWL_COLORS.linked, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(pb.x, pb.y, 0.85 * k, 0, Math.PI * 2);
    ctx.fill();
    // Legs: a dark outline first, then the light stroke, so they read over anything.
    const lw = Math.max(1.3, 0.022 * k);
    const legs = this.feet.map((ft) => [P(ft.hip), P(ft.knee), P(ft.foot)] as const);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [color, width] of [
      ['rgba(3,14,13,0.9)', lw + 1.6],
      [CRAWL_COLORS.spider, lw],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (const [h, kn, ft] of legs) {
        if (!h || !kn || !ft) continue;
        ctx.beginPath();
        ctx.moveTo(h.x, h.y);
        ctx.lineTo(kn.x, kn.y);
        ctx.lineTo(ft.x, ft.y);
        ctx.stroke();
      }
    }
    ctx.fillStyle = CRAWL_COLORS.spider;
    for (const [, , ft] of legs) {
      if (!ft) continue;
      ctx.beginPath();
      ctx.arc(ft.x, ft.y, Math.max(1.4, lw * 0.85), 0, Math.PI * 2);
      ctx.fill();
    }
    // Body: a big round abdomen behind, a small cephalothorax in front.
    const ang = Math.atan2(pc.y - pa.y, pc.x - pa.x);
    const blob = (
      p: { x: number; y: number },
      rx: number,
      ry: number,
      fill: string | CanvasGradient,
    ) => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = CRAWL_COLORS.spider;
      ctx.lineWidth = Math.max(1.4, 0.024 * k);
      ctx.stroke();
      ctx.restore();
    };
    const ra = 0.23 * k;
    const gA = ctx.createRadialGradient(
      pa.x - ra * 0.3,
      pa.y - ra * 0.3,
      ra * 0.1,
      pa.x,
      pa.y,
      ra * 1.2,
    );
    gA.addColorStop(0, '#16403b');
    gA.addColorStop(1, '#061614');
    blob(pa, ra * 1.18, ra, gA);
    ctx.save();
    ctx.translate(pa.x, pa.y);
    ctx.rotate(ang);
    ctx.fillStyle = CRAWL_COLORS.core;
    ctx.shadowColor = CRAWL_COLORS.core;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(-ra * 0.45, 0);
    ctx.lineTo(-ra * 0.05, -ra * 0.28);
    ctx.lineTo(ra * 0.05, 0);
    ctx.lineTo(-ra * 0.05, ra * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const rc = 0.136 * k;
    blob(pc, rc * 1.12, rc * 0.92, '#0b2522');
    const ex = Math.cos(ang);
    const ey = Math.sin(ang);
    ctx.fillStyle = '#eafffb';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(
        pc.x + ex * rc * 0.62 - ey * s * rc * 0.32,
        pc.y + ey * rc * 0.62 + ex * s * rc * 0.32,
        Math.max(1, rc * 0.14),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    P: (p: Vec) => { x: number; y: number } | null,
    vp: Viewport,
  ): void {
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    // The overlay leaves text centred; labels here grow from their left edge.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `500 11px ${this.fonts.mono}`;
    for (const L of this.labels) {
      const p = L.node ? P(at(L.node)) : L.point ? P(L.point) : null;
      if (!p) continue;
      const age = this.clock - L.born;
      let a = Math.min(1, age / 0.25) * (age > 4 ? (L.kind === 'ask' ? 0.85 : 0.55) : 1);
      if (this.mode === 'done' && L.kind !== 'named' && L.kind !== 'ask') a *= 0.25;
      if (a <= 0.01) continue;
      const w = ctx.measureText(L.text).width + 12;
      const h = 18;
      let x = p.x + 10;
      let y = p.y - 24;
      if (x + w > vp.width - 6) x = p.x - 10 - w;
      x = Math.max(6, x);
      for (let i = 0; i < 4; i++) {
        if (!placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y))
          break;
        y += 21;
      }
      placed.push({ x, y, w, h });
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(6,6,10,0.86)';
      ctx.strokeStyle = CRAWL_COLORS[L.kind];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = CRAWL_COLORS[L.kind];
      ctx.fillText(L.text, x + 6, y + 12.5);
      ctx.globalAlpha = 1;
    }
  }
}

function emptySnapshot(): CrawlSnapshot {
  return {
    state: 'idle',
    phase: 0,
    log: [],
    found: { named: 0, linked: 0, decision: 0 },
    asks: [],
    threads: 0,
    coverage: null,
    offGraph: 0,
    following: true,
  };
}

/** The median length of the threads, so the spider is sized against them. */
export function typicalLink(model: Pick<GraphModel, 'edges'>): number {
  const lengths = model.edges
    .filter(walkable)
    .map((e) => dist(at(e.source), at(e.target)))
    .filter((l) => l > 0)
    .sort((a, b) => a - b);
  // A little over half a typical thread: long enough legs to span one, small enough to read the notes around it.
  return lengths.length ? lengths[Math.floor(lengths.length / 2)]! * 0.6 : 10;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
