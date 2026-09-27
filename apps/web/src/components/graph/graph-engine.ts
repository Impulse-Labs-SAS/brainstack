// The layout, one per view, over the same node objects — so switching views
// is the same notes flowing somewhere else, never a jump.
//
//  - Brain: a d3-force-3d simulation inside the brain volume, each vault in
//    its own lobe and each project at its own depth.
//  - Network: the same simulation, flat, where links alone decide. Nothing
//    pulls a note towards its project; pieces that nothing links together are
//    packed side by side, and notes without a single link wait on a ring
//    around everything else.
//  - Territories: no forces at all. Every note has a place on the map
//    (graph-map.ts) and eases there; links never move anything.
//
// Two things worth not undoing, inherited from the 2D graph:
//
//  - Repulsion falls off as 1/d (d3's many-body). With a faster falloff,
//    distant notes stop pushing each other and gravity packs the vault into
//    one ball.
//  - A node the user drags is pinned (`fx`/`fy`/`fz`) while dragged; the sim
//    keeping its own forces on it made anything you pulled spring back.

import { packEnclose, packSiblings } from 'd3-hierarchy';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Force,
  type ForceLink,
  type Simulation,
} from 'd3-force-3d';

import { LOBE_SPOTS, brainScaleFor, forceBrain, projectDepth, seededRandom } from '@/lib/graph-brain';
import { boundsOf, type Bounds } from '@/lib/graph-camera';
import { COAST_REACH, buildLand, layoutTerritories, siteAt, type MapLand, type TerritoryLayout } from '@/lib/graph-map';
import type { EdgeKind, GraphEdge, GraphModel, GraphNode, GraphView } from '@/lib/graph-model';

const LINK_FACTOR: Record<EdgeKind, number> = { link: 1, structure: 0.35, affinity: 0.08, topic: 0.3 };
const APPEAR_MS = 420;
/** Fraction of the remaining way a note travels towards its place on the map, per frame. */
const MAP_EASE = 0.14;

export type RebuildReason = 'init' | 'data' | 'layers' | 'view';
type Point = { x: number; y: number; z: number };

/** When the layout jumped (entering the brain), the camera scales by the same amount. */
export interface Rescale {
  k: number;
  cx: number;
  cy: number;
  oy: number;
}

/** Network: where the notes without a single link wait. Centred on the origin. */
export interface LooseRing {
  r: number;
  count: number;
}

