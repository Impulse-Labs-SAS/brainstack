import { describe, expect, it } from 'vitest';

import { ago, madeBy } from './crawl-history';

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
