// The layout: one d3-force-3d simulation for every view. Network and
// Territories pull z flat; Brain lets it spread inside the brain volume, so
// switching views is the same notes flowing somewhere else, never a jump.
//
// Two things worth not undoing, inherited from the 2D graph:
//
//  - Repulsion falls off as 1/d (d3's many-body). With a faster falloff,
//    distant notes stop pushing each other and gravity packs the vault into
//    one ball.
//  - A node the user drags is pinned (`fx`/`fy`/`fz`) while dragged; the sim
//    keeping its own forces on it made anything you pulled spring back.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Force,
  type Simulation,
} from 'd3-force-3d';

import { LOBE_SPOTS, brainScaleFor, forceBrain, projectDepth, seededRandom } from '@/lib/graph-brain';
import { boundsOf } from '@/lib/graph-camera';
import type { EdgeKind, GraphEdge, GraphModel, GraphNode, GraphView } from '@/lib/graph-model';

const LINK_FACTOR: Record<EdgeKind, number> = { link: 1, structure: 0.35, affinity: 0.08, topic: 0.3 };
const APPEAR_MS = 420;

export type RebuildReason = 'init' | 'data' | 'layers' | 'view';
type Point = { x: number; y: number; z: number };

/** When the layout jumped (entering the brain), the camera scales by the same amount. */
export interface Rescale {
  k: number;
  cx: number;
  cy: number;
  oy: number;
}

interface Growth {
  order: GraphNode[];
  next: number;
  t0: number;
  duration: number;
  from: number;
  to: number;
  active: GraphNode[];
  activeSet: Set<GraphNode>;
  lastSync: number;
  dirty: boolean;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function forceCluster(strength: number): Force<GraphNode> {
  let groups: GraphNode[][] = [];
  const force: Force<GraphNode> = (alpha: number) => {
    const k = strength * alpha;
    for (const g of groups) {
      let x = 0;
      let y = 0;
      let z = 0;
      for (const n of g) {
        x += n.x;
        y += n.y;
        z += n.z;
      }
      x /= g.length;
      y /= g.length;
      z /= g.length;
      for (const n of g) {
        n.vx += (x - n.x) * k;
        n.vy += (y - n.y) * k;
        n.vz += (z - n.z) * k;
      }
    }
  };
  force.initialize = (nodes) => {
    const byProject = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (!n.project) continue;
      const list = byProject.get(n.project.id) ?? [];
      list.push(n);
      byProject.set(n.project.id, list);
    }
    groups = [...byProject.values()].filter((g) => g.length > 1);
  };
  return force;
}

export class GraphEngine {
  model: GraphModel | null = null;
  view: GraphView = 'brain';
  /** World size of the brain, eased towards `brainTarget` as notes appear. */
  brainScale = 200;
  brainTarget = 200;
  growth: Growth | null = null;
  /** Until when some node is still fading in: edges need re-lighting every frame. */
  appearingUntil = 0;
  private sim: Simulation<GraphNode> | null = null;
  private anchors = new Map<string, Point>();
  private readonly random = seededRandom(20260926);

  constructor(private readonly reduceMotion: boolean) {}

  get is3D(): boolean {
    return this.view === 'brain';
  }
  get nodeCount(): number {
    return this.growth ? this.growth.active.length : (this.model?.nodes.length ?? 0);
  }
  get moving(): boolean {
    return !!this.sim && this.sim.alpha() > this.sim.alphaMin();
  }

  appear(n: GraphNode, now: number): number {
    if (n.bornAt === -Infinity) return 1;
    return clamp((now - n.bornAt) / APPEAR_MS, 0, 1);
  }
  flash(n: GraphNode, now: number): number {
    if (this.reduceMotion) return 0;
    const dt = now - n.bornAt;
    if (!(dt >= 0 && dt <= 1000)) return 0;
    const f = 1 - dt / 1000;
    return f * f * (this.growth ? 1 : 0.55);
  }

  // -- Rebuilds ----------------------------------------------------------------

