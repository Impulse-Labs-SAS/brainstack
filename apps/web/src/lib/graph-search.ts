// Searching the graph: which nodes a query and a set of filters find, and in
// what order. Pure, like graph-model.ts, so the rules are testable in Node.
//
// The order matters: it is the order of the results list and of Enter walking
// through the matches. A title that starts with the query beats one that only
// contains it, and any title beats a match found only in the project, the
// folder or the tags.
//
// Filters narrow without a query too: "edited this week" alone lights every
// note edited this week. A search with neither finds nothing — it is off.

import { fold, type GraphNode } from './graph-model';

export type SearchField = 'title' | 'project' | 'path' | 'tags';
export type EditedWithin = 'any' | 'week' | 'month' | 'quarter';
export type SearchKind = 'note' | 'index' | 'topic';
export type LinkFilter = 'any' | 'orphans' | 'hubs';

export interface SearchFilters {
  /** Where the query is looked for. Never empty: the UI keeps at least one. */
  fields: SearchField[];
  edited: EditedWithin;
  /** Empty means every kind. */
  kinds: SearchKind[];
  links: LinkFilter;
  /** Project ids; empty means every project. */
  projects: string[];
  /** Topic labels, as a note carries them; a note needs at least one. Empty means any. */
  tags: string[];
}

export const SEARCH_FIELDS: readonly SearchField[] = ['title', 'project', 'path', 'tags'];
export const DEFAULT_FILTERS: SearchFilters = { fields: [...SEARCH_FIELDS], edited: 'any', kinds: [], links: 'any', projects: [], tags: [] };

const DAY_MS = 86_400_000;
export const EDITED_WITHIN_DAYS: Record<Exclude<EditedWithin, 'any'>, number> = { week: 7, month: 30, quarter: 90 };
/** What `size` a note needs to count as a hub: about five links, index links a quarter each. */
export const HUB_SIZE = 5;

/** How many filters narrow the search; `fields` only changes where the query looks. */
export function activeFilterCount(f: SearchFilters): number {
  return (f.edited !== 'any' ? 1 : 0) + (f.kinds.length ? 1 : 0) + (f.links !== 'any' ? 1 : 0) + (f.projects.length ? 1 : 0) + (f.tags.length ? 1 : 0);
}

export function kindOf(n: Pick<GraphNode, 'kind' | 'isIndex'>): SearchKind {
  return n.kind === 'topic' ? 'topic' : n.isIndex ? 'index' : 'note';
}

function passesFilters(n: GraphNode, f: SearchFilters, now: number): boolean {
  if (f.kinds.length && !f.kinds.includes(kindOf(n))) return false;
  if (f.edited !== 'any' && now - n.updatedAt > EDITED_WITHIN_DAYS[f.edited] * DAY_MS) return false;
  // Size counts links and index links, not shared topics: a note only a
  // shared topic touches is still one nobody linked.
  if (f.links === 'orphans' && (n.kind === 'topic' || n.size > 0)) return false;
  if (f.links === 'hubs' && n.size < HUB_SIZE) return false;
  if (f.projects.length && !(n.project && f.projects.includes(n.project.id))) return false;
  if (f.tags.length) {
    const carried = n.kind === 'topic' ? [n.label] : n.topics;
    if (!carried.some((t) => f.tags.includes(t))) return false;
  }
  return true;
}

// Lower is better. Everything in a title outranks anything found elsewhere.
const EXACT = 0;
const PREFIX = 1;
const WORD = 2;
const INSIDE = 3;
const FIELD_RANK: Record<Exclude<SearchField, 'title'>, number> = { project: 4, path: 5, tags: 6 };

