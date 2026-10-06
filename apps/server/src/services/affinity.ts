// Affinity for the graph — which notes share a *topic*, and how strongly.
// Pure and DB-free like relatedNotes.ts: NoteService.affinity reads every tag
// and facet in the vault and hands the rows here.
//
// Two decisions carry the whole feature:
//
//  - Only content counts. A tag like `tipo/moc` or `persona/frodo`, or a facet
//    like `status: en-progreso`, says what kind of note it is or who wrote it,
//    not what it is about. Counted as topics they joined everything to
//    everything and the graph said nothing.
//  - Rare beats common. A topic is dropped once it covers more than a quarter
//    of the vault, and what survives weighs 1 / how many notes carry it — the
//    same rarity weighting list_related uses, so the two never disagree about
//    what "related" means.

import { RELATED_IGNORED_FACET_KEYS } from './relatedNotes.js';

/** Tag prefixes that classify a note rather than describe it. */
export const NON_TOPIC_TAG_PREFIXES: readonly string[] = ['tipo/', 'persona/'];
/** Whole tags that do the same. */
export const NON_TOPIC_TAGS: ReadonlySet<string> = new Set(['decisión', 'decision']);
/** Facet keys that record workflow or authorship, on top of the dates and presentation fields. */
export const NON_TOPIC_FACET_KEYS: ReadonlySet<string> = new Set([
  ...RELATED_IGNORED_FACET_KEYS,
  'status',
  'owner',
]);

/** A topic survives while it covers at most this share of the vault… */
export const MAX_TOPIC_SHARE = 0.25;
/** …or this many notes, whichever is larger, so a small vault still has topics. */
export const MIN_TOPIC_CAP = 3;
/** Affinity edges kept per note, strongest first. */
export const EDGES_PER_NOTE = 3;

export type TopicKind = 'tag' | 'facet';

export interface TopicRow {
  /** Stored path of the note carrying it. */
  path: string;
  kind: TopicKind;
  /** Facet key; absent for a tag. */
  key?: string;
  value: string;
}

export interface Topic {
  /** Stable join key: `tag:<tag>` or `facet:<key>:<value>`. */
  id: string;
  kind: TopicKind;
  key: string | null;
  /** What to print: the tag, or the facet's value. */
  label: string;
  /** Stored paths of every note carrying it, sorted. */
  notes: string[];
  /** 1 / notes.length. */
  weight: number;
}

export interface AffinityEdge {
  source: string;
  target: string;
  /** Sum of the weights of every topic the two share. */
  weight: number;
  /** Labels of the shared topics, strongest first. */
  shared: string[];
}

export function isTopicRow(row: Pick<TopicRow, 'kind' | 'key' | 'value'>): boolean {
  if (row.kind === 'tag') {
    const tag = row.value.toLowerCase();
    if (NON_TOPIC_TAGS.has(tag)) return false;
    return !NON_TOPIC_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
  }
  return !NON_TOPIC_FACET_KEYS.has(row.key ?? '');
}

function topicId(row: TopicRow): string {
  return row.kind === 'tag' ? `tag:${row.value}` : `facet:${row.key}:${row.value}`;
}

/**
 * Group rows into topics, keeping those shared by at least two notes and by no
 * more than the cap. `totalNotes` is the size of the vault the rows came from.
 */
export function buildTopics(rows: readonly TopicRow[], totalNotes: number): Topic[] {
  const cap = Math.max(MIN_TOPIC_CAP, Math.floor(totalNotes * MAX_TOPIC_SHARE));
  const byId = new Map<string, { row: TopicRow; notes: Set<string> }>();

  for (const row of rows) {
    if (!isTopicRow(row)) continue;
    const id = topicId(row);
    const entry = byId.get(id) ?? { row, notes: new Set<string>() };
    entry.notes.add(row.path);
    byId.set(id, entry);
  }

  const topics: Topic[] = [];
  for (const [id, { row, notes }] of byId) {
    if (notes.size < 2 || notes.size > cap) continue;
    topics.push({
      id,
      kind: row.kind,
      key: row.kind === 'facet' ? (row.key ?? null) : null,
      label: row.value,
      notes: [...notes].sort(),
      weight: 1 / notes.size,
    });
  }
  // Rarest first, then by label, so the same vault always answers the same way.
  return topics.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}

/**
 * Note-to-note edges from shared topics, keeping each note's strongest
 * `perNote`. An edge survives when it is in the top of *either* end — a note
 * whose only strong tie is to a busy hub still gets to show it.
 */
export function affinityEdges(topics: readonly Topic[], perNote: number = EDGES_PER_NOTE): AffinityEdge[] {
  const pairs = new Map<string, AffinityEdge & { strengths: Map<string, number> }>();

  for (const topic of topics) {
    for (let i = 0; i < topic.notes.length; i++) {
      for (let j = i + 1; j < topic.notes.length; j++) {
        const source = topic.notes[i]!;
        const target = topic.notes[j]!;
        const key = `${source}\u0000${target}`;
        const pair = pairs.get(key) ?? {
          source,
          target,
          weight: 0,
          shared: [],
          strengths: new Map<string, number>(),
        };
        pair.weight += topic.weight;
        pair.strengths.set(topic.label, (pair.strengths.get(topic.label) ?? 0) + topic.weight);
        pairs.set(key, pair);
      }
    }
  }

  const all = [...pairs.values()].map(({ strengths, ...edge }) => ({
    ...edge,
    shared: [...strengths.entries()]
      .sort(([la, a], [lb, b]) => b - a || la.localeCompare(lb))
      .map(([label]) => label),
  }));

  const byNote = new Map<string, AffinityEdge[]>();
  for (const edge of all) {
    for (const end of [edge.source, edge.target]) {
      const list = byNote.get(end) ?? [];
      list.push(edge);
      byNote.set(end, list);
    }
  }

  const kept = new Set<AffinityEdge>();
  for (const list of byNote.values()) {
    list
      .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
      .slice(0, perNote)
      .forEach((edge) => kept.add(edge));
  }

  return all.filter((edge) => kept.has(edge));
}
