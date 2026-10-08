// gather_context: BrainStack's side of Sentinel (`@brainstack/core/sentinel`).
//
// Sentinel is the engine — it resolves a question or a prompt against a body
// of linked notes and knows nothing about vaults or owners. This file is the
// source it reads from: the caller's own vault, like `unlinkedMentions` and
// `listRelated`. A crawl that followed a link into a shared folder would hand
// over bodies the grant was never checked against.

import {
  crawlContext,
  type ContextSource,
  type GatherContextInput,
  type GatherContextResult,
} from '@brainstack/core/sentinel';

import type { NoteService } from './NoteService.js';
import type { SearchService } from './SearchService.js';

export {
  MAX_DEPTH,
  MAX_MAX_CHARS,
  MAX_TERMS,
  MAX_TEXT_CHARS,
  type GatherContextInput,
  type GatherContextResult,
} from '@brainstack/core/sentinel';

/** Hits asked of search per query before keeping the caller's own. */
const SEARCH_CANDIDATES = 25;

export interface GatherContextDeps {
  notes: NoteService;
  search: SearchService;
}

/** BrainStack's source: the caller's own vault. */
export function vaultSource(deps: GatherContextDeps, ownerId: string): ContextSource {
  return {
    titles: () => deps.notes.mentionIndex(ownerId),
    links: (paths) => deps.notes.linksTouching(ownerId, paths),
    digests: (paths, bodyChars) => deps.notes.contextDigests(ownerId, paths, bodyChars),
    // Search ranks across every vault and filters by owner afterwards, so a
    // query asked for three hits can come back empty on a busy instance while
    // the caller's notes do match. Asking for more and trimming here is what
    // keeps "no-match" honest.
    search: async (query, limit) => {
      const hits = await deps.search.search(ownerId, query, {
        limit: SEARCH_CANDIDATES,
        includeMine: true,
        sharedScopes: [],
      });
      return hits.filter((h) => h.ownerId === ownerId).slice(0, limit);
    },
    counts: (queries) => deps.search.counts(ownerId, queries),
  };
}

export function gatherContext(
  deps: GatherContextDeps,
  ownerId: string,
  input: GatherContextInput,
): Promise<GatherContextResult> {
  return crawlContext(vaultSource(deps, ownerId), input);
}
