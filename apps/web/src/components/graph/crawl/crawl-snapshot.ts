// What the panel shows of a crawl as it replays: its state, what it found and
// asked, and its log. The replay sends a new one only when something a person
// would read changes, so React hears about the walk without running beside it.

import type { ReachKind } from './crawl-plan';

/** What the panel shows, sent only when it changes. */
export interface CrawlSnapshot {
  state: 'idle' | 'walking' | 'reading' | 'done';
  phase: 0 | 1 | 2;
  log: Array<{ t: number; kind: ReachKind | 'ask' | 'walk' | 'done'; verb: string; text: string }>;
  found: { named: number; linked: number; decision: number };
  /** Every note found so far, in the order found, as `place` keys it: the panel lists them as the walk reaches them. */
  reached: readonly string[];
  asks: Array<{ term: string; why: string }>;
  threads: number;
  coverage: { resolved: number; total: number } | null;
  offGraph: number;
  following: boolean;
}

/**
 * The walk has nothing left to show: it ended, or a crawl was loaded with no
 * note to start from (every one hidden, say) and it never set out. Either
 * way the panel lists everything at once rather than wait for it. Nothing
 * loaded at all — no coverage yet — is not over: it has not begun.
 */
export function walkOver(s: CrawlSnapshot | null): boolean {
  if (!s) return false;
  return s.state === 'done' || (s.state === 'idle' && s.coverage !== null);
}

/** Nothing loaded: idle, nothing found, and following (the next walk starts followed). */
export function emptySnapshot(): CrawlSnapshot {
  return {
    state: 'idle',
    phase: 0,
    log: [],
    found: { named: 0, linked: 0, decision: 0 },
    reached: [],
    asks: [],
    threads: 0,
    coverage: null,
    offGraph: 0,
    following: true,
  };
}
