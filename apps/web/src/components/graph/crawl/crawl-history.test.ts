import { describe, expect, it } from 'vitest';

import { ago, crawlCounts, crawlLabel, madeBy } from './crawl-history';

describe('ago', () => {
  const now = 1_000_000_000;
  it('reads like a person would say it', () => {
    expect(ago(now - 10_000, now)).toBe('now');
    expect(ago(now - 3 * 60_000, now)).toBe('3 min. ago');
    expect(ago(now - 2 * 3_600_000, now)).toBe('2 hr. ago');
    expect(ago(now - 26 * 3_600_000, now)).toBe('yesterday');
  });
});

describe('madeBy', () => {
  it('names the assistant when it is known', () => {
    expect(madeBy({ source: 'assistant', client: 'Claude' })).toBe('Claude');
    expect(madeBy({ source: 'assistant', client: null })).toBe('Assistant');
    expect(madeBy({ source: 'web', client: null })).toBe('You');
  });
});

describe('crawlLabel and crawlCounts', () => {
  it('names writes with no crawl before them by what was saved', () => {
    expect(crawlLabel({ prompt: 'roadmap?', writes: 2 })).toBe('roadmap?');
    expect(crawlLabel({ prompt: '', writes: 1 })).toBe('Saved 1 note');
    expect(crawlLabel({ prompt: '', writes: 3 })).toBe('Saved 3 notes');
  });

  it('counts what was read, and what was written when there was any', () => {
    expect(crawlCounts({ notes: 4 })).toBe('4 notes');
    expect(crawlCounts({ notes: 4, writes: 2 })).toBe('4 notes · wrote 2');
    expect(crawlCounts({ notes: 0, writes: 1 })).toBe('wrote 1');
  });
});
