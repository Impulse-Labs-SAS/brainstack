// The scoring model: coverage of the searched terms is the base, links only
// break ties, and neither saturates.

import { describe, expect, it } from 'vitest';

import {
  CandidateSet,
  DECISION_FACTOR,
  MAX_LINK,
  NAMED_SCORE,
  OUT_OF_FOLDER_FACTOR,
  SEARCH_HITS_PER_TERM,
  packContext,
  termWeight,
  type Digest,
} from './score.js';

const digest = (path: string, body: string, isDecision = false): Digest => ({
  path,
  title: path.replace(/\.md$/, ''),
  body,
  isDecision,
});

describe('coverage and links', () => {
  const linkFrom = (from: string, score = 1) => ({
    path: 'linked.md',
    score,
    via: { kind: 'linked' as const, from, fromTitle: from, direction: 'out' as const, hop: 1 },
  });
  const hit = (path: string, term: string, rank = 0) => ({
    path,
    score: 0,
    via: { kind: 'search' as const, term, rank },
  });

  it('never lets links, however many, outweigh one covered term', () => {
    const set = new CandidateSet();
    set.setContext({
      weights: new Map([
        ['common', 0.2],
        ['rare', 2],
      ]),
      namedFolders: [],
    });
    // The weakest term there is, at the worst rank kept.
    set.offer(hit('covered.md', 'common', SEARCH_HITS_PER_TERM - 1));
    for (let i = 0; i < 50; i++) set.offer(linkFrom(`parent-${i}.md`));
    expect(set.get('linked.md')!.score).toBeLessThan(set.get('covered.md')!.score);
    expect(set.get('linked.md')!.score).toBeLessThanOrEqual(MAX_LINK);
  });

  it('ranks covering more terms above covering fewer, and keeps the scores apart', () => {
    const set = new CandidateSet();
    const terms = ['a', 'b', 'c', 'd'];
    set.setContext({ weights: new Map(terms.map((t) => [t, 1])), namedFolders: [] });
    for (const t of terms) set.offer(hit('four.md', t, 2));
    for (const t of ['a', 'b']) set.offer(hit('two.md', t, 0));
    const four = set.get('four.md')!.score;
    const two = set.get('two.md')!.score;
    expect(four).toBeGreaterThan(two);
    expect(four - two).toBeGreaterThan(0.1);
    expect(four).toBeLessThan(NAMED_SCORE);
  });

  it('weighs a rare term above a common one', () => {
    expect(termWeight(3, 100)).toBeGreaterThan(termWeight(60, 100));
    expect(termWeight(100, 100)).toBeGreaterThan(0);
  });

  it('halves a search hit outside the named folders, but never a note reached by a link', () => {
    const set = new CandidateSet();
    set.setContext({ weights: new Map([['t', 1]]), namedFolders: ['orbit'] });
    set.offer(hit('orbit/in.md', 't'));
    set.offer(hit('ledger/out.md', 't'));
    expect(set.get('ledger/out.md')!.score).toBeCloseTo(
      set.get('orbit/in.md')!.score * OUT_OF_FOLDER_FACTOR,
    );

    for (const path of ['orbit/hinge.md', 'ledger/hinge.md']) {
      set.offer({ ...linkFrom('orbit/_orbit.md'), path });
    }
    expect(set.get('ledger/hinge.md')!.score).toBe(set.get('orbit/hinge.md')!.score);
  });

  it('gives a decision more only when it is relevant on its own', () => {
    const digests = new Map([
      ['hit.md', digest('hit.md', 'h', true)],
      ['far.md', digest('far.md', 'f', true)],
    ]);
    const { notes } = packContext(
      [
        { path: 'hit.md', score: 0.4, via: { kind: 'search', term: 'x', rank: 0 }, relevant: true },
        { path: 'far.md', score: 0.4, via: linkFrom('a.md').via, relevant: false },
      ],
      digests,
      10_000,
    );
    expect(notes.find((n) => n.path === 'hit.md')!.score).toBeCloseTo(0.4 * DECISION_FACTOR);
    expect(notes.find((n) => n.path === 'far.md')!.score).toBe(0.4);
  });
});
