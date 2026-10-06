// The scoring half of `gather_context` — pure and DB-free, tested directly in
// Node like relatedNotes.ts. gatherContext.ts does the reading and hands the
// rows here.
//
// A crawl starts from seeds — notes the text names, and the best search hits
// for the phrases the caller found vague — and follows wikilinks out from
// them, both ways, a hop or two. Three decisions carry it:
//
//  - Naming beats searching, and both beat being linked. A note the text names
//    by its title is what the author meant; a search hit is a good guess; a
//    neighbour is context around either. Each hop halves the score.
//  - A decision weighs extra. "What did we already decide" is the question a
//    prompt most often leaves implicit, and the one a guess gets most wrong.
//  - The budget is in characters, not notes. The caller is an assistant with a
//    context window; ten long notes and forty short ones are not the same cost.

/** Why a note is in the result. Exactly one per note: the strongest. */
export type ContextVia =
  | { kind: 'named'; text: string; count: number }
  | { kind: 'search'; term: string; rank: number }
  | { kind: 'linked'; from: string; fromTitle: string; direction: 'out' | 'in'; hop: number };

export interface Candidate {
  path: string;
  score: number;
  via: ContextVia;
}

/** Score of a note the text names by title or alias. */
export const NAMED_SCORE = 1;
/** Score of the best search hit for a term; later hits step down from it. */
export const SEARCH_SCORE = 0.7;
export const SEARCH_RANK_STEP = 0.1;
/** Search hits kept per term. */
export const SEARCH_HITS_PER_TERM = 3;
/** Each hop away from a seed multiplies the score by this. */
export const HOP_DECAY = 0.5;
/** Added to a decision's score once, whatever brought it in. */
export const DECISION_BONUS = 0.25;
/**
 * Notes carried from one hop to the next. A hub — a MOC links to everything in
 * its folder — would otherwise turn the second hop into the whole vault.
 */
export const FRONTIER_LIMIT = 20;

export const DEFAULT_MAX_CHARS = 12_000;
export const MAX_MAX_CHARS = 50_000;
export const MAX_NOTES = 40;
/** A seed gets a longer excerpt than a note reached by a link. */
export const SEED_EXCERPT_CHARS = 1_500;
export const LINKED_EXCERPT_CHARS = 500;
/**
 * Characters of each body read from the store: more than any excerpt uses, so
 * `truncated` stays true for a body longer than its excerpt, and no more, so a
 * vault with a few huge imported notes does not ship them whole on every call.
 */
export const DIGEST_BODY_CHARS = SEED_EXCERPT_CHARS + 500;
/** Below this, a truncated excerpt says too little to be worth its place. */
export const MIN_EXCERPT_CHARS = 120;

/** The candidates found so far, keeping the strongest reason for each note. */
export class CandidateSet {
  private readonly byPath = new Map<string, Candidate>();

  offer(candidate: Candidate): void {
    const current = this.byPath.get(candidate.path);
    if (!current || candidate.score > current.score) this.byPath.set(candidate.path, candidate);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  get(path: string): Candidate | undefined {
    return this.byPath.get(path);
  }

  all(): Candidate[] {
    return [...this.byPath.values()];
  }
}

export function searchScore(rank: number): number {
  return Math.max(0, SEARCH_SCORE - rank * SEARCH_RANK_STEP);
}

/**
 * One hop out from `frontier`: every note linked to or from it that is not
 * already a candidate at a higher score. Returns the notes reached, which are
 * the next frontier.
 */
export function expandHop(
  set: CandidateSet,
  frontier: readonly string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  hop: number,
  titleOf: (path: string) => string,
): string[] {
  const inFrontier = new Set(frontier);
  const reached = new Set<string>();
  for (const { source, target } of edges) {
    for (const [from, to, direction] of [
      [source, target, 'out'],
      [target, source, 'in'],
    ] as const) {
      if (!inFrontier.has(from) || inFrontier.has(to)) continue;
      const parent = set.get(from);
      if (!parent) continue;
      const score = parent.score * HOP_DECAY;
      const before = set.get(to);
      set.offer({
        path: to,
        score,
        via: { kind: 'linked', from, fromTitle: titleOf(from), direction, hop },
      });
      if (set.get(to) !== before) reached.add(to);
    }
  }
  return [...reached];
}

/** The strongest `limit` of `paths`, by their current score. */
export function topFrontier(
  set: CandidateSet,
  paths: readonly string[],
  limit = FRONTIER_LIMIT,
): string[] {
  return [...paths]
    .sort((a, b) => (set.get(b)?.score ?? 0) - (set.get(a)?.score ?? 0) || a.localeCompare(b))
    .slice(0, limit);
}

export interface Digest {
  path: string;
  title: string;
  body: string;
  isDecision: boolean;
}

export interface ContextNote {
  path: string;
  title: string;
  /** One line for a person: why this note is here. */
  reason: string;
  via: ContextVia;
  isDecision: boolean;
  score: number;
  excerpt: string;
  /** True when `excerpt` is not the whole body. */
  truncated: boolean;
}

export function describeVia(via: ContextVia): string {
  switch (via.kind) {
    case 'named':
      return via.count > 1
        ? `the text says "${via.text}" (${via.count}×)`
        : `the text says "${via.text}"`;
    case 'search':
      return `matches "${via.term}"`;
    case 'linked':
      return via.direction === 'out' ? `linked from ${via.fromTitle}` : `links to ${via.fromTitle}`;
  }
}

/**
 * The body, cut at a word boundary to at most `max` characters. Whitespace is
 * kept as written: an excerpt is Markdown an assistant reads, and collapsing
 * it would merge headings and list items into one line.
 */
export function excerpt(body: string, max: number): { text: string; truncated: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  // One character is kept for the ellipsis, so `max` is a ceiling, not a target.
  let cut = trimmed.slice(0, Math.max(0, max - 1));
  // Never split a surrogate pair: half an emoji is not valid text to hand on.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const lastSpace = cut.search(/\s\S*$/);
  const text = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return { text: `${text}…`, truncated: true };
}

/**
 * Rank the candidates and fill the budget, best first. A note that does not
 * fit is shortened while what is left is worth reading; once it is not, the
 * crawl stops rather than skipping ahead to smaller, weaker notes.
 */
export function packContext(
  candidates: readonly Candidate[],
  digests: ReadonlyMap<string, Digest>,
  maxChars: number,
  maxNotes = MAX_NOTES,
): { notes: ContextNote[]; chars: number; dropped: number } {
  const ranked = candidates
    .filter((c) => digests.has(c.path))
    .map((c) => {
      const d = digests.get(c.path)!;
      return { c, d, score: c.score + (d.isDecision ? DECISION_BONUS : 0) };
    })
    .sort((a, b) => b.score - a.score || a.d.title.localeCompare(b.d.title));

  const notes: ContextNote[] = [];
  let chars = 0;
  for (const { c, d, score } of ranked) {
    if (notes.length === maxNotes) break;
    const room = maxChars - chars;
    if (room < MIN_EXCERPT_CHARS) break;
    const wanted = c.via.kind === 'linked' ? LINKED_EXCERPT_CHARS : SEED_EXCERPT_CHARS;
    const { text, truncated } = excerpt(d.body, Math.min(wanted, room));
    notes.push({
      path: c.path,
      title: d.title,
      reason: describeVia(c.via),
      via: c.via,
      isDecision: d.isDecision,
      score: Math.round(score * 1000) / 1000,
      excerpt: text,
      truncated,
    });
    chars += text.length;
  }
  return { notes, chars, dropped: ranked.length - notes.length };
}
