// gather_context: resolve a piece of free text — a prompt, a brief, a spec —
// against the caller's vault, in one call.
//
// The text is not a note and is never stored. What comes back is the context
// it refers to (the notes it names, the best hits for the phrases the caller
// found vague, and what those link to), cut to a character budget, plus the
// references the vault could not settle. Those are reported, never guessed:
// a title two notes share comes back with both candidates, and a phrase that
// matched nothing comes back as a question for the person.
//
// Own vault only, like `unlinkedMentions` and `listRelated`. Scoring lives in
// contextCrawl.ts; this file only reads.

import {
  buildCodeMask,
  extractLinks,
  findMentions,
  foldForMatch,
  indexMentionTerms,
  resolveLink,
  type MentionTerm,
} from '@brainstack/core';

import type { NoteService } from './NoteService.js';
import type { SearchService } from './SearchService.js';
import {
  CandidateSet,
  DEFAULT_MAX_CHARS,
  MAX_MAX_CHARS,
  DIGEST_BODY_CHARS,
  MAX_NOTES,
  NAMED_SCORE,
  SEARCH_HITS_PER_TERM,
  expandHop,
  packContext,
  searchScore,
  topFrontier,
  type ContextNote,
  type Digest,
} from './contextCrawl.js';

export const MAX_TEXT_CHARS = 50_000;
export const MAX_TERMS = 30;
export const MAX_DEPTH = 2;
/** Bodies read before packing: enough for the budget, with room for decisions to move up. */
const DIGEST_LIMIT = MAX_NOTES * 2;
/** Hits asked of search per term before keeping the caller's own. */
const SEARCH_CANDIDATES = 25;
/** Terms searched at the same time. */
const SEARCH_BATCH = 4;

export interface GatherContextInput {
  text: string;
  /** Phrases the caller found vague; each is searched for in full text. */
  terms?: readonly string[];
  /** Hops of wikilinks followed out from the seeds. Default 1. */
  depth?: number;
  /** Characters of excerpt returned, all notes together. */
  maxChars?: number;
}

export interface UnresolvedReference {
  term: string;
  reason: 'no-match' | 'ambiguous';
  /** For `ambiguous`: every note the term could mean. */
  candidates?: Array<{ path: string; title: string }>;
}

export interface GatherContextResult {
  notes: ContextNote[];
  unresolved: UnresolvedReference[];
  /** References found in the text or passed as terms, and how many were settled. */
  coverage: { resolved: number; total: number };
  budget: { maxChars: number; usedChars: number; notesLeftOut: number };
}

export interface GatherContextDeps {
  notes: NoteService;
  search: SearchService;
}

const AMBIGUOUS = '\u0000ambiguous:';

