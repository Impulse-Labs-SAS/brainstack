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
//    alone would tie them, and the budget would settle the tie by title. So
//    does a note several results link to: in a question that spans two
//    subjects, it is the hinge between them. Links *back* do not add up — a
//    note that links to many results is their index — and an index adds up
//    nothing at all: every note links up to its own.
//  - An index is read for its links. A note that is mostly a list of them
//    gets a linked note's excerpt even when the text names it, so two named
//    indexes cannot fill the budget with the lists the crawl already followed.
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
  /** Titles of other notes that link to it, besides the one `via` names. */
  alsoFrom?: string[];
  /** The strongest single reason's score, before the others add to it. Absent: `score`. */
  best?: number;
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
/**
 * Kept by a hit for the question that never says what the text named. "A
 * general overview of Orbit" also finds every other project's "general
 * overview"; it is still the question's word, so it stays, under the notes
 * the named one links to.
 */
export const OFF_TOPIC_FACTOR = 0.5;
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
/** Lines with a wikilink a note needs, at least, to read as an index. */
export const INDEX_MIN_LINK_LINES = 5;

/**
 * A note that is mostly a list of links: a MOC, a project's index. What it
 * says is where to go, and the crawl has already gone there, so its excerpt is
 * the size of a linked note's — named or not. Otherwise two indexes a question
 * names fill the budget with their lists, and push out the notes they list.
 * Mostly means at least half of its lines of text, headings aside.
 */
export function isIndex(body: string): boolean {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const linking = lines.filter((l) => l.includes('[[')).length;
  return linking >= INDEX_MIN_LINK_LINES && linking * 2 >= lines.length;
}

/**
 * The candidates found so far. Each note keeps every independent reason it
 * was reached by, and scores them together: 1 − ∏(1 − sᵢ). Independent means
 * each search that found it, and each note that links to it — a note three
 * results link to is likelier the hinge between them than one a single result
 * does. A note counts once whichever way it links. Being named, and being
 * linked *back* from notes (a note that links to many results is an index of
 * them, not a hinge), count once: the strongest. One reason alone scores what
 * it always did; a named note stays at NAMED_SCORE, and the rest only approach
 * it. The reason shown is the strongest single one, the others listed after.
 */
export class CandidateSet {
  private readonly byPath = new Map<string, Candidate>();
  /** Per note, the best each reason gave it, by `reasonKey`. */
  private readonly reasons = new Map<string, Map<string, Candidate>>();

  offer(candidate: Candidate): void {
    const { path } = candidate;
    const byKey = this.reasons.get(path) ?? new Map<string, Candidate>();
    const key = reasonKey(candidate.via);
    const current = byKey.get(key);
    if (current && candidate.score <= current.score) return;
    byKey.set(key, candidate);
    this.reasons.set(path, byKey);
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
    const all = [...this.reasons.get(path)!.values()];
    const linksBack = all.filter((r) => r.via.kind === 'linked' && r.via.direction === 'in');
    const reasons = [
      ...all.filter((r) => !linksBack.includes(r)),
      ...(linksBack.length > 0 ? [strongestOf(linksBack)] : []),
    ];
    const strongest = strongestOf(reasons);
    const score = 1 - reasons.reduce((miss, r) => miss * (1 - r.score), 1);
    const others = reasons.filter((r) => r !== strongest);
    const also = others.flatMap((r) => (r.via.kind === 'search' ? [r.via.term] : []));
    const alsoFrom = others.flatMap((r) =>
      r.via.kind === 'linked' && r.via.direction === 'out' ? [r.via.fromTitle] : [],
    );
    return {
      path,
      score,
      best: strongest.score,
      via: strongest.via,
      ...(also.length > 0 ? { also } : {}),
      ...(alsoFrom.length > 0 ? { alsoFrom } : {}),
    };
  }
}

function strongestOf(reasons: readonly Candidate[]): Candidate {
  return reasons.reduce((best, r) => (r.score > best.score ? r : best));
}

