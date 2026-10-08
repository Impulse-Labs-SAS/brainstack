import { describe, expect, it } from 'vitest';

import { facetSignal, rankRelated, signalReason, tagSignal } from './relatedNotes.js';

describe('rankRelated', () => {
  it('ranks a note sharing a rare signal above one sharing only a common one', () => {
    // rare: only A and B carry it (count 2). common: A, C, D, E all do (count 4).
    const hits = [
      { path: 'B', signal: tagSignal('rare') },
      { path: 'C', signal: tagSignal('common') },
      { path: 'D', signal: tagSignal('common') },
      { path: 'E', signal: tagSignal('common') },
    ];
    const counts = [
      { signal: tagSignal('rare'), count: 2 },
      { signal: tagSignal('common'), count: 4 },
    ];

    const ranked = rankRelated(hits, counts, 10);
    expect(ranked[0]?.path).toBe('B');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('sums weight across multiple shared signals', () => {
    const hits = [
      { path: 'B', signal: tagSignal('x') },
      { path: 'B', signal: facetSignal('technologies', 'nextjs') },
      { path: 'C', signal: tagSignal('x') },
    ];
    const counts = [
      { signal: tagSignal('x'), count: 2 },
      { signal: facetSignal('technologies', 'nextjs'), count: 5 },
    ];

    const ranked = rankRelated(hits, counts, 10);
    const b = ranked.find((r) => r.path === 'B')!;
    const c = ranked.find((r) => r.path === 'C')!;
    expect(b.score).toBeGreaterThan(c.score);
    expect(b.signals).toHaveLength(2);
  });

  it('limits the result and orders it best first', () => {
    const hits = [1, 2, 3, 4].map((n) => ({ path: `n${n}`, signal: tagSignal('x') }));
    const counts = [{ signal: tagSignal('x'), count: 1 }];

    const ranked = rankRelated(hits, counts, 2);
    expect(ranked).toHaveLength(2);
  });

  it('treats an unknown signal as zero weight rather than throwing', () => {
    const hits = [{ path: 'B', signal: tagSignal('ghost') }];
    const ranked = rankRelated(hits, [], 10);
    expect(ranked).toEqual([{ path: 'B', score: 0, signals: [tagSignal('ghost')] }]);
  });
});

describe('related reasons', () => {
  it('lists a note’s signals rarest first', () => {
    const hits = [
      { path: 'B', signal: facetSignal('technologies', 'postgres') },
      { path: 'B', signal: tagSignal('atlas') },
    ];
    const counts = [
      { signal: facetSignal('technologies', 'postgres'), count: 20 },
      { signal: tagSignal('atlas'), count: 3 },
    ];
    expect(rankRelated(hits, counts, 10)[0]?.signals).toEqual([
      tagSignal('atlas'),
      facetSignal('technologies', 'postgres'),
    ]);
  });

  it('turns a signal back into the tag or facet it stands for', () => {
    expect(signalReason(tagSignal('proyecto/atlas'))).toEqual({ kind: 'tag', tag: 'proyecto/atlas' });
    expect(signalReason(facetSignal('status', 'a:b'))).toEqual({
      kind: 'facet',
      key: 'status',
      value: 'a:b',
    });
    expect(signalReason('other')).toBeNull();
  });
});
