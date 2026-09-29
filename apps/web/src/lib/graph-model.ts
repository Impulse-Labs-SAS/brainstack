// What the graph simulates and draws, built from what the server sent. Pure —
// no canvas, no WebGL, no React — so the rules about what connects to what
// are testable in Node like graph-structure.ts.
//
// The edge kinds, and why they never look alike:
//
//  - `link`: a wikilink someone wrote. Solid. The only kind that is a fact.
//  - `structure`: a link to or from a MOC index. Faint: it says where a note is
//    filed, not what it is about.
//  - `affinity`: two notes share a rare topic, but nobody linked them. Dotted
//    and never glowing. Drawing it like a link is what got the first
//    ego-graph removed — it claimed connections that did not exist.
//  - `topic`: a note to the topic node it carries, when topics are nodes.
//
// Views (brain, network, territories) only change how the layout is shaped.
// Layers change what is in the model: which vaults, which kinds of edge,
// whether indexes and topics are nodes — plus whether the map shows every
// route at rest, which is drawing, not content.

import {
  OTHER_VAULT_COLOR,
  OWN_VAULT_COLOR,
  SHARED_VAULT_COLORS,
  TOPIC_COLOR,
  type VaultColor,
} from './graph-palette';
import { isIndexNote, isStructureEdge } from './graph-structure';

export type GraphView = 'brain' | 'network' | 'territories';
export const GRAPH_VIEWS: readonly GraphView[] = ['brain', 'network', 'territories'];
export type EdgeKind = 'link' | 'structure' | 'affinity' | 'topic';

/** The vault key for the viewer's own notes; a shared vault is keyed by its owner's id. */
export const OWN_VAULT = 'own';

export interface ProjectRef {
  id: string;
  label: string;
}
export interface InputNode {
  /** Stored path: unique across owners, used to join nodes to edges. */
  id: string;
  /** Path as its owner writes it, for display and navigation. */
  path: string;
  title: string;
  ownerId: string | null;
  project: ProjectRef;
  createdAt: number;
  updatedAt: number;
}
export interface InputEdge {
  source: string;
  target: string;
  weight: number;
}
export interface InputTopic {
  id: string;
  kind: 'tag' | 'facet';
  key: string | null;
  label: string;
  /** Stored paths of the notes carrying it. */
  notes: string[];
  weight: number;
}
export interface InputAffinityEdge {
  source: string;
  target: string;
  weight: number;
  shared: string[];
}
export interface AffinityInput {
  topics: InputTopic[];
  edges: InputAffinityEdge[];
}

export interface GraphLayers {
  hiddenVaults: string[];
  affinity: boolean;
  indexes: boolean;
  topics: boolean;
  /** Territories: every link drawn faintly over the map, not only the routes of what you point at. */
  routes: boolean;
}
export const DEFAULT_LAYERS: GraphLayers = { hiddenVaults: [], affinity: true, indexes: true, topics: false, routes: false };

export interface GraphNode {
  id: string;
  kind: 'note' | 'topic';
  path: string;
  title: string;
  /** The title without a trailing "— Project" that the node's position already says. */
  label: string;
  ownerId: string | null;
  vault: string;
  /** Somebody else's note: drawn with a ring, opened under the shared route. */
  foreign: boolean;
  isIndex: boolean;
  /** The project a note belongs to. Null for a topic. */
  project: ProjectRef | null;
  createdAt: number;
  updatedAt: number;
  /** Topic labels the note carries (own vault only, like affinity). */
  topics: string[];
  /** For a topic node: how many visible notes carry it. */
  carriers: number;
  /** Edges touching it, every kind. */
  degree: number;
  /** What radius and label priority go by: links count 1, index links a quarter. */
  size: number;
  /** World units. */
  radius: number;
  /** The radius drawn this frame: `radius`, eased towards an even city size on the map. */
  drawRadius: number;
  // Layout, in world units. The cache keeps these across rebuilds, so turning
  // a layer on or off never reshuffles the map.
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  /** performance.now() when it appears; -Infinity for always, Infinity for not yet. */
  bornAt: number;
  /** A per-node offset so active notes do not pulse in unison. */
  phase: number;
  // Screen projection, rewritten every frame by the renderer.
  sx: number;
  sy: number;
  sDepth: number;
  /** Screen pixels per world unit at the node's depth. */
  sScale: number;
  /** 1 in front, fading towards the back of the brain. */
  sFade: number;
  onScreen: boolean;
}

