// How a recent search reads in the Sentinel view — its age and who ran it.
// Pure, tested directly.
//
// The list is polled while the view is open, so a search an assistant makes
// over MCP shows up within seconds — under the prompt, marked new until it is
// played here (prompt/recents.ts). It never plays by itself: what to watch is
// the person's to decide, and a walk under way is never cut off by another.

export interface RecentCrawl {
  id: string;
  createdAt: number;
  source: 'assistant' | 'web';
  client: string | null;
  prompt: string;
  notes: number;
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
