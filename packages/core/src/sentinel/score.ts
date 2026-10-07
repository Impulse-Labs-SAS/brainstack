// Sentinel's scoring — pure and DB-free. crawl.ts does the reading, through a
// ContextSource, and hands the rows here.
//
// A crawl starts from seeds — notes the text names, and the best search hits
// for the phrases the caller found vague — and follows wikilinks out from
// them, both ways, a hop or two. Three decisions carry it:
//
//  - Naming beats searching, and both beat being linked. A note the text names
//    by its title is what the author meant; a search hit is a good guess; a
//    neighbour is context around either, and each hop costs score.
//  - What a note links to says what it is about; what links to it only
//    mentions it. So a hop out keeps more of the score than a hop in, and the
//    first links a note writes — a MOC's "start here" — keep a little more.
//    Without that, every decision that merely mentions a product outranked the
//    overview its own index puts first.
//  - Evidence adds up. A note three of the caller's terms find is likelier to
//    be the answer than one a single term finds first — taking the best reason
//    alone would tie them, and the budget would settle the tie by title.
//  - A decision weighs extra when the text or a search reached it. "What did
//    we already decide" is the question a prompt most often leaves implicit,
//    and the one a guess gets most wrong. Reached along a link, it only breaks
//    ties: the link order the author chose decides what to read first.
//  - The budget is in characters, not notes. The caller is an assistant with a
//    context window; ten long notes and forty short ones are not the same cost.

/** Why a note is in the result. Exactly one per note: the strongest. */
export type ContextVia =
  | { kind: 'named'; text: string; count: number }
  | { kind: 'search'; term: string; rank: number }
  | { kind: 'prompt'; rank: number }
  | { kind: 'linked'; from: string; fromTitle: string; direction: 'out' | 'in'; hop: number };

export interface Candidate {
  path: string;
  score: number;
  via: ContextVia;
  /** Other terms that found the note, besides the one `via` names. */
  also?: string[];
}

/** Score of a note the text names by title or alias. */
export const NAMED_SCORE = 1;
/** Score of the best search hit for a term; later hits step down from it. */
export const SEARCH_SCORE = 0.7;
export const SEARCH_RANK_STEP = 0.1;
/** Search hits kept per term. */
export const SEARCH_HITS_PER_TERM = 3;
/** Search hits kept for the question as a whole. */
export const PROMPT_HITS = 5;
/** A hop along a link the note itself wrote multiplies the score by this. */
export const OUT_DECAY = 0.6;
/**
 * A hop back along a link another note wrote to this one. Low enough that a
 * decision reached this way (IN_DECAY + DECISION_BONUS) stays under any note
 * the named one links to.
 */
export const IN_DECAY = 0.3;
/** Extra decay kept by a note's first outgoing link; it fades to nothing by the LEAD_LINKS-th. */
export const LEAD_LINK_BONUS = 0.1;
export const LEAD_LINKS = 5;
/** Added to a decision the text names or a search finds. */
export const DECISION_BONUS = 0.25;
/**
 * Added to a decision reached along a link: only enough to break a tie. An
 * index lists what to read first, and its decisions — which in a product's
 * index is most of them — must not jump over the overview it puts first.
 * Smaller than one step of the lead-link bonus, so link order still decides.
 */
export const LINKED_DECISION_BONUS = 0.01;
/** Notes that did not fit, listed by title so the caller knows they exist. */
export const LEFT_OUT_LISTED = 20;

/** The decay of the `rank`-th outgoing link of a note (0 = first written), or of an incoming one. */
export function hopDecay(direction: 'out' | 'in', rank?: number): number {
  if (direction === 'in') return IN_DECAY;
  if (rank === undefined || rank >= LEAD_LINKS) return OUT_DECAY;
  return OUT_DECAY + LEAD_LINK_BONUS * (1 - rank / LEAD_LINKS);
}
/**
 * Notes carried from one hop to the next. A hub — a MOC links to everything in
 * its folder — would otherwise turn the second hop into the whole vault.
 */
export const FRONTIER_LIMIT = 20;

export const DEFAULT_MAX_CHARS = 16_000;
export const MAX_MAX_CHARS = 50_000;
export const MAX_NOTES = 40;
/** A seed gets a longer excerpt than a note reached by a link. */
// Generous on purpose: the point is that the assistant answers from this one
// call, without opening each note. `truncated` says when a note was cut.
export const SEED_EXCERPT_CHARS = 6_000;
export const LINKED_EXCERPT_CHARS = 1_500;
/**
 * Characters of each body read from the store: more than any excerpt uses, so
 * `truncated` stays true for a body longer than its excerpt, and no more, so a
 * vault with a few huge imported notes does not ship them whole on every call.
 */
export const DIGEST_BODY_CHARS = SEED_EXCERPT_CHARS + 500;
/** Below this, a truncated excerpt says too little to be worth its place. */
export const MIN_EXCERPT_CHARS = 120;

/**
 * The candidates found so far. Each note keeps every search that found it and
 * the strongest other reason — named, or linked — and scores them together as
 * independent evidence: 1 − ∏(1 − sᵢ). One reason alone scores what it always
 * did; a named note stays at NAMED_SCORE, and searches only approach it.
 * The reason shown is the strongest single one.
 */
