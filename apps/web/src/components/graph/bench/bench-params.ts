// The graph bench's settings, read from its query string. Pure, so it is tested without the page.

import { GRAPH_VIEWS, type GraphView } from '@/lib/graph-model';

export interface BenchParams {
  notes: number;
  seed: number;
  view: GraphView;
}

/** The smallest and largest vault the bench builds: largeVault needs 60 notes for its shape. */
const MIN_NOTES = 60;
const MAX_NOTES = 20_000;

/** The bench's settings from a query string; anything missing or out of range takes the default. */
export function benchParams(search: string): BenchParams {
  const q = new URLSearchParams(search);
  const int = (key: string, fallback: number) => {
    const raw = q.get(key)?.trim();
    // Number('') is 0: an empty value is a missing one, not a request for zero.
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) ? n : fallback;
  };
  const view = q.get('view');
  return {
    notes: Math.min(MAX_NOTES, Math.max(MIN_NOTES, int('notes', 1600))),
    seed: int('seed', 11),
    view: GRAPH_VIEWS.includes(view as GraphView) ? (view as GraphView) : 'territories',
  };
}
