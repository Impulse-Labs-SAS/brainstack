import { describe, expect, it } from 'vitest';

import {
  CandidateSet,
  DECISION_BONUS,
  HOP_DECAY,
  MIN_EXCERPT_CHARS,
  NAMED_SCORE,
  describeVia,
  excerpt,
  expandHop,
  packContext,
  searchScore,
  topFrontier,
  type Digest,
} from './score.js';

const named = (path: string) => ({
  path,
  score: NAMED_SCORE,
  via: { kind: 'named' as const, text: path, count: 1 },
});

const digest = (path: string, body: string, isDecision = false): Digest => ({
  path,
  title: path.replace(/\.md$/, ''),
  body,
  isDecision,
});

describe('CandidateSet', () => {
  it('keeps the strongest reason a note was reached by', () => {
    const set = new CandidateSet();
    set.offer({ path: 'a.md', score: 0.4, via: { kind: 'search', term: 'x', rank: 3 } });
    set.offer(named('a.md'));
    set.offer({ path: 'a.md', score: 0.5, via: { kind: 'search', term: 'y', rank: 2 } });
    expect(set.get('a.md')?.via.kind).toBe('named');
  });
});

describe('searchScore', () => {
  it('steps down with rank and never goes negative', () => {
    expect(searchScore(0)).toBeGreaterThan(searchScore(1));
    expect(searchScore(0)).toBeLessThan(NAMED_SCORE);
    expect(searchScore(100)).toBe(0);
  });
});

describe('expandHop', () => {
  it('follows links both ways and halves the score per hop', () => {
    const set = new CandidateSet();
    set.offer(named('seed.md'));
    const edges = [
      { source: 'seed.md', target: 'out.md' },
      { source: 'in.md', target: 'seed.md' },
      { source: 'far.md', target: 'elsewhere.md' },
    ];
    const reached = expandHop(set, ['seed.md'], edges, 1, (p) => p.toUpperCase());

    expect(reached.sort()).toEqual(['in.md', 'out.md']);
    expect(set.get('out.md')).toMatchObject({
      score: NAMED_SCORE * HOP_DECAY,
      via: { kind: 'linked', from: 'seed.md', fromTitle: 'SEED.MD', direction: 'out', hop: 1 },
    });
    expect(set.get('in.md')?.via).toMatchObject({ direction: 'in' });
    expect(set.has('far.md')).toBe(false);
  });

  it('does not demote a seed that a neighbour links back to', () => {
    const set = new CandidateSet();
    set.offer(named('a.md'));
    set.offer(named('b.md'));
    const reached = expandHop(set, ['a.md'], [{ source: 'a.md', target: 'b.md' }], 1, (p) => p);
    expect(reached).toEqual([]);
    expect(set.get('b.md')?.via.kind).toBe('named');
  });
});

describe('topFrontier', () => {
  it('keeps the strongest notes so a hub cannot flood the next hop', () => {
    const set = new CandidateSet();
    set.offer(named('strong.md'));
    set.offer({ path: 'weak.md', score: 0.1, via: { kind: 'search', term: 'x', rank: 6 } });
    expect(topFrontier(set, ['weak.md', 'strong.md'], 1)).toEqual(['strong.md']);
  });
});

describe('excerpt', () => {
  it('returns a short body whole', () => {
    expect(excerpt('  # Title\n\nbody  ', 100)).toEqual({
      text: '# Title\n\nbody',
      truncated: false,
    });
  });

  it('never splits an emoji in two', () => {
    const { text } = excerpt('a😀bcdefghijklmnop', 3);
    expect(text).toBe('a…');
  });

  it('cuts a long body at a word boundary and says so', () => {
    const { text, truncated } = excerpt('alpha beta gamma delta epsilon', 18);
    expect(truncated).toBe(true);
    expect(text).toBe('alpha beta gamma…');
  });
});

describe('describeVia', () => {
  it('says why, in words a person reads', () => {
    expect(describeVia({ kind: 'named', text: 'Roadmap', count: 1 })).toBe(
      'the text says "Roadmap"',
    );
    expect(describeVia({ kind: 'named', text: 'Roadmap', count: 3 })).toBe(
      'the text says "Roadmap" (3×)',
    );
    expect(describeVia({ kind: 'search', term: 'pricing', rank: 0 })).toBe('matches "pricing"');
    expect(
      describeVia({ kind: 'linked', from: 'b.md', fromTitle: 'Billing', direction: 'out', hop: 1 }),
    ).toBe('linked from Billing');
    expect(
      describeVia({ kind: 'linked', from: 'b.md', fromTitle: 'Billing', direction: 'in', hop: 1 }),
    ).toBe('links to Billing');
  });
});

describe('packContext', () => {
  it('ranks a decision above an equal note that is not one', () => {
    const candidates = [
      { path: 'plain.md', score: 0.5, via: { kind: 'search' as const, term: 'x', rank: 2 } },
      { path: 'decided.md', score: 0.5, via: { kind: 'search' as const, term: 'x', rank: 2 } },
    ];
    const digests = new Map([
      ['plain.md', digest('plain.md', 'p')],
      ['decided.md', digest('decided.md', 'd', true)],
    ]);
    const { notes } = packContext(candidates, digests, 10_000);
    expect(notes.map((n) => n.path)).toEqual(['decided.md', 'plain.md']);
    expect(notes[0]!.score).toBe(0.5 + DECISION_BONUS);
    expect(notes[0]!.isDecision).toBe(true);
  });

  it('never returns more characters than the budget', () => {
    const body = 'word '.repeat(2_000);
    const candidates = ['a.md', 'b.md', 'c.md'].map(named);
    const digests = new Map(candidates.map((c) => [c.path, digest(c.path, body)]));

    const budget = 2_000;
    const { notes, chars, dropped } = packContext(candidates, digests, budget);
    expect(chars).toBeLessThanOrEqual(budget);
    expect(notes.every((n) => n.truncated)).toBe(true);
    expect(dropped).toBeGreaterThan(0);
  });

  it('stops once what is left is too little to read', () => {
    const candidates = ['a.md', 'b.md'].map(named);
    const digests = new Map(candidates.map((c) => [c.path, digest(c.path, 'x'.repeat(500))]));
    const { notes } = packContext(candidates, digests, 500 + MIN_EXCERPT_CHARS - 1);
    expect(notes).toHaveLength(1);
  });

  it('skips a candidate whose note could not be read', () => {
    const { notes } = packContext([named('gone.md')], new Map(), 10_000);
    expect(notes).toEqual([]);
  });
});