interface Growth {
  order: GraphNode[];
  next: number;
  t0: number;
  duration: number;
  active: GraphNode[];
  activeSet: Set<GraphNode>;
  lastSync: number;
  dirty: boolean;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Brain only: each project drifts towards its own centre, so it stays one cluster in the volume. */
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

/**
 * Pulls every node to z = 0 in Network. Ignores alpha, like the brain's
 * container: d3 nudges coincident nodes apart at random in all three axes, and
 * a pull that cooled with the layout left them off the plane.
 */
function forceFlat(): Force<GraphNode> {
  let nodes: GraphNode[] = [];
  const force: Force<GraphNode> = () => {
    for (const n of nodes) n.vz -= n.z * 0.3;
  };
  force.initialize = (ns) => {
    nodes = ns;
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
  /** Network: the ring of notes without links, when there are any. */
  ring: LooseRing | null = null;
  /** Territories: where every note belongs, and the land under the notes placed so far. */
  territory: TerritoryLayout | null = null;
  land: MapLand | null = null;
  /** Bumped whenever `land` is rebuilt, so whoever draws it knows to rebuild too. */
  landVersion = 0;
  private sim: Simulation<GraphNode> | null = null;
  /** Where each node is pulled, and how hard: a lobe in the brain, its piece or the ring in Network. */
  private anchors = new Map<GraphNode, Point>();
  private pull = new Map<GraphNode, number>();
  private lobes = new Map<string, Point>();
  /** Territories: notes still easing towards their place. */
  private travelling = false;
  private readonly random = seededRandom(20260926);

  constructor(private readonly reduceMotion: boolean) {}

  get is3D(): boolean {
    return this.view === 'brain';
  }
  get isMap(): boolean {
    return this.view === 'territories';
  }
  get nodeCount(): number {
    return this.growth ? this.growth.active.length : (this.model?.nodes.length ?? 0);
  }
  get moving(): boolean {
    if (this.isMap) return this.travelling;
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
    this.shape();
    if (saved && !this.isMap) {
      for (const n of model.nodes) {
        const p = saved.get(n.id);
        if (p && !Number.isFinite(n.x)) Object.assign(n, { x: p.x, y: p.y, z: this.is3D ? p.z : 0, vx: 0, vy: 0, vz: 0 });
      }
    }
    this.placeNew(model.nodes);
    if (this.isMap) {
      this.stopSim();
      if (reason === 'init') this.snapToMap(model.nodes);
      this.travelling = reason !== 'init';
      this.rebuildLand();
    } else {
      this.makeSim(reason === 'init' ? (saved?.size ? 0.4 : 1) : reason === 'layers' ? 0.5 : 0.8);
      if (reason === 'init') {
        const n = model.nodes.length;
        const ticks = saved?.size ? 20 : n > 1200 ? 30 : n > 500 ? 70 : 150;
        this.sim!.tick(ticks);
      }
    }
    this.wave(reason === 'init' ? model.nodes : model.nodes.filter((n) => !previous.has(n)), now);
  }

  /** Switch views. Entering the brain rescales the layout; the caller scales the camera to match. */
  setView(view: GraphView): Rescale | null {
    this.endGrowth();
    const entering = view === 'brain' && this.view !== 'brain';
    this.view = view;
    if (!this.model) return null;
    this.shape();
    if (this.isMap) {
      this.stopSim();
      this.travelling = true;
      this.rebuildLand();
      return null;
    }
    const rescale = entering ? this.inflate() : null;
    this.makeSim(0.8);
    return rescale;
  }

  /** Advance one frame: layout, growth replay, brain size. Returns whether anything moved. */
  advance(now: number): boolean {
    let moving: boolean;
    if (this.isMap) {
      moving = this.travel();
    } else {
      moving = this.moving;
      if (moving && this.sim) {
        this.sim.tick();
        if ((this.model?.nodes.length ?? 0) < 500 && this.sim.alpha() > 0.05) this.sim.tick();
      }
    }
    this.stepGrowth(now);
    this.brainScale += (this.brainTarget - this.brainScale) * 0.06;
    return moving || !!this.growth;
  }

  /** Whether a dragged note may be moved: on the map, a note's place is where it is filed. */
  get canPin(): boolean {
    return !this.isMap;
  }
  pin(n: GraphNode, p: Point): void {
    if (!this.canPin) return;
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

  /** Territories: the project whose land is under (x, y), or null over the sea. */
  countryAt(x: number, y: number): string | null {
    if (!this.isMap || !this.land) return null;
    const i = siteAt(this.land, x, y);
    return i >= 0 ? this.land.sites[i]!.project : null;
  }

  /** Territories: the whole map, where the notes are headed rather than where they are. */
  mapBounds(): Bounds | null {
    const t = this.territory;
    if (!this.isMap || !t?.continents.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of t.continents) {
      const r = c.r + COAST_REACH;
      x0 = Math.min(x0, c.x - r);
      x1 = Math.max(x1, c.x + r);
      y0 = Math.min(y0, c.y - r);
      y1 = Math.max(y1, c.y + r);
    }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: 0, w: x1 - x0, h: y1 - y0, d: 1 };
  }

  // -- Layout -------------------------------------------------------------------

  /** Decide where things are pulled (or placed) for the current view. */
  private shape(): void {
    this.anchors.clear();
    this.pull.clear();
    this.lobes.clear();
    this.ring = null;
    const model = this.model;
    if (!model) return;
    if (this.isMap) {
      this.territory = layoutTerritories(model.nodes, model.vaults.filter((v) => !v.hidden));
      return;
    }
    if (this.is3D) {
      const present = new Set(model.nodes.map((n) => n.vault));
      const vaults = model.vaults.filter((v) => present.has(v.id));
      if (vaults.length < 2) return;
      vaults.forEach((v, i) => {
        const [x, y, z] = LOBE_SPOTS[i % LOBE_SPOTS.length]!;
        this.lobes.set(v.id, { x: x * this.brainTarget, y: y * this.brainTarget, z: z * this.brainTarget });
      });
      for (const n of model.nodes) {
        const lobe = this.lobes.get(n.vault);
        if (!lobe) continue;
        this.anchors.set(n, lobe);
        this.pull.set(n, 0.06);
      }
      return;
    }
    this.shapeNetwork(model);
  }

  /**
   * Network: every piece of the graph that links hold together gets its own
   * spot, packed beside the others, instead of all of them being pulled to
   * one centre and threading through each other. Pieces come from the whole
   * model, not the notes shown so far, so a replay grows into its final shape.
   */
  private shapeNetwork(model: GraphModel): void {
    const parent = new Map<GraphNode, GraphNode>();
    const find = (n: GraphNode): GraphNode => {
      let r = n;
      while (parent.get(r) !== r) r = parent.get(r)!;
      for (let c = n; c !== r; ) {
        const next = parent.get(c)!;
        parent.set(c, r);
        c = next;
      }
      return r;
    };
    for (const n of model.nodes) parent.set(n, n);
    for (const e of model.edges) {
      const a = find(e.source);
      const b = find(e.target);
      if (a !== b) parent.set(a, b);
    }
    const pieces = new Map<GraphNode, GraphNode[]>();
    const loose: GraphNode[] = [];
    for (const n of model.nodes) {
      if (n.degree === 0) {
        loose.push(n);
        continue;
      }
      const root = find(n);
      const list = pieces.get(root) ?? [];
      list.push(n);
      pieces.set(root, list);
    }

    // A piece's disc is a guess at the room its notes take once the forces settle.
    const discs = packSiblings(
      [...pieces.values()]
        .map((members) => ({ members, key: members.reduce((m, n) => (n.id < m ? n.id : m), members[0]!.id), r: 22 * Math.sqrt(members.length) + 52 }))
        .sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key)),
    );
    const enclose = discs.length ? packEnclose(discs) : { x: 0, y: 0, r: 0 };
    const several = discs.length > 1;
    for (const d of discs) {
      const at = several ? { x: d.x - enclose.x, y: d.y - enclose.y, z: 0 } : { x: 0, y: 0, z: 0 };
      for (const n of d.members) {
        this.anchors.set(n, at);
        this.pull.set(n, several ? 0.05 : 0.04);
      }
    }
    if (!loose.length) return;
    const r = (discs.length ? enclose.r : 0) + 80;
    loose.sort((a, b) => a.vault.localeCompare(b.vault) || (a.project?.label ?? '').localeCompare(b.project?.label ?? '') || a.id.localeCompare(b.id));
    loose.forEach((n, i) => {
      const angle = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / loose.length;
      this.anchors.set(n, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: 0 });
      this.pull.set(n, 0.3);
    });
    this.ring = { r, count: loose.length };
  }

  private zTarget = (n: GraphNode): number => {
    const lobe = this.lobes.get(n.vault);
    const spread = lobe ? 0.5 : 0.9;
    return (lobe?.z ?? 0) + projectDepth(n.project?.id ?? n.id) * this.brainTarget * spread;
  };

  private stopSim(): void {
    this.sim?.stop();
    this.sim = null;
  }

  private makeSim(alpha: number): void {
    this.sim?.stop();
    const model = this.model!;
    // A copy during a replay: d3 keeps the array it is given, and `active` grows between syncs.
    const active = this.growth ? [...this.growth.active] : model.nodes;
    const activeSet = new Set(active);
    const edges = this.growth ? model.edges.filter((e) => activeSet.has(e.source) && activeSet.has(e.target)) : model.edges;
    const minDegree = (e: GraphEdge) => Math.max(1, Math.min(e.source.degree, e.target.degree));
    const pullOf = (n: GraphNode) => this.pull.get(n) ?? (this.is3D ? 0.01 : 0.04);

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
      .force('x', forceX<GraphNode>((n) => this.anchors.get(n)?.x ?? 0).strength(pullOf))
      .force('y', forceY<GraphNode>((n) => this.anchors.get(n)?.y ?? 0).strength(pullOf));
    if (this.is3D) {
      sim.force('cluster', forceCluster(0.09));
      sim.force('z', forceZ<GraphNode>(this.zTarget).strength(this.lobes.size ? 0.06 : 0.03));
      sim.force('brain', forceBrain(() => this.brainScale) as Force<GraphNode>);
    } else {
      sim.force('z', forceFlat());
    }
    sim.alpha(alpha);
    this.sim = sim;
  }

  /** Territories: ease every note towards its place. Returns whether any is still on its way. */
  private travel(): boolean {
    const t = this.territory;
    if (!t || !this.travelling || !this.model) return false;
    let far = 0;
    for (const n of this.model.nodes) {
      if (!Number.isFinite(n.x)) continue;
      const p = t.positions.get(n);
      const dx = (p?.x ?? n.x) - n.x;
      const dy = (p?.y ?? n.y) - n.y;
      const dz = -(n.z || 0);
      n.x += dx * MAP_EASE;
      n.y += dy * MAP_EASE;
      n.z = (n.z || 0) + dz * MAP_EASE;
      n.vx = n.vy = n.vz = 0;
      far = Math.max(far, Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
    }
    if (far < 0.05) {
      this.snapToMap(this.model.nodes);
      this.travelling = false;
    }
    return true;
  }

  private snapToMap(nodes: readonly GraphNode[]): void {
    const t = this.territory;
    if (!t) return;
    for (const n of nodes) {
      const p = t.positions.get(n);
      if (!p || !Number.isFinite(n.x)) continue;
      n.x = p.x;
      n.y = p.y;
      n.z = 0;
      n.vx = n.vy = n.vz = 0;
    }
  }

  /** The land under the notes placed so far; during a replay the countries grow with them. */
  private rebuildLand(): void {
    const t = this.territory;
    const model = this.model;
    if (!t || !model) return;
    const placed = this.growth ? this.growth.active : model.nodes;
    const sites = [];
    for (const n of placed) {
      const p = t.positions.get(n);
      if (!p || !n.project) continue;
      sites.push({ x: p.x, y: p.y, vault: n.vault, project: n.project.id, province: t.province.get(n) ?? '' });
    }
    this.land = buildLand(sites);
    this.landVersion++;
  }

  /** New nodes start beside a placed neighbour, so the map never reshuffles; on the map, at their place. */
  private placeNew(nodes: GraphNode[]): void {
    const flat = !this.is3D;
    const t = this.isMap ? this.territory : null;
    let pending = nodes.filter((n) => !Number.isFinite(n.x));
    if (t) {
      pending = pending.filter((n) => {
        const p = t.positions.get(n);
        if (!p) return true;
        Object.assign(n, { x: p.x, y: p.y, z: 0, vx: 0, vy: 0, vz: 0 });
        return false;
      });
    }
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
    // Whatever is left starts in its project's own patch, near where it is pulled.
    const groups = new Map<string, GraphNode[]>();
    for (const n of pending) {
      const key = n.project?.id ?? n.id;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    let j = 0;
    for (const [key, group] of groups) {
      const a = this.anchors.get(group[0]!) ?? { x: 0, y: 0, z: 0 };
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
      active: [],
      activeSet: new Set(),
      lastSync: 0,
      dirty: false,
    };
    this.travelling = false;
    this.brainScale = brainScaleFor(1);
    this.syncGrowth();
  }

  /** When the newest note so far was created, and how many exist; null when not replaying. */
  growthStatus(): { at: number; count: number } | null {
    const g = this.growth;
    if (!g) return null;
    const newest = g.active[g.active.length - 1] ?? g.order[0]!;
    return { at: newest.createdAt, count: g.active.length };
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
      this.settleAfterGrowth(0.45);
    }
  }

  private settleAfterGrowth(alpha: number): void {
    if (this.isMap) {
      this.rebuildLand();
      return;
    }
    this.shape();
    this.makeSim(Math.max(this.sim?.alpha() ?? 0, alpha));
  }

  private stepGrowth(now: number): void {
    const g = this.growth;
    if (!g) return;
    const p = clamp((now - g.t0) / g.duration, 0, 1);
    // An even pace, in order of creation. Pacing by timestamp stalled and then
    // burst: a vault imported in one afternoon has most of its notes created
    // within minutes of each other, and one note dated years back stretches the
    // timeline so everything else lands in its last second.
    const due = Math.ceil(p * g.order.length);
    while (g.next < due) {
      const n = g.order[g.next++]!;
      this.spawn(n, g.activeSet);
      n.bornAt = now;
      this.appearingUntil = now + APPEAR_MS;
      g.active.push(n);
      g.activeSet.add(n);
      g.dirty = true;
    }
    // Rebuilding the map's land costs more than growing a simulation, so it waits longer.
    if (g.dirty && now - g.lastSync > (this.isMap ? 200 : 90)) {
      g.lastSync = now;
      g.dirty = false;
      this.syncGrowth();
    }
    if (p >= 1 && g.next >= g.order.length) {
      this.growth = null;
      this.settleAfterGrowth(0.3);
    }
  }

  private syncGrowth(): void {
    const g = this.growth!;
    this.brainTarget = brainScaleFor(g.active.length);
    if (this.isMap) {
      this.rebuildLand();
      return;
    }
    // The brain's lobes move out as it grows.
    this.shape();
    if (!g.active.length) {
      // Nothing exists yet: no simulation to tick until the first note appears.
      this.stopSim();
      return;
    }
    if (!this.sim) {
      this.makeSim(0.45);
      return;
    }
    // Grow the running simulation in place, so the notes already on screen
    // keep their momentum instead of restarting. Setting the nodes
    // re-initialises every force, anchors included.
    //
    // A copy, never `g.active` itself: d3 keeps the array it is given, so the
    // notes pushed onto it before the next sync were ticked by forces never
    // initialised for them. Their per-node strengths were undefined, their
    // positions went NaN, and d3 then re-seeded them on a spiral hundreds of
    // units out — every 90 ms, for the whole replay.
    this.sim.nodes([...g.active]);
    (this.sim.force('link') as ForceLink<GraphNode, GraphEdge>).links(
      this.model!.edges.filter((e) => g.activeSet.has(e.source) && g.activeSet.has(e.target)),
    );
    this.sim.alpha(Math.max(this.sim.alpha(), 0.45));
  }

  private spawn(n: GraphNode, active: Set<GraphNode>): void {
    const place = this.isMap ? this.territory?.positions.get(n) : undefined;
    if (place) {
      Object.assign(n, { x: place.x, y: place.y, z: 0, vx: 0, vy: 0, vz: 0 });
      return;
    }
    let spread = 6 + this.random() * 10;
    let from: Point | undefined = this.model!.adjacency.get(n)?.find(({ node }) => active.has(node) && Number.isFinite(node.x))?.node;
    if (!from && n.project) {
      const group = this.model!.projects.find((p) => p.id === n.project!.id);
      from = group?.nodes.find((m) => active.has(m) && Number.isFinite(m.x));
    }
    if (!from) {
      from = this.anchors.get(n) ?? { x: 0, y: 0, z: 0 };
      spread = 20 + this.random() * 40;
    }
    const angle = this.random() * Math.PI * 2;
    n.x = from.x + Math.cos(angle) * spread;
    n.y = from.y + Math.sin(angle) * spread;
    n.z = this.is3D ? (from.z || 0) + (this.random() - 0.5) * spread : 0;
    n.vx = n.vy = n.vz = 0;
  }
}
