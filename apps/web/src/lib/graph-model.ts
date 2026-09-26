// Builds what the graph simulates and draws from what the server sent: note
// nodes, topic nodes, project nodes, and the four kinds of edge between them.
// Pure — no canvas, no React — so the rules about what connects to what are
// testable in Node like graph-structure.ts.
//
// The four kinds, and why they never look alike:
//
//  - `link`: a wikilink someone wrote. Solid. The only kind that is a fact.
//  - `structure`: a link to or from a MOC index. Faint: it says where a note is
//    filed, not what it is about.
//  - `affinity`: two notes share a rare content topic (a tag or a facet), but
//    nobody linked them. Dashed. Drawing it like a link is what got the first
//    ego-graph removed — it claimed connections that did not exist.
//  - `topic`: a note to the topic node it carries, in the topics view.
//
// The projects view is the same notes folded one node per project, so the
// question "how do my projects relate?" stays readable at fifty projects. It
// changes nothing about the other three views.

import { isIndexNote, isStructureEdge } from './graph-structure';

export type GraphMode = 'links' | 'affinity' | 'topics' | 'projects';
export type EdgeKind = 'link' | 'structure' | 'affinity' | 'topic';

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

export interface SimNode {
  id: string;
  kind: 'note' | 'topic' | 'project';
  path: string;
  title: string;
  ownerId: string | null;
  /** The project a note belongs to; for a project node, itself. Null for a topic. */
  project: ProjectRef | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Edges touching it, every kind: what the springs balance on. */
  degree: number;
  /** What radius and label priority go by: links count 1, index links a quarter, affinity nothing. */
  size: number;
  foreign: boolean;
  isIndex: boolean;
  /** Where the user parked it. Set by dragging; the sim never overrides it. */
  fx: number | null;
  fy: number | null;
}

export interface SimEdge {
  source: SimNode;
  target: SimNode;
  kind: EdgeKind;
  weight: number;
  /** Spring constant: an edge between hubs pulls less, as in d3-force. */
  strength: number;
  /** How the correction splits between the ends, by relative degree. */
  bias: number;
  distance: number;
  /** For an affinity edge: the topics the two ends share, strongest first. */
  shared: string[];
}

export interface Neighbour {
  id: string;
  title: string;
  /** Topics shared with it, strongest first; empty when only links join them. */
  shared: string[];
  /** Links between the two (a project pair counts every note link). */
  links: number;
}

export interface ProjectSummary extends ProjectRef {
  count: number;
}

export interface GraphModel {
  simNodes: SimNode[];
  simEdges: SimEdge[];
  /** Every node's neighbours, across every kind of edge drawn. */
  neighbours: Map<string, Set<string>>;
  /** For the hover card: who a node is affine or linked to, and through what. */
  related: Map<string, Neighbour[]>;
  counts: {
    notes: number;
    links: number;
    structure: number;
    affinity: number;
    topics: number;
    projects: number;
    foreign: number;
  };
}

export const LINK_DISTANCE = 78; // plus both radii, so hubs hold their ring wider
// An index edge still holds a folder together, just loosely enough that the
// links between notes decide the shape.
export const STRUCTURE_STRENGTH = 0.3;
export const STRUCTURE_SIZE_WEIGHT = 0.25;
// Affinity pulls related projects toward each other without folding them into
// one ball: weak, and longer than a link.
export const AFFINITY_STRENGTH = 0.25;
export const AFFINITY_DISTANCE_FACTOR = 1.5;
export const TOPIC_STRENGTH = 0.5;

const NODE_BASE_RADIUS = 4.5;
const NODE_DEGREE_SCALE = 2.6;
const TOPIC_RADIUS = 6;
const PROJECT_BASE_RADIUS = 7;
const PROJECT_SCALE = 3.2;

/** The id a project gets as a node, kept apart from any note id. */
export function projectNodeId(projectId: string): string {
  return `project:${projectId}`;
}

export function worldRadius(node: SimNode): number {
  if (node.kind === 'topic') return TOPIC_RADIUS;
  if (node.kind === 'project') return PROJECT_BASE_RADIUS + Math.sqrt(node.size) * PROJECT_SCALE;
  return NODE_BASE_RADIUS + Math.sqrt(node.size) * NODE_DEGREE_SCALE;
}

