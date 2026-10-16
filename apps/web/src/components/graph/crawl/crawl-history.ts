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
  /** Notes the assistant wrote after it read. Absent from older servers. */
  writes?: number;
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

/**
 * What the crawl is called in a list: its prompt, or — for writes an assistant
 * made with no crawl before them — what it saved.
 */
export function crawlLabel(c: Pick<RecentCrawl, 'prompt' | 'writes'>): string {
  if (c.prompt.trim()) return c.prompt;
  const n = c.writes ?? 0;
  return `Saved ${n} ${n === 1 ? 'note' : 'notes'}`;
}

/** "4 notes", or "4 notes · wrote 2" when the assistant also wrote. */
export function crawlCounts(c: Pick<RecentCrawl, 'notes' | 'writes'>): string {
  const read = `${c.notes} ${c.notes === 1 ? 'note' : 'notes'}`;
  const wrote = c.writes ? `wrote ${c.writes}` : '';
  if (c.notes === 0 && wrote) return wrote;
  return wrote ? `${read} · ${wrote}` : read;
}

/** Who made it, as one word or a client's name. */
export function madeBy(c: Pick<RecentCrawl, 'source' | 'client'>): string {
  if (c.source === 'web') return 'You';
  return c.client?.trim() || 'Assistant';
}
