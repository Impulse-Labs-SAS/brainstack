import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, buildGraphModel } from '@/lib/graph-model';

import { CrawlReplay } from './crawl-replay';
import { emptySnapshot, walkOver, type CrawlSnapshot } from './crawl-snapshot';
import { sampleVault } from './sample-vault';

describe('walkOver', () => {
  it('is over once the walk is done, and not while it walks or reads', () => {
    const loaded: CrawlSnapshot = { ...emptySnapshot(), coverage: { resolved: 1, total: 1 } };
    expect(walkOver({ ...loaded, state: 'done' })).toBe(true);
    expect(walkOver({ ...loaded, state: 'walking' })).toBe(false);
    expect(walkOver({ ...loaded, state: 'reading' })).toBe(false);
  });

  it('has not begun with nothing loaded', () => {
    expect(walkOver(null)).toBe(false);
    expect(walkOver(emptySnapshot())).toBe(false);
  });

  it('is over for a crawl with no note to start from: it never sets out, so the panel must not wait', () => {
    const empty = buildGraphModel({
      nodes: [],
      edges: [],
      affinity: null,
      layers: DEFAULT_LAYERS,
      viewerId: 'me',
      vaultNames: new Map(),
      cache: new Map(),
    });
    const r = new CrawlReplay(() => {});
    r.load(sampleVault().crawls.walk, empty);
    expect(r.snapshot.state).toBe('idle');
    expect(walkOver(r.snapshot)).toBe(true);
  });
});
