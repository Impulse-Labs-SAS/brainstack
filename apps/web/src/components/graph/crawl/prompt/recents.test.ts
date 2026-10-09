import { describe, expect, it } from 'vitest';

import { ago, type RecentCrawl } from '../crawl-history';

import { RECENT_MOST, promptRecents } from './recents';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function crawl(id: string, minutesAgo: number, more: Partial<RecentCrawl> = {}): RecentCrawl {
  return {
    id,
    createdAt: NOW - minutesAgo * MIN,
    source: 'web',
    client: null,
    prompt: `What about ${id}?`,
    notes: 4,
    ...more,
  };
}

describe('promptRecents', () => {
  it('lists the newest first, at most five, and fewer when there are fewer', () => {
    const items = [3, 40, 1, 12, 90, 7, 25].map((m, i) => crawl(`c${i}`, m));
    const recents = promptRecents(items, new Set(), NOW);
    expect(recents).toHaveLength(RECENT_MOST);
    expect(recents.map((r) => r.id)).toEqual(['c2', 'c0', 'c5', 'c3', 'c6']);
    expect(promptRecents(items.slice(0, 2), new Set(), NOW).map((r) => r.id)).toEqual(['c0', 'c1']);
    expect(promptRecents([], new Set(), NOW)).toEqual([]);
    expect(promptRecents(items, new Set(), NOW, 3)).toHaveLength(3);
    // The list handed in is left as it was.
    expect(items[0]!.id).toBe('c0');
  });

  it("marks an assistant's crawl not seen yet, never one made by hand or already seen", () => {
    const items = [
      crawl('mine', 1),
      crawl('theirs', 2, { source: 'assistant', client: 'Claude' }),
      crawl('watched', 3, { source: 'assistant', client: 'Claude' }),
    ];
    const recents = promptRecents(items, new Set(['watched', 'mine']), NOW);
    expect(recents.map((r) => [r.id, r.fresh])).toEqual([
      ['mine', false],
      ['theirs', true],
      ['watched', false],
    ]);
    expect(promptRecents([crawl('mine', 1)], new Set(), NOW)[0]!.fresh).toBe(false);
  });

  it('says who ran it, when, and how many notes it found', () => {
    const items = [
      crawl('a', 3, { source: 'assistant', client: 'Claude', notes: 12 }),
      crawl('b', 0, { notes: 1 }),
      crawl('c', 200, { source: 'assistant', client: null, notes: 0 }),
    ];
    const [a, b, c] = promptRecents(items, new Set(), NOW).sort((x, y) => x.id.localeCompare(y.id));
    expect(a!.meta).toBe(`Claude · ${ago(NOW - 3 * MIN, NOW)} · 12 notes`);
    expect(b!.meta).toBe('You · now · 1 note');
    expect(c!.meta).toBe(`Assistant · ${ago(NOW - 200 * MIN, NOW)} · 0 notes`);
    expect(a!.prompt).toBe('What about a?');
  });
});
