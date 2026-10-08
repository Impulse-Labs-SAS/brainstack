// gather_context: BrainStack's side of Sentinel (`@brainstack/core/sentinel`).
//
// Sentinel is the engine — it resolves a question or a prompt against a body
// of linked notes and knows nothing about vaults or owners. This file is the
// source it reads from: the caller's own vault, plus the folders other people
// shared with them. Which folders those are is SharingService's answer; the
// MCP and tRPC layers ask it and pass the list in, as they do for search.
// Every read below re-checks its rows against that list in memory, so a crawl
// that follows a link out of a share stops at its edge.

import {
  crawlContext,
  searchNotes,
  type ContextNote,
  type ContextSource,
  type GatherContextInput,
  type GatherContextResult as EngineResult,
  type LeftOutNote,
  type UnresolvedReference,
} from '@brainstack/core/sentinel';

import type { NoteService, SharedScope } from './NoteService.js';
import type { SearchService } from './SearchService.js';

export {
  MAX_DEPTH,
  MAX_MAX_CHARS,
  MAX_TERMS,
  MAX_TEXT_CHARS,
  type GatherContextInput,
} from '@brainstack/core/sentinel';

/** Hits asked of search per query before keeping what the caller may read. */
const SEARCH_CANDIDATES = 25;

export interface GatherContextDeps {
  notes: NoteService;
  search: SearchService;
}

/**
 * Where a note lives: a path in the caller's own vault, or a path relative to
 * somebody else's root together with that owner — the pair get_note takes.
 */
export interface Placed {
  path: string;
  /** Set only for a note in a folder shared with the caller. */
  ownerId?: string;
}

type LinkedVia = Extract<ContextNote['via'], { kind: 'linked' }>;
export type PlacedVia =
  | Exclude<ContextNote['via'], LinkedVia>
  | (LinkedVia & { fromOwnerId?: string });

export type GatherContextNote = Omit<ContextNote, 'via'> & Placed & { via: PlacedVia };

export interface GatherContextResult extends Omit<
  EngineResult,
  'notes' | 'unresolved' | 'leftOut'
> {
  notes: GatherContextNote[];
  unresolved: Array<
    Omit<UnresolvedReference, 'candidates'> & {
      candidates?: Array<Placed & { title: string }>;
    }
  >;
  leftOut: Array<LeftOutNote & Placed>;
}

/**
 * How the engine names a note. The caller's own notes go by their path, as
 * they write it in a `[[link]]`; a shared note by its stored path behind a
 * mark no path can start with, so the two never collide — two vaults may
 * both hold `plan.md` — and a folder test never mistakes one for the other.
 */
const FOREIGN = '\u0000';

function keys(viewerId: string) {
  const own = `${viewerId}/`;
  return {
    fromStored: (stored: string) =>
      stored.startsWith(own) ? stored.slice(own.length) : `${FOREIGN}${stored}`,
    toStored: (key: string) => (key.startsWith(FOREIGN) ? key.slice(1) : `${own}${key}`),
    place: (key: string): Placed => {
      if (!key.startsWith(FOREIGN)) return { path: key };
      const stored = key.slice(1);
      const slash = stored.indexOf('/');
      return { ownerId: stored.slice(0, slash), path: stored.slice(slash + 1) };
    },
  };
}

/** BrainStack's source: the caller's own vault and the folders shared with them. */
export function vaultSource(
  deps: GatherContextDeps,
  viewerId: string,
  sharedScopes: readonly SharedScope[] = [],
): ContextSource {
  const scopes = [...sharedScopes];
  const { fromStored, toStored } = keys(viewerId);
  return {
    titles: async () =>
      (await deps.notes.mentionIndex(viewerId, scopes)).map((n) => ({
        ...n,
        path: fromStored(n.path),
      })),
    links: async (paths) =>
      (await deps.notes.linksTouching(viewerId, paths.map(toStored), scopes)).map((l) => ({
        ...l,
        source: fromStored(l.source),
        target: fromStored(l.target),
      })),
    digests: async (paths, bodyChars) =>
      (await deps.notes.contextDigests(viewerId, paths.map(toStored), bodyChars, scopes)).map(
        (d) => ({ ...d, path: fromStored(d.path) }),
      ),
    // Search ranks across every vault and filters by scope afterwards, so a
    // query asked for three hits can come back empty on a busy instance while
    // the caller's notes do match. Asking for more and trimming here is what
    // keeps "no-match" honest.
    search: async (query, limit) => {
      const hits = await deps.search.search(viewerId, query, {
        limit: Math.max(SEARCH_CANDIDATES, limit),
        includeMine: true,
        sharedScopes: scopes,
      });
      return hits.slice(0, limit).map((h) => ({
        path: h.ownerId === viewerId ? h.path : `${FOREIGN}${h.ownerId}/${h.path}`,
        snippet: h.snippet,
      }));
    },
    counts: (queries) => deps.search.counts(viewerId, queries, scopes),
  };
}

export async function gatherContext(
  deps: GatherContextDeps,
  viewerId: string,
  input: GatherContextInput,
  sharedScopes: readonly SharedScope[] = [],
): Promise<GatherContextResult> {
  const result = await crawlContext(vaultSource(deps, viewerId, sharedScopes), input);
  const { place } = keys(viewerId);
  return {
    ...result,
    notes: result.notes.map((n) => {
      const via: PlacedVia =
        n.via.kind === 'linked'
          ? (() => {
              const from = place(n.via.from);
              return {
                ...n.via,
                from: from.path,
                ...(from.ownerId ? { fromOwnerId: from.ownerId } : {}),
              };
            })()
          : n.via;
      return { ...n, ...place(n.path), via };
    }),
    unresolved: result.unresolved.map((u) =>
      u.candidates
        ? { ...u, candidates: u.candidates.map((c) => ({ ...c, ...place(c.path) })) }
        : u,
    ),
    leftOut: result.leftOut.map((n) => ({ ...n, ...place(n.path) })),
  };
}

export interface BrainSearchHit {
  path: string;
  title: string;
  snippet: string;
  /** Higher is better. */
  score: number;
  /** Owner of the vault the note lives in: the caller's own id for their own notes. */
  ownerId: string;
  /** One line for a person: why this note is here. */
  reason: string;
}

/**
 * `search_brain`: the same engine as `gather_context`, in its search mode —
 * the notes that match a query, ranked as the crawl ranks them, without
 * following links or reading bodies. `scope` narrows it to the caller's own
 * notes or to the folders shared with them.
 */
export async function searchBrain(
  deps: GatherContextDeps,
  viewerId: string,
  input: { query: string; limit?: number; scope: 'mine' | 'shared' | 'all' },
  sharedScopes: readonly SharedScope[] = [],
): Promise<BrainSearchHit[]> {
  const scopes = input.scope === 'mine' ? [] : sharedScopes;
  const hits = await searchNotes(vaultSource(deps, viewerId, scopes), input);
  const { place } = keys(viewerId);
  const placed = hits.map((h) => ({ hit: h, at: place(h.path) }));
  return placed
    .filter(({ at }) => input.scope !== 'shared' || at.ownerId !== undefined)
    .map(({ hit, at }) => ({
      path: at.path,
      title: hit.title,
      snippet: hit.snippet,
      score: hit.score,
      ownerId: at.ownerId ?? viewerId,
      reason: hit.reason,
    }));
}
