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
  asks: Array<{ term: string; why: string }>;
  threads: number;
  coverage: { resolved: number; total: number } | null;
  offGraph: number;
  following: boolean;
}

/** Nothing loaded: idle, nothing found, and following (the next walk starts followed). */
export function emptySnapshot(): CrawlSnapshot {
  return {
    state: 'idle',
    phase: 0,
    log: [],
    found: { named: 0, linked: 0, decision: 0 },
    asks: [],
    threads: 0,
    coverage: null,
    offGraph: 0,
    following: true,
  };
}