/** Every project with its note count, largest first, ties by name. */
export function summariseProjects(nodes: readonly InputNode[]): ProjectSummary[] {
  const byId = new Map<string, ProjectSummary>();
  for (const node of nodes) {
    const entry = byId.get(node.project.id) ?? { ...node.project, count: 0 };
    entry.count += 1;
    byId.set(node.project.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function place(i: number): { x: number; y: number } {
  // Phyllotaxis, not random: the same vault lays out the same way twice, and
  // no two nodes start on top of each other.
  const radius = 12 * Math.sqrt(0.5 + i);
  const angle = i * Math.PI * (3 - Math.sqrt(5));
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

interface RawEdge {
  source: SimNode;
  target: SimNode;
  kind: EdgeKind;
  weight: number;
  shared: string[];
}

function finish(
  map: Map<string, SimNode>,
  raw: RawEdge[],
  related: Map<string, Neighbour[]>,
  extra: { topics: number; projects: number },
): GraphModel {
  const adjacency = new Map<string, Set<string>>();
  for (const { source, target } of raw) {
    source.degree += 1;
    target.degree += 1;
    if (!adjacency.has(source.id)) adjacency.set(source.id, new Set());
    if (!adjacency.has(target.id)) adjacency.set(target.id, new Set());
    adjacency.get(source.id)!.add(target.id);
    adjacency.get(target.id)!.add(source.id);
  }

  const factor: Record<EdgeKind, number> = {
    link: 1,
    structure: STRUCTURE_STRENGTH,
    affinity: AFFINITY_STRENGTH,
    topic: TOPIC_STRENGTH,
  };
  const simEdges: SimEdge[] = raw.map(({ source, target, kind, weight, shared }) => ({
    source,
    target,
    kind,
    weight,
    shared,
    strength: (1 / Math.min(source.degree, target.degree)) * factor[kind],
    bias: source.degree / (source.degree + target.degree),
    distance:
      (LINK_DISTANCE + worldRadius(source) + worldRadius(target)) *
      (kind === 'affinity' ? AFFINITY_DISTANCE_FACTOR : 1),
  }));

  const simNodes = Array.from(map.values());
  const count = (kind: EdgeKind) => simEdges.filter((e) => e.kind === kind).length;
  return {
    simNodes,
    simEdges,
    neighbours: adjacency,
    related,
    counts: {
      notes: simNodes.filter((n) => n.kind === 'note').length,
      links: count('link'),
      structure: count('structure'),
      affinity: count('affinity'),
      topics: extra.topics,
      projects: extra.projects,
      foreign: simNodes.filter((n) => n.foreign).length,
    },
  };
}

export function buildGraphModel(input: {
  nodes: readonly InputNode[];
  edges: readonly InputEdge[];
  affinity: AffinityInput | null;
  mode: GraphMode;
  showIndexes: boolean;
  isForeign: (ownerId: string | null) => boolean;
}): GraphModel {
  if (input.mode === 'projects') return buildProjectModel(input);

  const { nodes, edges, affinity, mode, showIndexes, isForeign } = input;
  const shown = showIndexes ? nodes : nodes.filter((n) => !isIndexNote(n.path));

  const map = new Map<string, SimNode>();
  shown.forEach((n, i) => {
    map.set(n.id, {
      id: n.id,
      kind: 'note',
      path: n.path,
      title: n.title,
      ownerId: n.ownerId,
      project: n.project,
      ...place(i),
      vx: 0,
      vy: 0,
      degree: 0,
      size: 0,
      foreign: isForeign(n.ownerId),
      isIndex: isIndexNote(n.path),
      fx: null,
      fy: null,
    });
  });

  const raw: RawEdge[] = [];
  const linked = new Set<string>();

  for (const e of edges) {
    const s = map.get(e.source);
    const t = map.get(e.target);
    if (!s || !t || s === t) continue;
    const kind: EdgeKind = isStructureEdge(s.path, t.path) ? 'structure' : 'link';
    const sizeStep = kind === 'structure' ? STRUCTURE_SIZE_WEIGHT : 1;
    s.size += sizeStep;
    t.size += sizeStep;
    raw.push({ source: s, target: t, kind, weight: e.weight, shared: [] });
    linked.add(pairKey(s.id, t.id));
  }

  const related = new Map<string, Neighbour[]>();
  let topicCount = 0;

  if (affinity && mode === 'affinity') {
    for (const e of affinity.edges) {
      const s = map.get(e.source);
      const t = map.get(e.target);
      if (!s || !t) continue;
      const note = (from: SimNode, to: SimNode) => {
        const list = related.get(from.id) ?? [];
        list.push({ id: to.id, title: to.title, shared: e.shared, links: 0 });
        related.set(from.id, list);
      };
      note(s, t);
      note(t, s);
      // Already linked: the solid line says more than a dashed one would, and
      // two lines on one pair is noise. The hover card still names the topics.
      if (linked.has(pairKey(s.id, t.id))) continue;
      raw.push({ source: s, target: t, kind: 'affinity', weight: e.weight, shared: e.shared });
    }
  }

  if (affinity && mode === 'topics') {
    let i = map.size;
    for (const topic of affinity.topics) {
      const carriers = topic.notes.map((id) => map.get(id)).filter((n): n is SimNode => !!n);
      // A topic only one visible note carries connects nothing on screen.
      if (carriers.length < 2) continue;
      const node: SimNode = {
        id: `topic:${topic.id}`,
        kind: 'topic',
        path: topic.key ? `${topic.key}: ${topic.label}` : `#${topic.label}`,
        title: topic.label,
        ownerId: null,
        project: null,
        ...place(i++),
        vx: 0,
        vy: 0,
        degree: 0,
        size: carriers.length,
        foreign: false,
        isIndex: false,
        fx: null,
        fy: null,
      };
      map.set(node.id, node);
      topicCount += 1;
      for (const carrier of carriers) {
        raw.push({ source: carrier, target: node, kind: 'topic', weight: 1, shared: [] });
      }
    }
  }

  return finish(map, raw, related, { topics: topicCount, projects: 0 });
}

/**
 * One node per project. A link between notes of two projects becomes a solid
 * edge between the projects, weighted by how many there are; topics shared
 * across two projects become a dashed one when nothing links them. Links
 * inside a project fold away — they are what the other views are for.
 */
function buildProjectModel(input: {
  nodes: readonly InputNode[];
  edges: readonly InputEdge[];
  affinity: AffinityInput | null;
  showIndexes: boolean;
  isForeign: (ownerId: string | null) => boolean;
}): GraphModel {
  const { nodes, edges, affinity, showIndexes, isForeign } = input;
  const noteById = new Map(nodes.map((n) => [n.id, n]));

  const map = new Map<string, SimNode>();
  summariseProjects(nodes).forEach((p, i) => {
    const owner = nodes.find((n) => n.project.id === p.id)?.ownerId ?? null;
    map.set(projectNodeId(p.id), {
      id: projectNodeId(p.id),
      kind: 'project',
      path: `${p.count} ${p.count === 1 ? 'nota' : 'notas'}`,
      title: p.label,
      ownerId: owner,
      project: { id: p.id, label: p.label },
      ...place(i),
      vx: 0,
      vy: 0,
      degree: 0,
      size: p.count,
      foreign: isForeign(owner),
      isIndex: false,
      fx: null,
      fy: null,
    });
  });

  const projectOf = (noteId: string) => {
    const note = noteById.get(noteId);
    return note ? map.get(projectNodeId(note.project.id)) : undefined;
  };

  const pairs = new Map<
    string,
    { a: SimNode; b: SimNode; links: number; structure: number; weight: number; shared: Map<string, number> }
  >();
  const pairFor = (a: SimNode, b: SimNode) => {
    const key = pairKey(a.id, b.id);
    const entry = pairs.get(key) ?? { a, b, links: 0, structure: 0, weight: 0, shared: new Map() };
    pairs.set(key, entry);
    return entry;
  };

  for (const e of edges) {
    const a = projectOf(e.source);
    const b = projectOf(e.target);
    if (!a || !b || a === b) continue;
    const source = noteById.get(e.source)!;
    const target = noteById.get(e.target)!;
    if (isStructureEdge(source.path, target.path)) {
      if (showIndexes) pairFor(a, b).structure += e.weight;
    } else {
      pairFor(a, b).links += e.weight;
    }
  }

  // From the topics, not the per-note top edges: a project pair should show
  // every topic its notes share, not only the ones that won a note's top three.
  for (const topic of affinity?.topics ?? []) {
    const projects = [...new Set(topic.notes.map(projectOf).filter((p): p is SimNode => !!p))];
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const entry = pairFor(projects[i]!, projects[j]!);
        entry.weight += topic.weight;
        entry.shared.set(topic.label, (entry.shared.get(topic.label) ?? 0) + topic.weight);
      }
    }
  }

  const raw: RawEdge[] = [];
  const related = new Map<string, Neighbour[]>();
  for (const { a, b, links, structure, weight, shared } of pairs.values()) {
    const labels = [...shared.entries()]
      .sort(([la, x], [lb, y]) => y - x || la.localeCompare(lb))
      .map(([label]) => label);
    if (links > 0) raw.push({ source: a, target: b, kind: 'link', weight: links, shared: labels });
    else if (labels.length > 0) raw.push({ source: a, target: b, kind: 'affinity', weight, shared: labels });
    else if (structure > 0) raw.push({ source: a, target: b, kind: 'structure', weight: structure, shared: [] });
    else continue;

    if (links > 0 || labels.length > 0) {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const list = related.get(from.id) ?? [];
        list.push({ id: to.id, title: to.title, shared: labels, links });
        related.set(from.id, list);
      }
    }
  }
  for (const list of related.values()) {
    list.sort((x, y) => y.links - x.links || y.shared.length - x.shared.length);
  }

  return finish(map, raw, related, { topics: 0, projects: map.size });
}