  /** A new model: keep every placed node where it is, place the new ones beside their neighbours. */
  setModel(model: GraphModel, reason: RebuildReason, now: number, saved?: ReadonlyMap<string, Point>): void {
    this.endGrowth();
    const previous = new Set(this.model?.nodes ?? []);
    this.model = model;
    this.brainTarget = brainScaleFor(model.nodes.length);
    this.brainScale = this.brainTarget;
    this.computeAnchors();
    if (saved) {
      for (const n of model.nodes) {
        const p = saved.get(n.id);
        if (p && !Number.isFinite(n.x)) Object.assign(n, { x: p.x, y: p.y, z: this.is3D ? p.z : 0, vx: 0, vy: 0, vz: 0 });
      }
    }
    this.placeNew(model.nodes);
    this.makeSim(reason === 'init' ? (saved?.size ? 0.4 : 1) : reason === 'layers' ? 0.5 : 0.8);
    if (reason === 'init') {
      const n = model.nodes.length;
      const ticks = saved?.size ? 20 : n > 1200 ? 30 : n > 500 ? 70 : 150;
      this.sim!.tick(ticks);
      this.wave(model.nodes, now);
    } else {
      this.wave(model.nodes.filter((n) => !previous.has(n)), now);
    }
  }

  /** Switch views. Entering the brain rescales the layout; the caller scales the camera to match. */
  setView(view: GraphView): Rescale | null {
    this.endGrowth();
    const entering = view === 'brain' && this.view !== 'brain';
    this.view = view;
    if (!this.model) return null;
    this.computeAnchors();
    const rescale = entering ? this.inflate() : null;
    this.makeSim(0.8);
    return rescale;
  }

  /** Advance one frame: simulation, growth replay, brain size. Returns whether anything moved. */
  advance(now: number): boolean {
    const moving = this.moving;
    if (moving && this.sim) {
      this.sim.tick();
      if ((this.model?.nodes.length ?? 0) < 500 && this.sim.alpha() > 0.05) this.sim.tick();
    }
    this.stepGrowth(now);
    this.brainScale += (this.brainTarget - this.brainScale) * 0.06;
    return moving || !!this.growth;
  }

  pin(n: GraphNode, p: Point): void {
    n.fx = p.x;
    n.fy = p.y;
    n.fz = this.is3D ? p.z : 0;
    this.sim?.alphaTarget(0.2);
    if (this.sim && this.sim.alpha() < 0.2) this.sim.alpha(0.2);
  }
  release(n: GraphNode): void {
    n.fx = n.fy = n.fz = null;
    this.sim?.alphaTarget(0);
  }

