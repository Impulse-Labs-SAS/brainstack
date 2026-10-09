// The recent crawls shown under the prompt: a few small links, newest first.
// Touching one replays it. A crawl an assistant ran over MCP that this view
// has not shown yet is marked new — and never starts on its own: the prompt
// is where the person decides what to watch. Pure, so it is tested directly;
// crawl-history.ts, which the Crawl panel reads, is left as it is.

import { ago, madeBy, type RecentCrawl } from '../crawl-history';

export interface PromptRecent {
  id: string;
  prompt: string;
  /** Who, when and how much: "Claude · 3 min. ago · 12 notes". */
  meta: string;
  /** An assistant ran it and this view has not shown it: marked, never started. */
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
