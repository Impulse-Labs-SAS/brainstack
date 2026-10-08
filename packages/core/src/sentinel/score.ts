// Sentinel's scoring — pure and DB-free. crawl.ts does the reading, through a
// ContextSource, and hands the rows here.
//
// A crawl starts from seeds — notes the text names, and the best search hits
// for the question and for the phrases the caller found vague — and follows
// wikilinks out from them, both ways, a hop or two. A note's score has two
// parts, added, never multiplied into a probability that saturates:
//
//  - Coverage, the base. Which of the searched terms found the note, each
//    weighed by how rare it is in the vault (an IDF), so a note that covers
//    four of four terms outranks one that covers two, and a word half the
//    vault says counts for little. The question's own search counts as one
//    more, weaker term. A term's hit outside the folder of a note the text
//    named counts half, and the question's own hit there only as a link:
//    once the text says what it is about, the same word in another project
//    is most likely about something else.
//  - Links, the tie-breaker. The notes that link to it, added up but capped
//    below what one covered term is worth: ten notes linking to one cannot
//    beat covering one more term. What a note links to says what it is about;
//    what links to it only mentions it, so a hop out keeps more than a hop in,
//    the first links a note writes keep a little more, and links *back* do not
//    add up — a note that links to many results is their index.
//
// Then, once the bodies are read:
//
//  - A note the text names scores NAMED_SCORE, above everything.
//  - The first link of a named index — its "start here" — comes right after
//    it, unless a note in the named folders covers more of what was searched:
//    "what is X" lands on the overview, "how does X charge" on the pricing.
//  - An index adds no links up: every note links up to its own. It also gets
//    a linked note's excerpt, so named indexes cannot fill the budget.
//  - A decision is worth a little more, but only when the note is relevant on
//    its own: it covers a term, or it is one hop from a named note. A decision
//    that merely shares a generic word is not promoted for being a decision.
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
  /** The score with only the strongest link, not their sum: what an index is worth. Absent: `score`. */
  best?: number;
  /** It covers a term or the question, or is one hop from a named note: a decision here weighs more. */
  relevant?: boolean;
  /** The named note whose first written link this is: its entry point, if that note is an index. */
  entryOf?: string;
  /** How many distinct searches — terms, and the question — found it. */
  covered?: number;
  /** In a folder of a note the text named, or nothing was named. */
  inside?: boolean;
}

/** Score of a note the text names by title or alias. */
export const NAMED_SCORE = 1;
/**
 * Score of the first link a named index writes. Above anything coverage and
 * links can reach, even as a decision, and under the index itself.
 */
export const ENTRY_SCORE = 0.95;
/** What full coverage — every searched term, each at its best hit — is worth. */
export const SEARCH_SPAN = 0.7;
/** The most links can add, all together. Further capped below one covered term. */
export const MAX_LINK = 0.15;
/** Each place a hit ranks below the first costs this share of its term. */
export const RANK_STEP = 0.1;
/** A search hit outside the folders of the notes the text named counts this much. */
export const OUT_OF_FOLDER_FACTOR = 0.5;
/** The question's own search weighs this share of the least weighty term. */
export const QUESTION_WEIGHT = 0.5;
/** A relevant decision's score is multiplied by this. */
export const DECISION_FACTOR = 1.1;
/** The weights map's key for the question's own search. */
export const QUESTION = '\u0000question';
/** Search hits kept per term. */
export const SEARCH_HITS_PER_TERM = 3;
/** Search hits kept for the question as a whole. */
export const PROMPT_HITS = 5;
/** A hop along a link the note itself wrote multiplies the score by this. */
export const OUT_DECAY = 0.6;
/** A hop back along a link another note wrote to this one. */
export const IN_DECAY = 0.3;
/** Extra decay kept by a note's first outgoing link; it fades to nothing by the LEAD_LINKS-th. */
export const LEAD_LINK_BONUS = 0.1;
export const LEAD_LINKS = 5;
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
 * How rare a term is in a vault of `notes` notes, `matching` of which it
 * matches: an inverse document frequency, always positive. A term every note
 * says weighs next to nothing; one in a handful of notes weighs several times
 * more.
 */