  /** Where every placed note is, for the next visit. */
  snapshot(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.model?.nodes ?? []) {
      if (Number.isFinite(n.x)) out[n.id] = [Math.round(n.x), Math.round(n.y), Math.round(n.z || 0)];
    }
    return out;
  }

  // -- Layout -------------------------------------------------------------------

  private computeAnchors(): void {
    this.anchors.clear();
    const model = this.model;
    if (!model) return;
    const present = new Set(model.nodes.map((n) => n.vault));
    const vaults = model.vaults.filter((v) => present.has(v.id));
    if (vaults.length < 2) return;
    if (this.is3D) {
      vaults.forEach((v, i) => {
        const [x, y, z] = LOBE_SPOTS[i % LOBE_SPOTS.length]!;
        this.anchors.set(v.id, { x: x * this.brainTarget, y: y * this.brainTarget, z: z * this.brainTarget });
      });
      return;
    }
    if (this.view !== 'territories') return;
    const counts = new Map<string, number>();
    for (const n of model.nodes) counts.set(n.vault, (counts.get(n.vault) ?? 0) + 1);
    const own = vaults.find((v) => v.own);
    const others = vaults.filter((v) => !v.own);
    if (own) this.anchors.set(own.id, { x: 0, y: 0, z: 0 });
    const nOwn = own ? (counts.get(own.id) ?? 0) : 0;
    others.forEach((v, i) => {
      const angle = (i * 2 * Math.PI) / others.length + (own ? 0 : 0.4);
      const r = (Math.sqrt(nOwn) + Math.sqrt(counts.get(v.id) ?? 0)) * 26 + 90;
      this.anchors.set(v.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.85, z: 0 });
    });
  }

  private zTarget = (n: GraphNode): number => {
    const a = this.anchors.get(n.vault);
    const spread = a ? 0.5 : 0.9;
    return (a?.z ?? 0) + projectDepth(n.project?.id ?? n.id) * this.brainTarget * spread;
  };

  private makeSim(alpha: number): void {
    this.sim?.stop();
    const model = this.model!;
    const active = this.growth ? this.growth.active : model.nodes;
    const activeSet = new Set(active);
    const edges = this.growth ? model.edges.filter((e) => activeSet.has(e.source) && activeSet.has(e.target)) : model.edges;
    const minDegree = (e: GraphEdge) => Math.max(1, Math.min(e.source.degree, e.target.degree));
    const hasAnchors = this.anchors.size > 0;
    const pull = hasAnchors ? 0.06 : this.is3D ? 0.01 : 0.04;
    const anchor = (n: GraphNode) => this.anchors.get(n.vault);

    const sim = forceSimulation<GraphNode>(active, 3)
      .stop()
      .velocityDecay(0.42)
      .alphaDecay(0.02)
      .alphaMin(0.002)
      .force(
        'link',
        forceLink<GraphNode, GraphEdge>(edges)
          .distance((e) => (e.kind === 'affinity' ? 90 : (e.kind === 'link' ? 30 : 40) + e.source.radius + e.target.radius))
          .strength((e) => LINK_FACTOR[e.kind] / minDegree(e)),
      )
      .force(
        'charge',
        forceManyBody<GraphNode>()
          .strength((n) => (n.kind === 'topic' ? -80 : -55 - n.radius * 9))
          .theta(0.9)
          .distanceMax(this.is3D ? 500 : 900),
      )
      .force('collide', forceCollide<GraphNode>((n) => n.radius + 3).strength(0.8))
      .force('cluster', forceCluster(0.09))
      .force('x', forceX<GraphNode>((n) => anchor(n)?.x ?? 0).strength(pull))
      .force('y', forceY<GraphNode>((n) => anchor(n)?.y ?? 0).strength(pull));
    if (this.is3D) {
      sim.force('z', forceZ<GraphNode>(this.zTarget).strength(hasAnchors ? 0.06 : 0.03));
      sim.force('brain', forceBrain(() => this.brainScale) as Force<GraphNode>);
    } else {
      sim.force('z', forceZ<GraphNode>(0).strength(0.5));
    }
    sim.alpha(alpha);
    this.sim = sim;
  }

  /** New nodes start beside a placed neighbour, so the map never reshuffles. */
  private placeNew(nodes: GraphNode[]): void {
    const flat = !this.is3D;
    let pending = nodes.filter((n) => !Number.isFinite(n.x));
    for (let pass = 0; pass < 40 && pending.length; pass++) {
      const before = pending.length;
      pending = pending.filter((n) => {
        const nb = this.model!.adjacency.get(n)?.find(({ node }) => Number.isFinite(node.x));
        if (!nb) return true;
        const a = this.random() * Math.PI * 2;
        const d = 10 + this.random() * 14;
        n.x = nb.node.x + Math.cos(a) * d;
        n.y = nb.node.y + Math.sin(a) * d;
        n.z = flat ? 0 : (nb.node.z || 0) + (this.random() - 0.5) * 20;
        n.vx = n.vy = n.vz = 0;
        return false;
      });
      if (pending.length === before) break;
    }
    // Whatever is left starts in its project's own patch.
    const groups = new Map<string, GraphNode[]>();
    for (const n of pending) {
      const key = n.project?.id ?? n.id;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    let j = 0;
    for (const [key, group] of groups) {
      const a = this.anchors.get(group[0]!.vault) ?? { x: 0, y: 0, z: 0 };
      const r = 70 * Math.sqrt(j + 0.5);
      const angle = j * 2.39996;
      const cz = flat ? 0 : projectDepth(key) * this.brainTarget * 0.9;
      for (const n of group) {
        n.x = a.x + r * Math.cos(angle) + (this.random() - 0.5) * 40;
        n.y = a.y + r * Math.sin(angle) + (this.random() - 0.5) * 40;
        n.z = flat ? 0 : cz + (this.random() - 0.5) * 30;
        n.vx = n.vy = n.vz = 0;
      }
      j++;
    }
  }

  /**
   * Into the brain: fit the flat layout to the brain's side view and start each
   * note a little towards its depth. The forces do the inflating.
   */
  private inflate(): Rescale | null {
    const b = boundsOf(this.model!.nodes);
    if (!b) return null;
    const s = this.brainTarget;
    const k = Math.min((1.6 * s) / b.w, (1.05 * s) / b.h);
    const oy = -0.05 * s;
    for (const n of this.model!.nodes) {
      if (!Number.isFinite(n.x)) continue;
      n.x = (n.x - b.cx) * k;
      n.y = (n.y - b.cy) * k + oy;
      n.z = this.zTarget(n) * 0.15;
      n.vx = n.vy = n.vz = 0;
    }
    return { k, cx: b.cx, cy: b.cy, oy };
  }

  /** Nodes light up in a wave that starts at each component's hub. */
  private wave(nodes: GraphNode[], now: number): void {
    if (this.reduceMotion || !this.model) {
      for (const n of nodes) n.bornAt = -Infinity;
      return;
    }
    const set = new Set(nodes);
    const hop = new Map<GraphNode, number>();
    for (const start of [...nodes].sort((a, b) => b.size - a.size)) {
      if (hop.has(start)) continue;
      hop.set(start, 0);
      const queue = [start];
      for (let i = 0; i < queue.length; i++) {
        const u = queue[i]!;
        for (const { node } of this.model.adjacency.get(u) ?? []) {
          if (!set.has(node) || hop.has(node)) continue;
          hop.set(node, hop.get(u)! + 1);
          queue.push(node);
        }
      }
    }
    for (const n of nodes) {
      n.bornAt = now + 120 + hop.get(n)! * 110 + this.random() * 90;
      this.appearingUntil = Math.max(this.appearingUntil, n.bornAt + APPEAR_MS);
    }
  }

  // -- Growth replay --------------------------------------------------------------

  startGrowth(now: number): void {
    const model = this.model;
    if (!model?.nodes.length) return;
    this.endGrowth();
    const order = [...model.nodes].sort((a, b) => a.createdAt - b.createdAt);
    for (const n of order) {
      n.bornAt = Infinity;
      n.x = n.y = n.z = Number.NaN;
    }
    this.growth = {
      order,
      next: 0,
      t0: now,
      duration: clamp(order.length * 28, 7000, 15000),
      from: order[0]!.createdAt,
      to: Math.max(order[order.length - 1]!.createdAt, order[0]!.createdAt + 1),
      active: [],
      activeSet: new Set(),
      lastSync: 0,
      dirty: false,
    };
    this.brainScale = brainScaleFor(1);
    this.syncGrowth();
  }

  /** The date the replay has reached and how many notes exist by then; null when not replaying. */
  growthStatus(now: number): { at: number; count: number } | null {
    const g = this.growth;
    if (!g) return null;
    return { at: g.from + (g.to - g.from) * clamp((now - g.t0) / g.duration, 0, 1), count: g.active.length };
  }

  endGrowth(): void {
    const g = this.growth;
    if (!g) return;
    for (const n of g.order.slice(g.next)) {
      this.spawn(n, g.activeSet);
      n.bornAt = -Infinity;
      g.activeSet.add(n);
    }
    this.growth = null;
    if (this.model) {
      this.brainTarget = brainScaleFor(this.model.nodes.length);
      this.computeAnchors();
      this.makeSim(Math.max(this.sim?.alpha() ?? 0, 0.45));
    }
  }

  private stepGrowth(now: number): void {
    const g = this.growth;
    if (!g) return;
    const p = clamp((now - g.t0) / g.duration, 0, 1);
    const at = g.from + (g.to - g.from) * p;
    while (g.next < g.order.length && g.order[g.next]!.createdAt <= at) {
      const n = g.order[g.next++]!;
      this.spawn(n, g.activeSet);
      n.bornAt = now;
      this.appearingUntil = now + APPEAR_MS;
      g.active.push(n);
      g.activeSet.add(n);
      g.dirty = true;
    }
    if (g.dirty && now - g.lastSync > 90) {
      g.lastSync = now;
      g.dirty = false;
      this.syncGrowth();
    }
    if (p >= 1 && g.next >= g.order.length) {
      this.growth = null;
      this.makeSim(Math.max(this.sim?.alpha() ?? 0, 0.3));
    }
  }

  private syncGrowth(): void {
    const g = this.growth!;
    this.brainTarget = brainScaleFor(g.active.length);
    this.computeAnchors();
    const alpha = Math.max(this.sim?.alpha() ?? 0, 0.45);
    if (g.active.length) this.makeSim(alpha);
    else {
      // Nothing exists yet: no simulation to tick until the first note appears.
      this.sim?.stop();
      this.sim = null;
    }
  }

  private spawn(n: GraphNode, active: Set<GraphNode>): void {
    let spread = 6 + this.random() * 10;
    let from: Point | undefined = this.model!.adjacency.get(n)?.find(({ node }) => active.has(node) && Number.isFinite(node.x))?.node;
    if (!from && n.project) {
      const group = this.model!.projects.find((p) => p.id === n.project!.id);
      from = group?.nodes.find((m) => active.has(m) && Number.isFinite(m.x));
    }
    if (!from) {
      from = this.anchors.get(n.vault) ?? { x: 0, y: 0, z: 0 };
      spread = 20 + this.random() * 40;
    }
    const angle = this.random() * Math.PI * 2;
    n.x = from.x + Math.cos(angle) * spread;
    n.y = from.y + Math.sin(angle) * spread;
    n.z = this.is3D ? (from.z || 0) + (this.random() - 0.5) * spread : 0;
    n.vx = n.vy = n.vz = 0;
  }
}

