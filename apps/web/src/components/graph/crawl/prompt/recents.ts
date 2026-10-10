// The recent searches shown under the prompt: a few small links, newest
// first. Touching one replays it. One an assistant ran over MCP that this
// browser has not played yet is marked new — and never starts on its own: the
// prompt is where the person decides what to watch. Pure, so it is tested
// directly; the ids played are kept per browser (`readSeen`, `writeSeen`), or
// on every visit to the view — its default — the latest few would all read new
// again, and the mark would stop meaning anything.

import { ago, madeBy, type RecentCrawl } from '../crawl-history';

export interface PromptRecent {
  id: string;
  prompt: string;
  /** Who, when and how much: "Claude · 3 min. ago · 12 notes". */
  meta: string;
  /** An assistant ran it and this browser has not played it: marked, never started. */
  fresh: boolean;
}

/** Recent crawls under the prompt at most: enough to go back to, few enough to stay discreet. */
export const RECENT_MOST = 5;

/** The newest `most` of `items`, as the prompt lists them. */
export function promptRecents(
  items: readonly RecentCrawl[],
  seen: ReadonlySet<string>,
  now: number,
  most = RECENT_MOST,
): PromptRecent[] {
  return [...items]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, most))
    .map((c) => ({
      id: c.id,
      prompt: c.prompt,
      meta: `${madeBy(c)} · ${ago(c.createdAt, now)} · ${c.notes} ${c.notes === 1 ? 'note' : 'notes'}`,
      fresh: c.source === 'assistant' && !seen.has(c.id),
    }));
}

/** What `readSeen` and `writeSeen` touch: `localStorage`, or a fake in a test. */
export type SeenStore = Pick<Storage, 'getItem' | 'setItem'>;

const SEEN_KEY = 'brainstack.graph.sentinel.seen';

/** Played ids kept at most: twice what the server keeps of anyone's history, and a few kilobytes. */
export const SEEN_MOST = 100;

/** The ids played in this browser, oldest first; none from a store that is blocked or holds anything else. */
export function readSeen(store: SeenStore | null): Set<string> {
  try {
    const raw: unknown = JSON.parse(store?.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** `id` played now: moved to the newest end, the oldest dropped past `most`. In place. */
export function addSeen(seen: Set<string>, id: string, most = SEEN_MOST): void {
  seen.delete(id);
  seen.add(id);
  for (const old of seen) {
    if (seen.size <= most) break;
    seen.delete(old);
  }
}

export function writeSeen(store: SeenStore | null, seen: ReadonlySet<string>): void {
  try {
    store?.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // storage blocked or full: the mark goes on this visit and may come back on the next
  }
}
