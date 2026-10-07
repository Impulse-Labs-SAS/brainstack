// What a crawl replay does, step by step — pure and DB-free, tested directly
// like graph-engine.
//
// `gather_context` answers in milliseconds, so what the Crawl view shows is a
// replay, rebuilt from its answer: each note says why it is there (`via`) —
// the text named it, a search found it, or it was reached from another note.
// That is enough to walk it again in order: first every note the text names,
// then the references nothing could settle, then out along the links from
// each note to what it led to.
//
// The walk itself only ever follows threads the graph draws — written links
// and the structure edges to an index. Two notes no thread joins are crossed
// on a strand of silk spun for the occasion, never by walking through the void.

import type { GraphEdge, GraphModel, GraphNode } from '@/lib/graph-model';

/** The part of `gather_context`'s answer a replay needs. */
export interface CrawlResult {
  notes: Array<{
    path: string;
    title: string;
    isDecision: boolean;
    via:
      | { kind: 'named'; text: string; count: number }
      | { kind: 'search'; term: string; rank: number }
      | { kind: 'linked'; from: string; fromTitle: string; direction: 'out' | 'in'; hop: number };
  }>;
  unresolved: Array<{
    term: string;
    reason: 'no-match' | 'ambiguous';
    candidates?: Array<{ path: string; title: string }>;
  }>;
  coverage: { resolved: number; total: number };
}

export type ReachKind = 'named' | 'linked' | 'decision';

export interface Reach {
  node: GraphNode;
  kind: ReachKind;
  /** One line for a person, as the engine wrote it or close to it. */
  label: string;
}

export type CrawlStep =
  /** Walk to `at`, then reach out to each of `reach`. */
  | { kind: 'visit'; phase: 0 | 1; at: GraphNode; reach: Reach[] }
  /** Stay put and reach into the void, or to the candidates the reference could mean. */
  | { kind: 'ask'; term: string; why: string; candidates: GraphNode[] }
  | { kind: 'finish' };

export interface CrawlPlan {
  steps: CrawlStep[];
  /** Notes the answer returned that the graph does not show (hidden by a layer, say). */
  offGraph: number;
  coverage: { resolved: number; total: number };
}

/** The viewer's own notes by path: `gather_context` reads the own vault only. */
function ownNodes(model: GraphModel): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const n of model.nodes) if (n.kind === 'note' && !n.foreign) map.set(n.path, n);
  return map;
}

export function planCrawl(result: CrawlResult, model: GraphModel): CrawlPlan {
  const byPath = ownNodes(model);
  const steps: CrawlStep[] = [];
  let offGraph = 0;

  const seeds = result.notes.filter((n) => n.via.kind !== 'linked');
  const linked = result.notes.filter((n) => n.via.kind === 'linked');

  for (const n of seeds) {
    const node = byPath.get(n.path);
    if (!node) {
      offGraph++;
      continue;
    }
    const via = n.via;
    const label =
      via.kind === 'search' ? `${n.title} · matches “${via.term}”` : `${n.title} · named`;
    steps.push({ kind: 'visit', phase: 0, at: node, reach: [{ node, kind: 'named', label }] });
  }

  for (const u of result.unresolved) {
    const candidates = (u.candidates ?? [])
      .map((c) => byPath.get(c.path))
      .filter((n): n is GraphNode => !!n);
    const why =
      u.reason === 'ambiguous'
        ? `${u.candidates?.length ?? 0} notes could be meant`
        : 'no note says it';
    steps.push({ kind: 'ask', term: u.term, why, candidates });
  }

  // Out along the links, grouped by the note each one was reached from, in
  // the order those notes were themselves reached.
  const byFrom = new Map<string, typeof linked>();
  for (const n of linked) {
    if (n.via.kind !== 'linked') continue;
    const list = byFrom.get(n.via.from) ?? [];
    list.push(n);
    byFrom.set(n.via.from, list);
  }
  const order = [...seeds.map((n) => n.path)];
  for (let i = 0; i < order.length; i++) {
    const from = order[i]!;
    const children = byFrom.get(from);
    if (!children) continue;
    byFrom.delete(from);
    const at = byPath.get(from);
    const reach: Reach[] = [];
    for (const c of children) {
      order.push(c.path);
      const node = byPath.get(c.path);
      if (!node) {
        offGraph++;
        continue;
      }
      reach.push({
        node,
        kind: c.isDecision ? 'decision' : 'linked',
        label: `${c.title} · ${c.isDecision ? 'decision' : 'linked'}`,
      });
    }
    if (at && reach.length > 0) steps.push({ kind: 'visit', phase: 1, at, reach });
  }
  // Anything reached from a note the graph does not show still counts.
  for (const rest of byFrom.values()) offGraph += rest.length;

  steps.push({ kind: 'finish' });
  return { steps, offGraph, coverage: result.coverage };
}

/** Threads a spider walks: links someone wrote, and structure edges to an index. */
export function walkable(e: GraphEdge): boolean {
  return e.kind === 'link' || e.kind === 'structure';
}

export function distance(a: GraphNode, b: GraphNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

/**
 * The shortest walk along threads from `from` to `to`, weighted by length;
 * threads already walked cost a little less, so the spider keeps to its own
 * path when one is as good. Null when no thread joins them.
 */
export function findWalk(
  model: Pick<GraphModel, 'adjacency'>,
  from: GraphNode,
  to: GraphNode,
  walked: ReadonlySet<GraphEdge> = new Set(),
): GraphNode[] | null {
  if (from === to) return [from];
  const dist = new Map<GraphNode, number>([[from, 0]]);
  const prev = new Map<GraphNode, GraphNode>();
  const done = new Set<GraphNode>();
  // A vault is a few thousand notes at most: a linear scan for the next node
  // is simpler than a heap and fast enough at that size.
  const open = new Set<GraphNode>([from]);
  while (open.size > 0) {
    let u: GraphNode | null = null;
    let best = Infinity;
    for (const n of open) {
      const d = dist.get(n)!;
      if (d < best) {
        best = d;
        u = n;
      }
    }
    if (!u) break;
    if (u === to) break;
    open.delete(u);
    done.add(u);
    for (const { node: v, edge } of model.adjacency.get(u) ?? []) {
      if (!walkable(edge) || done.has(v)) continue;
      const w = distance(u, v) * (walked.has(edge) ? 0.8 : 1);
      const d = best + w;
      if (d < (dist.get(v) ?? Infinity)) {
        dist.set(v, d);
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
