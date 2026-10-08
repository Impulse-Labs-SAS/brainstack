// The search mode: a query, the notes that match it, ranked as the crawl
// ranks them. Read through a fake source, so what is tested is the engine.

import { describe, expect, it } from 'vitest';

import type { ContextSource } from './crawl.js';
import { searchNotes } from './search.js';

/** A vault of titles, with a full-text search that answers from a fixed table. */
function source(
  titles: Array<{ path: string; title: string }>,
  hits: Record<string, string[]>,
): ContextSource & { searched: string[] } {
  const searched: string[] = [];
  return {
    searched,
    titles: async () => titles.map((t) => ({ ...t, aliases: [] })),
    links: async () => [],
    digests: async () => [],
    search: async (query, limit) => {
      searched.push(query);
      return (hits[query] ?? []).slice(0, limit).map((path) => ({ path, snippet: `…${path}…` }));
    },
  };
}

const vault = [
  { path: 'orbit/_orbit.md', title: 'Orbit' },
  { path: 'orbit/pricing.md', title: 'Planes de precios' },
  { path: 'ledger/pricing.md', title: 'Ledger pricing' },
];

describe('searchNotes', () => {
  it('lists what the query names first, then what the rest of it finds', async () => {
    const src = source(vault, { pricing: ['ledger/pricing.md', 'orbit/pricing.md'] });
    const hits = await searchNotes(src, { query: 'pricing Orbit' });
    // "Orbit" named a note; only "pricing" is searched.
    expect(src.searched).toEqual(['pricing']);
    expect(hits.map((h) => h.path)).toEqual([
      'orbit/_orbit.md',
      // Outside the named note's folder a hit counts half, whatever its rank.
      'orbit/pricing.md',
      'ledger/pricing.md',
    ]);
    expect(hits[0]).toMatchObject({ reason: 'the text says "Orbit"', snippet: '' });
    expect(hits[1]).toMatchObject({ title: 'Planes de precios', snippet: '…orbit/pricing.md…' });
  });

  it('searches the name itself when the query is nothing but a name', async () => {
    const src = source(vault, { Orbit: ['orbit/pricing.md'] });
    const hits = await searchNotes(src, { query: 'Orbit' });
    expect(src.searched).toEqual(['Orbit']);
    expect(hits.map((h) => h.path)).toEqual(['orbit/_orbit.md', 'orbit/pricing.md']);
  });

  it('keeps the ranks of a long list apart and honours the limit', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, '0')}.md`);
    const src = source([], { word: many });
    const hits = await searchNotes(src, { query: 'word', limit: 25 });
    expect(hits).toHaveLength(25);
    expect(hits.map((h) => h.path)).toEqual(many.slice(0, 25));
    expect(hits[24]!.score).toBeGreaterThan(0);
    expect(hits[23]!.score).toBeGreaterThan(hits[24]!.score);
  });

  it('finds nothing for an empty query', async () => {
    expect(await searchNotes(source(vault, {}), { query: '   ' })).toEqual([]);
  });
});