export async function gatherContext(
  deps: GatherContextDeps,
  ownerId: string,
  input: GatherContextInput,
): Promise<GatherContextResult> {
  const text = input.text.slice(0, MAX_TEXT_CHARS);
  const depth = Math.max(0, Math.min(MAX_DEPTH, Math.trunc(input.depth ?? 1)));
  const maxChars = Math.max(
    0,
    Math.min(MAX_MAX_CHARS, Math.trunc(input.maxChars ?? DEFAULT_MAX_CHARS)),
  );
  const terms = uniqueTerms(input.terms ?? []);

  const index = await deps.notes.mentionIndex(ownerId);
  const titleOf = new Map(index.map((n) => [n.path, n.title]));
  const title = (path: string) => titleOf.get(path) ?? path;

  // -- Seeds: what the text links to ----------------------------------------
  // `[[Note]]` is the plainest way a prompt can point at a note, and the one
  // mention matching skips on purpose (it never looks inside a link). So links
  // are resolved the way the vault resolves them, from the root.
  const set = new CandidateSet();
  const named = new Map<string, { text: string; count: number }>();
  const unresolved: UnresolvedReference[] = [];
  const settledTerms = new Set<string>();
  const nameSeed = (path: string, said: string) => {
    const entry = named.get(path) ?? { text: said, count: 0 };
    entry.count += 1;
    named.set(path, entry);
    settledTerms.add(foldForMatch(said));
  };

  const noteIndex = new Set(index.map((n) => n.path));
  const linkCtx = { sourcePath: 'prompt.md', noteIndex, attachmentIndex: new Set<string>() };
  const linkSeen = new Set<string>();
  for (const link of extractLinks(text, buildCodeMask(text))) {
    const said = link.alias ?? link.rawTarget;
    const resolved = resolveLink(link, linkCtx);
    if (resolved.targetType === 'note' && !resolved.ambiguous) {
      nameSeed(resolved.targetPath, said);
      continue;
    }
    if (resolved.targetType === 'attachment') continue;
    const key = foldForMatch(link.rawTarget);
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    settledTerms.add(foldForMatch(said));
    unresolved.push(
      resolved.ambiguous
        ? {
            term: said,
            reason: 'ambiguous',
            candidates: resolved.candidates
              .filter((p) => noteIndex.has(p))
              .map((path) => ({ path, title: title(path) })),
          }
        : { term: said, reason: 'no-match' },
    );
  }

  // -- Seeds: what the text names --------------------------------------------
  const { terms: mentionTerms, ambiguous } = indexMentionTerms(
    index.map((n) => ({ target: n.path, title: n.title, aliases: n.aliases })),
  );
  // Ambiguous terms are matched alongside the others, not after them, so that
  // the longer of two overlapping titles still wins whichever kind it is.
  const searchable: MentionTerm[] = [
    ...mentionTerms,
    ...ambiguous.map((a, i) => ({ target: `${AMBIGUOUS}${i}`, term: a.term })),
  ];
  const ambiguousSeen = new Set<number>();
  for (const m of findMentions(withoutCodeMarkers(text), searchable)) {
    if (!m.target.startsWith(AMBIGUOUS)) {
      nameSeed(m.target, m.text);
      continue;
    }
    const i = Number(m.target.slice(AMBIGUOUS.length));
    if (ambiguousSeen.has(i)) continue;
    ambiguousSeen.add(i);
    settledTerms.add(foldForMatch(m.text));
    unresolved.push({
      term: m.text,
      reason: 'ambiguous',
      candidates: ambiguous[i]!.targets.map((path) => ({ path, title: title(path) })),
    });
  }
  for (const [path, { text: said, count }] of named) {
    set.offer({ path, score: NAMED_SCORE, via: { kind: 'named', text: said, count } });
  }

  // -- Seeds: what the vague phrases find ------------------------------------
  // A term the text already named or linked is not a second reference.
  const vague = terms.filter((t) => !settledTerms.has(foldForMatch(t)));
  let termsResolved = 0;
  for (const { term, hits } of await searchTerms(deps.search, ownerId, vague)) {
    if (hits.length === 0) {
      unresolved.push({ term, reason: 'no-match' });
      continue;
    }
    termsResolved += 1;
    hits.forEach((hit, rank) => {
      set.offer({ path: hit.path, score: searchScore(rank), via: { kind: 'search', term, rank } });
    });
  }

  // -- Expand along wikilinks ------------------------------------------------
  let frontier = topFrontier(
    set,
    set.all().map((c) => c.path),
  );
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const edges = await deps.notes.linksTouching(ownerId, frontier);
    frontier = topFrontier(set, expandHop(set, frontier, edges, hop, title));
  }

  // -- Read the strongest, then pack ----------------------------------------
  const strongest = set
    .all()
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, DIGEST_LIMIT);
  const digests = new Map<string, Digest>(
    (
      await deps.notes.contextDigests(
        ownerId,
        strongest.map((c) => c.path),
        DIGEST_BODY_CHARS,
      )
    ).map((d) => [d.path, d]),
  );
  const packed = packContext(strongest, digests, maxChars);

  return {
    notes: packed.notes,
    unresolved,
    coverage: {
      resolved: named.size + termsResolved,
      total: named.size + unresolved.length + termsResolved,
    },
    budget: {
      maxChars,
      usedChars: packed.chars,
      notesLeftOut: packed.dropped + Math.max(0, set.all().length - strongest.length),
    },
  };
}

/**
 * Full-text hits for each term, own notes only, a few terms at a time.
 *
 * Search ranks across every vault and filters by owner afterwards, so a term
 * asked for three hits can come back empty on a busy instance while the
 * caller's notes do match. Asking for more and trimming here is what keeps
 * "no-match" honest. Batched, not all at once: each query highlights every row
 * it matches, and thirty of those together would hold the pool for everyone.
 */
async function searchTerms(
  search: SearchService,
  ownerId: string,
  terms: readonly string[],
): Promise<Array<{ term: string; hits: Array<{ path: string }> }>> {
  const out: Array<{ term: string; hits: Array<{ path: string }> }> = [];
  for (let i = 0; i < terms.length; i += SEARCH_BATCH) {
    const batch = terms.slice(i, i + SEARCH_BATCH);
    out.push(
      ...(await Promise.all(
        batch.map(async (term) => {
          const hits = await search.search(ownerId, term, {
            limit: SEARCH_CANDIDATES,
            includeMine: true,
            sharedScopes: [],
          });
          return {
            term,
            hits: hits.filter((h) => h.ownerId === ownerId).slice(0, SEARCH_HITS_PER_TERM),
          };
        }),
      )),
    );
  }
  return out;
}

/**
 * The text with backticks and fence lines removed. A prompt that writes
 * `Billing service` in code is still naming the note; mention matching would
 * skip it, because in a note body code is where a name must never be linked.
 */
function withoutCodeMarkers(text: string): string {
  return text.replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, '').replace(/`/g, ' ');
}

/** Trimmed, non-empty, and each phrase once however it was cased or accented. */
function uniqueTerms(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of raw) {
    const t = term.trim();
    const key = foldForMatch(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}