export interface GraphEdge {
  source: GraphNode;
  target: GraphNode;
  kind: EdgeKind;
  weight: number;
  /** Topics the two ends share (affinity), or the topic itself (topic). */
  shared: string[];
}
export interface Neighbour {
  node: GraphNode;
  edge: GraphEdge;
}
export interface ProjectGroup {
  id: string;
  label: string;
  vault: string;
  nodes: GraphNode[];
}
/** How a shared vault is named: the folders its owner shared with you, and who they are. */
export interface SharedVaultName {
  label: string;
  owner: string;
}
export interface VaultSummary {
  id: string;
  label: string;
  /** Who shared it; null for your own vault. */
  owner: string | null;
  own: boolean;
  /** Notes in the vault, visible or not. */
  total: number;
  hidden: boolean;
  color: VaultColor;
}
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  adjacency: Map<GraphNode, Neighbour[]>;
  projects: ProjectGroup[];
  vaults: VaultSummary[];
  /** Biggest first: who gets a label when they do not all fit. */
  labelOrder: GraphNode[];
}

const SEPARATORS = [' — ', ' – ', ' - '];

export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * "Arquitectura — Seek & Destroy" reads "Arquitectura" when the node already
 * sits in Seek & Destroy's region. Only a trailing part that names the
 * project goes; anything else after a dash is part of the title.
 */
export function shortLabel(title: string, projectLabel: string | null): string {
  if (!projectLabel) return title;
  const project = fold(projectLabel).trim();
  for (const sep of SEPARATORS) {
    const at = title.lastIndexOf(sep);
    if (at <= 0) continue;
    const tail = fold(title.slice(at + sep.length)).trim();
    if (tail && project && (project.includes(tail) || tail.includes(project))) return title.slice(0, at);
  }
  return title;
}

export function vaultOf(ownerId: string | null, viewerId: string | null): string {
  return ownerId && viewerId && ownerId !== viewerId ? ownerId : OWN_VAULT;
}

export function topicLabel(topic: Pick<InputTopic, 'key' | 'label'>): string {
  return topic.key ? `${topic.key}: ${topic.label}` : `#${topic.label}`;
}

/** Deterministic 0..1 from a string: the same note breathes the same way every visit. */
export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const DAY_MS = 86_400_000;

/** How recently a note was edited, as brightness: this week is fully lit, last year an ember. */
export function activity(updatedAt: number, now: number): number {
  const days = (now - updatedAt) / DAY_MS;
  return days <= 7 ? 1 : days <= 30 ? 0.78 : days <= 120 ? 0.55 : 0.36;
}

/** Edited in the last week: these breathe. */
export function isActive(updatedAt: number, now: number): boolean {
  return now - updatedAt <= 7 * DAY_MS;
}

export function nodeRadius(node: Pick<GraphNode, 'kind' | 'isIndex' | 'size' | 'carriers'>): number {
  if (node.kind === 'topic') return 3 + Math.sqrt(node.carriers) * 0.9;
  return (node.isIndex ? 3.2 : 2.4) + Math.sqrt(node.size) * 1.55;
}

/**
 * On the map every note is a city of the same size and the index a capital a
 * little bigger: cities sit a fixed distance apart, and a hub drawn by its
 * connections would cover its neighbours. How connected a note is shows on hover.
 */