function titleRank(title: string, term: string): number | null {
  if (title === term) return EXACT;
  if (title.startsWith(term)) return PREFIX;
  const at = title.indexOf(term);
  if (at < 0) return null;
  return /[\s\-_/.(:#]/.test(title[at - 1] ?? '') ? WORD : INSIDE;
}

interface Haystack {
  title: string;
  project: string;
  path: string;
  tags: string[];
}

function haystackOf(n: GraphNode): Haystack {
  return {
    title: fold(n.label),
    project: fold(n.project?.label ?? ''),
    // The folders, not the file name: the title already says that.
    path: fold(n.path.split('/').slice(0, -1).join('/')),
    tags: (n.kind === 'topic' ? [] : n.topics).map(fold),
  };
}

function termRank(h: Haystack, term: string, fields: readonly SearchField[]): number | null {
  let best: number | null = null;
  const take = (r: number | null) => {
    if (r !== null && (best === null || r < best)) best = r;
  };
  if (fields.includes('title')) take(titleRank(h.title, term));
  if (fields.includes('project') && h.project.includes(term)) take(FIELD_RANK.project);
  if (fields.includes('path') && h.path.includes(term)) take(FIELD_RANK.path);
  if (fields.includes('tags') && h.tags.some((t) => t.includes(term))) take(FIELD_RANK.tags);
  return best;
}

/**
 * The nodes a search finds, best first; null when there is nothing to search
 * for. Every word of the query has to be found, each in any field searched:
 * "kora plan" finds the plans filed under Kora.
 */
export function searchGraph(nodes: readonly GraphNode[], query: string, filters: SearchFilters, now: number): GraphNode[] | null {
  const phrase = fold(query).trim().replace(/\s+/g, ' ');
  const terms = phrase ? phrase.split(' ') : [];
  if (!terms.length && !activeFilterCount(filters)) return null;
  const fields = filters.fields.length ? filters.fields : SEARCH_FIELDS;

  const found: Array<{ n: GraphNode; score: number }> = [];
  for (const n of nodes) {
    if (!passesFilters(n, filters, now)) continue;
    if (!terms.length) {
      found.push({ n, score: 0 });
      continue;
    }
    const h = haystackOf(n);
    let score = 0;
    for (const term of terms) {
      const r = termRank(h, term, fields);
      if (r === null) {
        score = -1;
        break;
      }
      score += r;
    }
    if (score < 0) continue;
    // The whole query as the title, or its start, before any scattered match.
    if (terms.length > 1 && fields.includes('title')) {
      const whole = titleRank(h.title, phrase);
      if (whole === EXACT || whole === PREFIX) score -= terms.length * INSIDE;
    }
    found.push({ n, score });
  }

  // Without a query nothing ranks by text: the most recently edited come first.
  return found
    .sort((a, b) => a.score - b.score || (terms.length ? b.n.size - a.n.size : b.n.updatedAt - a.n.updatedAt) || a.n.label.localeCompare(b.n.label))
    .map((x) => x.n);
}

/** Where the query sits in a label, for highlighting it in the results list. */
export function matchRange(label: string, query: string): [number, number] | null {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  // `fold` keeps one character per character for the accents it removes, so offsets line up.
  const folded = fold(label);
  if (folded.length !== label.length) return null;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const at = folded.indexOf(term);
    if (at >= 0) return [at, at + term.length];
  }
  return null;
}

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

/** Projects with notes on screen, most notes first. */
export function projectOptions(nodes: readonly GraphNode[]): FilterOption[] {
  const byId = new Map<string, FilterOption>();
  for (const n of nodes) {
    if (!n.project) continue;
    const o = byId.get(n.project.id) ?? { id: n.project.id, label: n.project.label, count: 0 };
    o.count++;
    byId.set(n.project.id, o);
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Topics the notes on screen carry, most carried first. */
export function tagOptions(nodes: readonly GraphNode[]): FilterOption[] {
  const byLabel = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind === 'topic') continue;
    for (const t of n.topics) byLabel.set(t, (byLabel.get(t) ?? 0) + 1);
  }
  return [...byLabel]
    .map(([label, count]) => ({ id: label, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
