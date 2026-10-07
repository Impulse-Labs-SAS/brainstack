import { describe, expect, it } from 'vitest';

import { ago, madeBy, newAssistantCrawl, type RecentCrawl } from './crawl-history';

const crawl = (id: string, createdAt: number, source: RecentCrawl['source']): RecentCrawl => ({
  id,
  createdAt,
  source,
  client: null,
  prompt: id,
  notes: 1,
});

describe('newAssistantCrawl', () => {
  it('picks the newest crawl an assistant made that the view has not seen', () => {
    const items = [crawl('c', 3, 'web'), crawl('b', 2, 'assistant'), crawl('a', 1, 'assistant')];
    expect(newAssistantCrawl(items, new Set(['a']))?.id).toBe('b');
  });

  it('leaves crawls made by hand, and seen ones, alone', () => {
    const items = [crawl('c', 3, 'web'), crawl('b', 2, 'assistant')];
    expect(newAssistantCrawl(items, new Set(['b']))).toBeNull();
  });
});

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