export function termWeight(matching: number, notes: number): number {
  const n = Math.max(notes, 1);
  const df = Math.min(Math.max(matching, 0), n);
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** What the scores are measured against: set once the searches have run. */
export interface ScoringContext {
  /** Weight of each searched term that found something, by term; the question's under QUESTION. */
  weights: ReadonlyMap<string, number>;
  /** Folders of the notes the text names. Empty: no folder is outside. */
  namedFolders: readonly string[];
}

const NO_CONTEXT: ScoringContext = { weights: new Map(), namedFolders: [] };

/** The folder a path is in; '' for the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * The candidates found so far. Each note keeps every reason it was reached by
 * — named, each search that found it, each note that links to it — and is
 * scored from them as the header says: coverage plus capped links. The
 * reason shown is the strongest, the others listed after it.
 */
export class CandidateSet {
  private readonly byPath = new Map<string, Candidate>();
  /** Per note, the best each reason gave it, by `reasonKey`. */
  private readonly reasons = new Map<string, Map<string, Candidate>>();
  private readonly named = new Set<string>();
  /** Notes that are the first link a named note writes, and which note that is. */
  private readonly entries = new Map<string, string>();
  private ctx: ScoringContext = NO_CONTEXT;
  private totalWeight = 0;
  private linkCap = MAX_LINK;

  /** Sets what coverage is measured against, and rescores every note. */
  setContext(ctx: ScoringContext): void {
    this.ctx = ctx;
    const all = [...ctx.weights.values()];
    this.totalWeight = all.reduce((a, b) => a + b, 0);
    const termWeights = [...ctx.weights].filter(([k]) => k !== QUESTION).map(([, w]) => w);
    const least = Math.min(...(termWeights.length > 0 ? termWeights : all));
    // One covered term, in the folder, at its worst kept rank: links never pass it.
    const oneTerm =
      this.totalWeight > 0
        ? (SEARCH_SPAN * least * rankFactor(SEARCH_HITS_PER_TERM - 1)) / this.totalWeight
        : MAX_LINK;
    this.linkCap = Math.min(MAX_LINK, oneTerm * 0.99);
    for (const path of this.reasons.keys()) this.byPath.set(path, this.combine(path));
  }

  offer(candidate: Candidate): void {
    const { path } = candidate;
    const byKey = this.reasons.get(path) ?? new Map<string, Candidate>();
    const key = reasonKey(candidate.via);
    const current = byKey.get(key);
    const isNewEntry = !!candidate.entryOf && !this.entries.has(path);
    if (current && strength(candidate) <= strength(current) && !isNewEntry) return;
    if (!current || strength(candidate) > strength(current)) byKey.set(key, candidate);
    if (candidate.entryOf) this.entries.set(path, candidate.entryOf);
    if (candidate.via.kind === 'named') this.named.add(path);
    this.reasons.set(path, byKey);
    this.byPath.set(path, this.combine(path));
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  get(path: string): Candidate | undefined {
    return this.byPath.get(path);
  }

  isNamed(path: string): boolean {
    return this.named.has(path);
  }

  all(): Candidate[] {
    return [...this.byPath.values()];
  }

  private combine(path: string): Candidate {
    const all = [...this.reasons.get(path)!.values()];
    const named = all.find((r) => r.via.kind === 'named');
    const inside =
      this.ctx.namedFolders.length === 0 ||
      this.ctx.namedFolders.some((f) => f === '' || path.startsWith(`${f}/`));
    // The question's own hit outside the named folders is not coverage: the
    // question is the weakest term, and there it most often found a word
    // another project happens to say. It weighs as a link back from a named
    // note — under anything the named note links to.
    const farQuestion = all.filter((r) => r.via.kind === 'prompt' && !inside);
    const hits = all.filter((r) => r.via.kind === 'search' || (r.via.kind === 'prompt' && inside));
    const links = all.filter((r) => r.via.kind === 'linked');

    // Coverage: each term's weight, at the rank it found the note, halved
    // outside the named folders; over the weight of every term searched.
    const contribution = (r: Candidate) =>
      this.weightOf(r) * rankFactor(rankOf(r)) * (inside ? 1 : OUT_OF_FOLDER_FACTOR);
    const coverage =
      this.totalWeight > 0
        ? hits.reduce((sum, r) => sum + contribution(r), 0) / this.totalWeight
        : 0;

    // Links: every note linking here adds up; links back, only the strongest.
    const back = links.filter((r) => r.via.kind === 'linked' && r.via.direction === 'in');
    const out = links.filter((r) => !back.includes(r));
    const asLink = farQuestion.map((r) => ({
      ...r,
      score: NAMED_SCORE * IN_DECAY * rankFactor(rankOf(r)),
    }));
    const summed =
      out.reduce((sum, r) => sum + r.score, 0) +
      Math.max(0, ...back.map((r) => r.score)) +
      asLink.reduce((sum, r) => sum + r.score, 0);
    const single = Math.max(0, ...[...links, ...asLink].map((r) => r.score));

    const base = SEARCH_SPAN * coverage;
    const score = named ? NAMED_SCORE : base + this.capLinks(summed);
    const best = named ? NAMED_SCORE : base + this.capLinks(single);

    const strongestHit = hits.reduce<Candidate | undefined>(
      (b, r) => (!b || contribution(r) > contribution(b) ? r : b),
      undefined,
    );
    const strongestLink = [...links, ...asLink].reduce<Candidate | undefined>(
      (b, r) => (!b || r.score > b.score ? r : b),
      undefined,
    );
    const strongest = named ?? strongestHit ?? strongestLink!;
    const others = all.filter((r) => r.via !== strongest.via);
    const also = others.flatMap((r) => (r.via.kind === 'search' ? [r.via.term] : []));
    const alsoFrom = others.flatMap((r) =>
      r.via.kind === 'linked' && r.via.direction === 'out' ? [r.via.fromTitle] : [],
    );
    const relevant =
      !!named ||
      coverage > 0 ||
      links.some((r) => r.via.kind === 'linked' && r.via.hop === 1 && this.named.has(r.via.from));
    const entryOf = this.entries.get(path);
    return {
      path,
      score,
      best,
      via: strongest.via,
      relevant,
      covered: hits.length,
      inside,
      ...(entryOf ? { entryOf } : {}),
      ...(also.length > 0 ? { also } : {}),
      ...(alsoFrom.length > 0 ? { alsoFrom } : {}),
    };
  }

  private weightOf(r: Candidate): number {
    return this.ctx.weights.get(r.via.kind === 'search' ? r.via.term : QUESTION) ?? 0;
  }

  /** Links in [0, linkCap): growing with every link, never reaching the cap. */
  private capLinks(sum: number): number {
    return (this.linkCap * sum) / (1 + sum);
  }
}

/** A search hit's share of its term, by the place it ranked (0 = first). */
function rankFactor(rank: number): number {
  return Math.max(0, 1 - rank * RANK_STEP);
}

function rankOf(r: Candidate): number {
  return r.via.kind === 'search' || r.via.kind === 'prompt' ? r.via.rank : 0;
}

/** How strong one reason is, to keep the best per slot: a better rank for a hit, a higher score for a link. */
function strength(r: Candidate): number {
  return r.via.kind === 'search' || r.via.kind === 'prompt' ? -r.via.rank : r.score;
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
      const rank = leadRank.get(edge);
      const score = parent.score * hopDecay(direction, rank);
      const before = set.get(to)?.score;
      set.offer({
        path: to,
        score,
        via: { kind: 'linked', from, fromTitle: titleOf(from), direction, hop },
        ...(direction === 'out' && rank === 0 && set.isNamed(from) ? { entryOf: from } : {}),
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
  // The entry point of a named index comes right after it — unless a note in
  // the named folders covers more of what was searched: then the question is
  // about something more specific than the index as a whole.
  const mostCovered = (c: Candidate) =>
    candidates.some(
      (o) =>
        o.path !== c.path &&
        o.via.kind !== 'named' &&
        o.inside !== false &&
        (o.covered ?? 0) > (c.covered ?? 0),
    );
  const ranked = candidates
    .filter((c) => digests.has(c.path))
    .map((c) => {
      const d = digests.get(c.path)!;
      // Notes link up to their index by convention, so many results linking
      // to one says nothing about it: an index scores its best link alone.
      const index = isIndex(d.body);
      const base = index ? (c.best ?? c.score) : c.score;
      const entryIndex = c.entryOf ? digests.get(c.entryOf) : undefined;
      if (entryIndex && isIndex(entryIndex.body) && base < ENTRY_SCORE && !mostCovered(c)) {
        return { c, d, index, score: ENTRY_SCORE };
      }
      const decision = d.isDecision && c.relevant !== false;
      return { c, d, index, score: decision ? base * DECISION_FACTOR : base };
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