export class CandidateSet {
  private readonly byPath = new Map<string, Candidate>();
  /** Per note, the best a named or linked reason gave it. */
  private readonly reached = new Map<string, Candidate>();
  /** Per note, the best each search gave it, by search: a term, or the question. */
  private readonly matched = new Map<string, Map<string, Candidate>>();

  offer(candidate: Candidate): void {
    const { path, via } = candidate;
    if (via.kind === 'search' || via.kind === 'prompt') {
      const byQuery = this.matched.get(path) ?? new Map<string, Candidate>();
      const key = via.kind === 'search' ? `term:${via.term}` : 'prompt';
      const current = byQuery.get(key);
      if (current && candidate.score <= current.score) return;
      byQuery.set(key, candidate);
      this.matched.set(path, byQuery);
    } else {
      const current = this.reached.get(path);
      if (current && candidate.score <= current.score) return;
      this.reached.set(path, candidate);
    }
    this.byPath.set(path, this.combine(path));
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

  private combine(path: string): Candidate {
    const reached = this.reached.get(path);
    const matches = [...(this.matched.get(path)?.values() ?? [])];
    const reasons = reached ? [reached, ...matches] : matches;
    const strongest = reasons.reduce((best, r) => (r.score > best.score ? r : best));
    const score = 1 - reasons.reduce((miss, r) => miss * (1 - r.score), 1);
    const also = matches.flatMap((m) =>
      m !== strongest && m.via.kind === 'search' ? [m.via.term] : [],
    );
    return {
      path,
      score,
      via: strongest.via,
      ...(also.length > 0 ? { also } : {}),
    };
  }
}

/**
 * A hit for the question as a whole ranks under a note linked from a named one
 * (NAMED_SCORE × OUT_DECAY): a link someone wrote says more than a shared word.
 */
export function promptScore(rank: number): number {
  return Math.max(0.15, 0.45 - rank * 0.05);
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
  edges: ReadonlyArray<{ source: string; target: string; position?: number }>,
  hop: number,
  titleOf: (path: string) => string,
): string[] {
  const inFrontier = new Set(frontier);
  const reached = new Set<string>();
  const leadRank = outgoingRanks(edges);
  for (const edge of edges) {
    const { source, target } = edge;
    for (const [from, to, direction] of [
      [source, target, 'out'],
      [target, source, 'in'],
    ] as const) {
      // A note already in the frontier can still be reached more strongly —
      // a link from a named note outranks a word the question shares with it —
      // so only the source has to be in the frontier; `offer` keeps the best.
      if (!inFrontier.has(from) || from === to) continue;
      const parent = set.get(from);
      if (!parent) continue;
      const score = parent.score * hopDecay(direction, leadRank.get(edge));
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

/**
 * For each edge that says where in its source it is written, its order among
 * that source's outgoing links: 0 for the first. An edge without a position
 * gets no rank, and so no lead bonus.
 */
function outgoingRanks<E extends { source: string; position?: number }>(
  edges: readonly E[],
): Map<E, number> {
  const bySource = new Map<string, E[]>();
  for (const e of edges) {
    if (e.position === undefined) continue;
    const list = bySource.get(e.source) ?? [];
    list.push(e);
    bySource.set(e.source, list);
  }
  const ranks = new Map<E, number>();
  for (const list of bySource.values()) {
    list.sort((a, b) => a.position! - b.position!).forEach((e, i) => ranks.set(e, i));
  }
  return ranks;
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

/** `describeVia`, plus the other terms that found the note. */
export function describeCandidate(via: ContextVia, also: readonly string[] = []): string {
  if (also.length === 0) return describeVia(via);
  if (via.kind === 'search') return `matches ${listTerms([via.term, ...also])}`;
  return `${describeVia(via)}; also matches ${listTerms(also)}`;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function listTerms(terms: readonly string[]): string {
  const quoted = terms.map((t) => `"${t}"`);
  return quoted.length === 1
    ? quoted[0]!
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

export function describeVia(via: ContextVia): string {
  switch (via.kind) {
    case 'named':
      return via.count > 1
        ? `the text says "${via.text}" (${via.count}×)`
        : `the text says "${via.text}"`;
    case 'search':
      return `matches "${via.term}"`;
    case 'prompt':
      return 'matches the question';
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
): { notes: ContextNote[]; chars: number; dropped: number; leftOut: LeftOutNote[] } {
  const ranked = candidates
    .filter((c) => digests.has(c.path))
    .map((c) => {
      const d = digests.get(c.path)!;
      const bonus = !d.isDecision
        ? 0
        : c.via.kind === 'linked'
          ? LINKED_DECISION_BONUS
          : DECISION_BONUS;
      return { c, d, score: c.score + bonus };
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
      reason: describeCandidate(c.via, c.also),
      via: c.via,
      isDecision: d.isDecision,
      score: Math.round(score * 1000) / 1000,
      excerpt: text,
      truncated,
    });
    chars += text.length;
  }
  const leftOut = ranked.slice(notes.length, notes.length + LEFT_OUT_LISTED).map(({ c, d }) => ({
    path: c.path,
    title: d.title,
    reason: describeCandidate(c.via, c.also),
  }));
  return { notes, chars, dropped: ranked.length - notes.length, leftOut };
}

/** A note that ranked but did not fit: enough to know it exists and open it. */
export interface LeftOutNote {
  path: string;
  title: string;
  reason: string;
}
