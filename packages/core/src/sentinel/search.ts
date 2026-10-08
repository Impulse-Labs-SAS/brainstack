// Sentinel's search: a query in, the notes that match it out, ranked the way
// the crawl ranks them (crawl.ts) — one engine, so `search_brain` and
// `gather_context` never disagree about which note comes first.
//
// The same reading of the text: a note the query names comes first, and a
// word that named it is not searched for again unless nothing else is left —
// "pricing Orbit" searches "pricing", "Orbit" searches "Orbit". The same
// scoring: hits rank by coverage, and a hit outside the folders of the notes
// the query named counts half. What a search leaves out is what makes the
// crawl a crawl: no links followed, no bodies read, and so no decision or
// index weighing, which need a body. It lists more, too: up to fifty.

import {
  CandidateSet,
  NAMED_SCORE,
  describeCandidate,
  folderOf,
  type ContextVia,
} from './score.js';
import { MAX_TEXT_CHARS, type ContextSource } from './crawl.js';
import { resolveNames, withoutNamed } from './names.js';

export const MAX_SEARCH_HITS = 50;
export const DEFAULT_SEARCH_HITS = 10;

export interface SearchInput {
  query: string;
  /** Hits returned, at most MAX_SEARCH_HITS. */
  limit?: number;
}

export interface SearchHit {
  path: string;
  title: string;
  /** The matching passage, when full-text search found the note. */
  snippet: string;
  score: number;
  /** One line for a person: why this note is here. */
  reason: string;
  via: ContextVia;
}

export async function searchNotes(source: ContextSource, input: SearchInput): Promise<SearchHit[]> {
  const query = input.query.trim().slice(0, MAX_TEXT_CHARS);
  const limit = Math.max(
    1,
    Math.min(MAX_SEARCH_HITS, Math.trunc(input.limit ?? DEFAULT_SEARCH_HITS)),
  );
  if (!query) return [];

  const index = await source.titles();
  const titleOf = new Map(index.map((n) => [n.path, n.title]));
  const { named, namedWords } = resolveNames(query, index);

  // What was named is listed by name; the rest of the query is what is
  // searched. A query that is only a name searches for that name.
  const searched = withoutNamed(query, namedWords) || query;
  const hits = await source.search(searched, limit);
  const snippetOf = new Map(hits.map((h) => [h.path, h.snippet ?? '']));

  const set = new CandidateSet();
  set.setContext({
    weights: new Map([[query, 1]]),
    namedFolders: [...new Set([...named.keys()].map(folderOf))],
  });
  for (const [path, { text, count }] of named) {
    set.offer({ path, score: NAMED_SCORE, via: { kind: 'named', text, count } });
  }
  hits.forEach((hit, rank) => {
    set.offer({ path: hit.path, score: 0, via: { kind: 'search', term: query, rank } });
  });

  return set
    .all()
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((c) => ({
      path: c.path,
      title: titleOf.get(c.path) ?? c.path,
      snippet: snippetOf.get(c.path) ?? '',
      score: Math.round(c.score * 1000) / 1000,
      reason: describeCandidate(c),
      via: c.via,
    }));
}