/** One slot per search, one per linking note — whichever way it links — and one for being named. */
function reasonKey(via: ContextVia): string {
  switch (via.kind) {
    case 'search':
      return `term:${via.term}`;
    case 'prompt':
      return 'prompt';
    case 'linked':
      return `link:${via.from}`;
    case 'named':
      return 'named';
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
      // Reasons add up, so a note must not get its own back: the link from
      // the note `from` was reached through is that note's evidence, echoed.
      if (parent.via.kind === 'linked' && parent.via.from === to) continue;
      const score = parent.score * hopDecay(direction, leadRank.get(edge));
      const before = set.get(to)?.score;
      set.offer({
        path: to,
        score,
        via: { kind: 'linked', from, fromTitle: titleOf(from), direction, hop },
      });
      if (before === undefined || set.get(to)!.score > before) reached.add(to);
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

/**
 * When the text named notes, a candidate the question's search brought in
 * that never mentions anything the text named is about something else: its
 * score is cut by OFF_TOPIC_FACTOR. So is a note reached only from one of
 * those, unless it mentions a named term itself. Notes the text names, a
 * term's search hits and anything linked from a named note are left alone.
 * `fold` folds text for matching, as mentions are matched.
 */
export function demoteOffTopic(
  candidates: readonly Candidate[],
  digests: ReadonlyMap<string, Digest>,
  namedTexts: readonly string[],
  fold: (text: string) => string,
): Candidate[] {
  const needles = namedTexts.map(fold).filter(Boolean);
  if (needles.length === 0) return [...candidates];
  const mentions = (path: string) => {
    const d = digests.get(path);
    if (!d) return true; // unread: nothing to judge it by
    const hay = fold(`${d.title}\n${d.body}`);
    return needles.some((n) => hay.includes(n));
  };
  const offTopic = new Set<string>();
  for (const c of candidates) {
    if (c.via.kind === 'prompt' && !mentions(c.path)) offTopic.add(c.path);
  }
  for (const c of candidates) {
    if (c.via.kind === 'linked' && offTopic.has(c.via.from) && !mentions(c.path)) {
      offTopic.add(c.path);
    }
  }
  return candidates.map((c) =>
    offTopic.has(c.path)
      ? { ...c, score: c.score * OFF_TOPIC_FACTOR, best: (c.best ?? c.score) * OFF_TOPIC_FACTOR }
      : c,
  );
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

/** `describeVia`, plus the other terms that found the note and the other notes that link to it. */
export function describeCandidate(c: Pick<Candidate, 'via' | 'also' | 'alsoFrom'>): string {
  const { via, also = [], alsoFrom = [] } = c;
  const linkedFrom = via.kind === 'linked' && via.direction === 'out';
  const head =
    via.kind === 'search'
      ? `matches ${listWords([via.term, ...also].map(quote))}`
      : linkedFrom
        ? `linked from ${listWords([via.fromTitle, ...alsoFrom])}`
        : describeVia(via);
  const more = [
    ...(via.kind !== 'search' && also.length > 0 ? [`matches ${listWords(also.map(quote))}`] : []),
    ...(!linkedFrom && alsoFrom.length > 0 ? [`linked from ${listWords(alsoFrom)}`] : []),
  ];
  return more.length > 0 ? `${head}; also ${more.join(' and ')}` : head;
}

const quote = (term: string) => `"${term}"`;

/** `a`, `a and b`, `a, b and c`. */
function listWords(words: readonly string[]): string {
  return words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
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
      // Notes link up to their index by convention, so many results linking
      // to one says nothing about it: an index scores its best reason alone.
      const index = isIndex(d.body);
      const base = index ? (c.best ?? c.score) : c.score;
      const bonus = !d.isDecision
        ? 0
        : c.via.kind === 'linked'
          ? LINKED_DECISION_BONUS
          : DECISION_BONUS;
      return { c, d, index, score: base + bonus };
    })
    .sort((a, b) => b.score - a.score || a.d.title.localeCompare(b.d.title));

  const notes: ContextNote[] = [];
  let chars = 0;
  for (const { c, d, index, score } of ranked) {
    if (notes.length === maxNotes) break;
    const room = maxChars - chars;
    if (room < MIN_EXCERPT_CHARS) break;
    const wanted = c.via.kind === 'linked' || index ? LINKED_EXCERPT_CHARS : SEED_EXCERPT_CHARS;
    const { text, truncated } = excerpt(d.body, Math.min(wanted, room));
    notes.push({
      path: c.path,
      title: d.title,
      reason: describeCandidate(c),
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
    reason: describeCandidate(c),
  }));
  return { notes, chars, dropped: ranked.length - notes.length, leftOut };
}

/** A note that ranked but did not fit: enough to know it exists and open it. */
export interface LeftOutNote {
  path: string;
  title: string;
  reason: string;
}
