// The recent-crawls list in the Crawl view — pure, tested directly.
//
// The list is polled while the view is open, so a crawl an assistant makes
// over MCP shows up within seconds. A new one plays by itself, as long as the
// view is not in the middle of another: the point of the view is to watch an
// assistant read the brain, not to go looking for what it read.

export interface RecentCrawl {
  id: string;
  createdAt: number;
  source: 'assistant' | 'web';
  client: string | null;
  prompt: string;
  notes: number;
}

/**
 * The newest crawl an assistant made that this view has not seen yet, if any.
 * A crawl made by hand never qualifies: whoever made it is already watching it.
 */
export function newAssistantCrawl(
  items: readonly RecentCrawl[],
  seen: ReadonlySet<string>,
): RecentCrawl | null {
  let newest: RecentCrawl | null = null;
  for (const c of items) {
    if (c.source !== 'assistant' || seen.has(c.id)) continue;
    if (!newest || c.createdAt > newest.createdAt) newest = c;
  }
  return newest;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });

/** "now", "3 min. ago", "yesterday". */
export function ago(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  if (s > -45) return 'now';
  const m = Math.round(s / 60);
  if (m > -60) return relative.format(m, 'minute');
  const h = Math.round(m / 60);
  if (h > -24) return relative.format(h, 'hour');
  return relative.format(Math.round(h / 24), 'day');
}

/** Who made it, as one word or a client's name. */
export function madeBy(c: Pick<RecentCrawl, 'source' | 'client'>): string {
  if (c.source === 'web') return 'You';
  return c.client?.trim() || 'Assistant';
}