export function cityRadius(node: Pick<GraphNode, 'isIndex'>): number {
  return node.isIndex ? 4.2 : 2.6;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function cached(cache: Map<string, GraphNode>, id: string): GraphNode {
  const hit = cache.get(id);
  if (hit) return hit;
  const node: GraphNode = {
    id,
    kind: 'note',
    path: '',
    title: '',
    label: '',
    ownerId: null,
    vault: OWN_VAULT,
    foreign: false,
    isIndex: false,
    project: null,
    createdAt: 0,
    updatedAt: 0,
    topics: [],
    carriers: 0,
    degree: 0,
    size: 0,
    radius: 3,
    drawRadius: 3,
    x: Number.NaN,
    y: Number.NaN,
    z: Number.NaN,
    vx: 0,
    vy: 0,
    vz: 0,
    bornAt: -Infinity,
    phase: hash01(id) * Math.PI * 2,
    sx: 0,
    sy: 0,
    sDepth: 0,
    sScale: 1,
    sFade: 1,
    onScreen: false,
  };
  cache.set(id, node);
  return node;
}

/** A folder's own name: the last segment of its path. */
const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * Names every shared vault after the folders its owner shared with you, as the
 * file tree does, with the person beside them. One person may share several.
 */
export function sharedVaultNames(
  roots: readonly { ownerId: string; folderPath: string; ownerDisplayName: string | null; ownerEmail: string }[],
): Map<string, SharedVaultName> {
  const byOwner = new Map<string, { folders: Set<string>; owner: string }>();
  for (const r of roots) {
    const entry = byOwner.get(r.ownerId) ?? { folders: new Set<string>(), owner: r.ownerDisplayName ?? r.ownerEmail.split('@')[0] ?? r.ownerEmail };
    entry.folders.add(folderName(r.folderPath));
    byOwner.set(r.ownerId, entry);
  }
  const out = new Map<string, SharedVaultName>();
  for (const [id, { folders, owner }] of byOwner) {
    out.set(id, { label: [...folders].sort((a, b) => a.localeCompare(b)).join(', '), owner });
  }
  return out;
}

/**
 * Every vault in the input, yours first. Colours go by owner, then label, so a
 * vault keeps its colour when another one appears or is hidden — and when its
 * owner shares one more folder.
 */
export function summariseVaults(
  nodes: readonly InputNode[],
  viewerId: string | null,
  vaultNames: ReadonlyMap<string, SharedVaultName>,
  hiddenVaults: readonly string[],
): VaultSummary[] {
  const totals = new Map<string, number>();
  for (const n of nodes) {
    const v = vaultOf(n.ownerId, viewerId);
    totals.set(v, (totals.get(v) ?? 0) + 1);
  }
  const hidden = new Set(hiddenVaults);
  const shared = [...totals.keys()]
    .filter((v) => v !== OWN_VAULT)
    .map((id) => ({ id, label: vaultNames.get(id)?.label ?? 'Shared vault', owner: vaultNames.get(id)?.owner ?? null }))
    .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const out: VaultSummary[] = [];
  if (totals.has(OWN_VAULT)) {
    out.push({ id: OWN_VAULT, label: 'Your vault', owner: null, own: true, total: totals.get(OWN_VAULT)!, hidden: hidden.has(OWN_VAULT), color: OWN_VAULT_COLOR });
  }
  shared.forEach(({ id, label, owner }, i) => {
    out.push({ id, label, owner, own: false, total: totals.get(id)!, hidden: hidden.has(id), color: SHARED_VAULT_COLORS[i] ?? OTHER_VAULT_COLOR });
  });
  return out;
}

export function colorOf(model: Pick<GraphModel, 'vaults'>, node: Pick<GraphNode, 'kind' | 'vault'>): VaultColor {
  if (node.kind === 'topic') return TOPIC_COLOR;
  return model.vaults.find((v) => v.id === node.vault)?.color ?? OTHER_VAULT_COLOR;
}

export function buildGraphModel(input: {
  nodes: readonly InputNode[];
  edges: readonly InputEdge[];
  affinity: AffinityInput | null;
  layers: GraphLayers;
  viewerId: string | null;
  /** Names of the shared vaults, by owner id (see `sharedVaultNames`). */
  vaultNames: ReadonlyMap<string, SharedVaultName>;
  /** Node objects from earlier builds, so positions survive a rebuild. */
  cache: Map<string, GraphNode>;
}): GraphModel {
  const { nodes, edges, affinity, layers, viewerId, vaultNames, cache } = input;
  const vaults = summariseVaults(nodes, viewerId, vaultNames, layers.hiddenVaults);
  const hidden = new Set(layers.hiddenVaults);

  const topicsByNote = new Map<string, string[]>();
  for (const t of affinity?.topics ?? []) {
    for (const id of t.notes) {
      const list = topicsByNote.get(id) ?? [];
      list.push(topicLabel(t));
      topicsByNote.set(id, list);
    }
  }

  const map = new Map<string, GraphNode>();
  for (const n of nodes) {
    const vault = vaultOf(n.ownerId, viewerId);
    if (hidden.has(vault)) continue;
    const isIndex = isIndexNote(n.path);
    if (isIndex && !layers.indexes) continue;
    const node = cached(cache, n.id);
    node.kind = 'note';
    node.path = n.path;
    node.title = n.title;
    node.label = shortLabel(n.title, n.project.label);
    node.ownerId = n.ownerId;
    node.vault = vault;
    node.foreign = vault !== OWN_VAULT;
    node.isIndex = isIndex;
    node.project = n.project;
    node.createdAt = n.createdAt;
    node.updatedAt = n.updatedAt;
    node.topics = topicsByNote.get(n.id) ?? [];
    node.carriers = 0;
    map.set(n.id, node);
  }

  const out: GraphEdge[] = [];
  // Links arrive directed, but the graph is not: two notes that link to each
  // other are one line, carrying both directions' weight. Kept apart, the
  // pair drew twice, counted twice in degree and size, and listed the same
  // neighbour twice in the preview.
  const linked = new Map<string, GraphEdge>();
  for (const e of edges) {
    const source = map.get(e.source);
    const target = map.get(e.target);
    if (!source || !target || source === target) continue;
    const key = pairKey(source.id, target.id);
    const existing = linked.get(key);
    if (existing) {
      existing.weight += e.weight;
      continue;
    }
    const kind: EdgeKind = isStructureEdge(source.path, target.path) ? 'structure' : 'link';
    const edge: GraphEdge = { source, target, kind, weight: e.weight, shared: [] };
    out.push(edge);
    linked.set(key, edge);
  }

  if (layers.affinity && affinity) {
    for (const e of affinity.edges) {
      const source = map.get(e.source);
      const target = map.get(e.target);
      // Already linked: the solid line says more than a dotted one would.
      if (!source || !target || linked.has(pairKey(source.id, target.id))) continue;
      out.push({ source, target, kind: 'affinity', weight: e.weight, shared: e.shared });
    }
  }

  if (layers.topics && affinity) {
    for (const t of affinity.topics) {
      const carriers = t.notes.map((id) => map.get(id)).filter((n): n is GraphNode => !!n);
      // A topic only one visible note carries connects nothing on screen.
      if (carriers.length < 2) continue;
      const label = topicLabel(t);
      const node = cached(cache, `topic:${t.id}`);
      node.kind = 'topic';
      node.path = label;
      node.title = label;
      node.label = label;
      node.ownerId = viewerId;
      node.vault = OWN_VAULT;
      node.foreign = false;
      node.isIndex = false;
      node.project = null;
      // A topic connects nothing until a second note carries it: that is when it is born.
      node.createdAt = carriers.map((c) => c.createdAt).sort((a, b) => a - b)[1]!;
      node.updatedAt = Math.max(...carriers.map((c) => c.updatedAt));
      node.topics = [];
      node.carriers = carriers.length;
      map.set(node.id, node);
      for (const c of carriers) out.push({ source: c, target: node, kind: 'topic', weight: 1, shared: [label] });
    }
  }

  const modelNodes = [...map.values()];
  const adjacency = new Map<GraphNode, Neighbour[]>();
  for (const n of modelNodes) {
    n.degree = 0;
    n.size = n.kind === 'topic' ? n.carriers * 0.5 : 0;
    adjacency.set(n, []);
  }
  for (const e of out) {
    e.source.degree += 1;
    e.target.degree += 1;
    const step = e.kind === 'link' ? 1 : e.kind === 'structure' ? 0.25 : 0;
    e.source.size += step;
    e.target.size += step;
    adjacency.get(e.source)!.push({ node: e.target, edge: e });
    adjacency.get(e.target)!.push({ node: e.source, edge: e });
  }

  const projects = new Map<string, ProjectGroup>();
  for (const n of modelNodes) {
    n.radius = nodeRadius(n);
    n.drawRadius = n.radius;
    if (!n.project) continue;
    const group = projects.get(n.project.id) ?? { id: n.project.id, label: n.project.label, vault: n.vault, nodes: [] };
    group.nodes.push(n);
    projects.set(n.project.id, group);
  }

  return {
    nodes: modelNodes,
    edges: out,
    adjacency,
    projects: [...projects.values()],
    vaults,
    labelOrder: [...modelNodes].sort((a, b) => b.size - a.size),
  };
}

/**
 * Where a click opens a note. Someone else's note lives under the shared
 * route, which carries the owner; the plain route resolves against the viewer.
 * Each segment is encoded: a note called "FAQ #1" or "100%" must survive the
 * route, and both note pages decode the path back.
 */
export function noteHref(node: Pick<GraphNode, 'path' | 'foreign' | 'ownerId'>): string {
  const route = node.path.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/');
  return node.foreign && node.ownerId ? `/notes/shared/${encodeURIComponent(node.ownerId)}/${route}` : `/notes/${route}`;
}

/**
 * The neighbour of `from` that lies most nearly in screen direction (dx, dy),
 * for walking links with the arrow keys. Uses the last projected screen
 * positions; ignores neighbours more than ~70° off the direction.
 */
export function neighbourToward(model: Pick<GraphModel, 'adjacency'>, from: GraphNode, dx: number, dy: number): GraphNode | null {
  let best: GraphNode | null = null;
  let bestScore = 0.35;
  for (const { node } of model.adjacency.get(from) ?? []) {
    if (!node.onScreen) continue;
    const vx = node.sx - from.sx;
    const vy = node.sy - from.sy;
    const score = (vx * dx + vy * dy) / (Math.hypot(vx, vy) || 1);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

/** Every node within `max` hops of `start`, with its distance. */
export function hopsFrom(model: Pick<GraphModel, 'adjacency'>, start: GraphNode, max = 2): Map<GraphNode, number> {
  const hops = new Map<GraphNode, number>([[start, 0]]);
  let frontier = [start];
  for (let h = 1; h <= max; h++) {
    const next: GraphNode[] = [];
    for (const u of frontier) {
      for (const { node } of model.adjacency.get(u) ?? []) {
        if (hops.has(node)) continue;
        hops.set(node, h);
        next.push(node);
      }
    }
    frontier = next;
  }
  return hops;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** It needed a shared topic or a topic node: nobody linked the whole way. */
  implicit: boolean;
}

function breadthFirst(model: Pick<GraphModel, 'adjacency'>, a: GraphNode, b: GraphNode, kinds: ReadonlySet<EdgeKind> | null): GraphPath | null {
  const prev = new Map<GraphNode, { from: GraphNode; edge: GraphEdge } | null>([[a, null]]);
  const queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]!;
    if (u === b) break;
    for (const { node, edge } of model.adjacency.get(u) ?? []) {
      if (kinds && !kinds.has(edge.kind)) continue;
      if (prev.has(node)) continue;
      prev.set(node, { from: u, edge });
      queue.push(node);
    }
  }
  if (!prev.has(b)) return null;
  const nodes = [b];
  const edges: GraphEdge[] = [];
  for (let step = prev.get(b); step; step = prev.get(step.from)) {
    edges.unshift(step.edge);
    nodes.unshift(step.from);
  }
  return { nodes, edges, implicit: edges.some((e) => e.kind === 'affinity' || e.kind === 'topic') };
}

/** The shortest path through what people wrote; failing that, through anything drawn. */
export function findPath(model: Pick<GraphModel, 'adjacency'>, a: GraphNode, b: GraphNode): GraphPath | null {
  return breadthFirst(model, a, b, new Set<EdgeKind>(['link', 'structure'])) ?? breadthFirst(model, a, b, null);
}
