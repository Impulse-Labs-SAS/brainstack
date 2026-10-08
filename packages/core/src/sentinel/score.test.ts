import { describe, expect, it } from 'vitest';

import {
  CandidateSet,
  DECISION_FACTOR,
  MIN_EXCERPT_CHARS,
  NAMED_SCORE,
  describeCandidate,
  demoteOffTopic,
  describeVia,
  excerpt,
  expandHop,
  isIndex,
  packContext,
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
  const terms = (...names: string[]) => ({
    weights: new Map(names.map((t) => [t, 1])),
    namedFolders: [],
  });
  const hit = (path: string, term: string, rank: number) => ({
    path,
    score: 0,
    via: { kind: 'search' as const, term, rank },
  });

  it('keeps the strongest reason a note was reached by', () => {
    const set = new CandidateSet();
    set.setContext(terms('x', 'y'));
    set.offer(hit('a.md', 'x', 2));
    set.offer(named('a.md'));
    set.offer(hit('a.md', 'y', 1));
    expect(set.get('a.md')?.via.kind).toBe('named');
    expect(set.get('a.md')?.score).toBe(NAMED_SCORE);
  });

  it('ranks a note several searches find above one a single search finds first', () => {
    const set = new CandidateSet();
    set.setContext(terms('x', 'y', 'z'));
    set.offer(hit('first.md', 'x', 0));
    for (const term of ['x', 'y', 'z']) set.offer(hit('every.md', term, 2));
    expect(set.get('every.md')!.score).toBeGreaterThan(set.get('first.md')!.score);
    expect(set.get('every.md')!.score).toBeLessThan(NAMED_SCORE);
    expect(set.get('every.md')).toMatchObject({ via: { term: 'x' }, also: ['y', 'z'] });
  });

  it('counts a better rank for more than a worse one', () => {
    const set = new CandidateSet();
    set.setContext(terms('x'));
    set.offer(hit('top.md', 'x', 0));
    set.offer(hit('third.md', 'x', 2));
    expect(set.get('top.md')!.score).toBeGreaterThan(set.get('third.md')!.score);
  });

  it('counts the same search once, however often it is offered', () => {
    const once = new CandidateSet();
    once.setContext(terms('x'));
    once.offer(hit('a.md', 'x', 2));
    const twice = new CandidateSet();
    twice.setContext(terms('x'));
    twice.offer(hit('a.md', 'x', 2));
    twice.offer(hit('a.md', 'x', 2));
    expect(twice.get('a.md')!.score).toBe(once.get('a.md')!.score);
  });

  it('adds a link to a search: a shared word and a written link are two reasons', () => {
    const linked = {
      kind: 'linked' as const,
      from: 'hub.md',
      fromTitle: 'Hub',
      direction: 'out' as const,
      hop: 1,
    };
    const both = new CandidateSet();
    both.setContext(terms('x'));
    both.offer({ path: 'a.md', score: 0.5, via: linked });
    both.offer(hit('a.md', 'x', 2));
    const searchOnly = new CandidateSet();
    searchOnly.setContext(terms('x'));
    searchOnly.offer(hit('a.md', 'x', 2));
    expect(both.get('a.md')!.score).toBeGreaterThan(searchOnly.get('a.md')!.score);
    // Coverage is what the score is built on, so it is the reason named first.
    expect(both.get('a.md')).toMatchObject({ via: { kind: 'search' }, alsoFrom: ['Hub'] });
  });

  it('adds up the notes that link to a note, but not the ones it links to', () => {
    const link = (from: string, direction: 'out' | 'in') => ({
      kind: 'linked' as const,
      from,
      fromTitle: from.toUpperCase(),
      direction,
      hop: 1,
    });
    const set = new CandidateSet();
    // A hinge: three results link to it.
    for (const from of ['a.md', 'b.md', 'c.md']) {
      set.offer({ path: 'hinge.md', score: 0.5, via: link(from, 'out') });
    }
    // An index: it links to three results.
    for (const from of ['a.md', 'b.md', 'c.md']) {
      set.offer({ path: 'index.md', score: 0.5, via: link(from, 'in') });
    }
    set.offer({ path: 'single.md', score: 0.5, via: link('a.md', 'in') });
    expect(set.get('hinge.md')).toMatchObject({
      via: { from: 'a.md' },
      alsoFrom: ['B.MD', 'C.MD'],
    });
    expect(set.get('hinge.md')!.score).toBeGreaterThan(set.get('index.md')!.score);
    expect(set.get('index.md')!.score).toBe(set.get('single.md')!.score);
  });
});

describe('isIndex', () => {
  it('reads a note that is mostly a list of links as an index', () => {
    const list = Array.from({ length: 6 }, (_, i) => `- [[note-${i}]] — what it covers`).join('\n');
    expect(isIndex(`# Project\n\nWhere to start.\n\n${list}`)).toBe(true);
  });

  it('does not read prose that links as it goes as one', () => {
    const prose = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}, see [[note-${i}]].`);
    const filler = Array.from({ length: 8 }, (_, i) => `More prose, line ${i}.`);
    expect(isIndex([...prose, ...filler].join('\n'))).toBe(false);
    expect(isIndex('- [[a]]\n- [[b]]')).toBe(false);
  });
});

describe('expandHop', () => {
  it('follows links both ways, keeping more of the score along a link the note wrote', () => {
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
      via: { kind: 'linked', from: 'seed.md', fromTitle: 'SEED.MD', direction: 'out', hop: 1 },
    });
    expect(set.get('in.md')?.via).toMatchObject({ direction: 'in' });
    expect(set.get('out.md')!.score).toBeGreaterThan(set.get('in.md')!.score);
    expect(set.has('far.md')).toBe(false);
  });

  it('weighs a note’s first links above its later ones', () => {
    const set = new CandidateSet();
    set.offer(named('index.md'));
    const edges = [
      { source: 'index.md', target: 'third.md', position: 300 },
      { source: 'index.md', target: 'first.md', position: 10 },
      { source: 'index.md', target: 'second.md', position: 120 },
      { source: 'index.md', target: 'unplaced.md' },
    ];
    expandHop(set, ['index.md'], edges, 1, (p) => p);
    const score = (p: string) => set.get(p)!.score;
    expect(score('first.md')).toBeGreaterThan(score('second.md'));
    expect(score('second.md')).toBeGreaterThan(score('third.md'));
    expect(score('third.md')).toBeGreaterThan(score('unplaced.md'));
  });

  it('keeps a decision that only links in under any note the seed links out to', () => {
    // The case that prompted the split: an index's overview lost to decisions
    // that merely mention the product. One hop from the named note, the
    // decision is relevant and weighs more — and still stays under.
    const set = new CandidateSet();
    set.offer(named('seed.md'));
    const edges = [
      { source: 'seed.md', target: 'overview.md' },
      { source: 'decision.md', target: 'seed.md' },
    ];
    expandHop(set, ['seed.md'], edges, 1, (p) => p);
    const digests = new Map([
      ['seed.md', digest('seed.md', 's')],
      ['overview.md', digest('overview.md', 'o')],
      ['decision.md', digest('decision.md', 'd', true)],
    ]);
    const { notes } = packContext(set.all(), digests, 10_000);
    expect(notes.map((n) => n.path)).toEqual(['seed.md', 'overview.md', 'decision.md']);
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

describe('demoteOffTopic', () => {
  const fold = (s: string) => s.toLowerCase();
  const prompt = (path: string) => ({
    path,
    score: 0.6,
    via: { kind: 'prompt' as const, rank: 0 },
  });
  const linkedFrom = (path: string, from: string) => ({
    path,
    score: 0.3,
    via: { kind: 'linked' as const, from, fromTitle: from, direction: 'out' as const, hop: 1 },
  });
  const digests = new Map([
    ['other.md', digest('other.md', 'Visión general de otro producto')],
    ['near.md', digest('near.md', 'Cómo Orbit factura')],
    ['child.md', digest('child.md', 'Detalle del otro producto')],
    ['orbit-child.md', digest('orbit-child.md', 'Un módulo de Orbit')],
  ]);

  it('halves a question hit that never says what the text named', () => {
    const out = demoteOffTopic([prompt('other.md'), prompt('near.md')], digests, ['Orbit'], fold);
    expect(out.map((c) => c.score)).toEqual([0.3, 0.6]);
  });

  it('halves what only an off-topic hit led to, unless it mentions the named term', () => {
    const out = demoteOffTopic(
      [
        prompt('other.md'),
        linkedFrom('child.md', 'other.md'),
        linkedFrom('orbit-child.md', 'other.md'),
      ],
      digests,
      ['Orbit'],
      fold,
    );
    expect(out.map((c) => c.score)).toEqual([0.3, 0.15, 0.3]);
  });

  it('leaves everything alone when the text named nothing', () => {
    const out = demoteOffTopic([prompt('other.md')], digests, [], fold);
    expect(out[0]!.score).toBe(0.6);
  });

  it('leaves a note the text named, or a term found, alone', () => {
    const term = {
      path: 'other.md',
      score: 0.7,
      via: { kind: 'search' as const, term: 'x', rank: 0 },
    };
    expect(
      demoteOffTopic([named('other.md'), term], digests, ['Orbit'], fold).map((c) => c.score),
    ).toEqual([NAMED_SCORE, 0.7]);
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
    const billing = {
      kind: 'linked' as const,
      from: 'b.md',
      fromTitle: 'Billing',
      direction: 'out' as const,
      hop: 1,
    };
    expect(
      describeCandidate({
        via: { kind: 'search', term: 'pricing', rank: 0 },
        also: ['tiers', 'plans'],
      }),
    ).toBe('matches "pricing", "tiers" and "plans"');
    expect(describeCandidate({ via: billing, also: ['tiers'] })).toBe(
      'linked from Billing; also matches "tiers"',
    );
    expect(
      describeCandidate({ via: billing, alsoFrom: ['Orbit', 'Ventas'], also: ['tiers'] }),
    ).toBe('linked from Billing, Orbit and Ventas; also matches "tiers"');
    expect(
      describeCandidate({
        via: { kind: 'search', term: 'invoice', rank: 0 },
        alsoFrom: ['Billing'],
      }),
    ).toBe('matches "invoice"; also linked from Billing');
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
      {
        path: 'plain.md',
        score: 0.5,
        via: { kind: 'search' as const, term: 'x', rank: 2 },
        relevant: true,
      },
      {
        path: 'decided.md',
        score: 0.5,
        via: { kind: 'search' as const, term: 'x', rank: 2 },
        relevant: true,
      },
    ];
    const digests = new Map([
      ['plain.md', digest('plain.md', 'p')],
      ['decided.md', digest('decided.md', 'd', true)],
    ]);
    const { notes } = packContext(candidates, digests, 10_000);
    expect(notes.map((n) => n.path)).toEqual(['decided.md', 'plain.md']);
    expect(notes[0]!.score).toBe(0.5 * DECISION_FACTOR);
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

  it('names the notes that did not fit, best first, without their bodies', () => {
    const candidates = [
      named('big.md'),
      { path: 'next.md', score: 0.7, via: { kind: 'search' as const, term: 'x', rank: 0 } },
      { path: 'last.md', score: 0.2, via: { kind: 'search' as const, term: 'x', rank: 5 } },
    ];
    const digests = new Map(candidates.map((c) => [c.path, digest(c.path, 'word '.repeat(400))]));
    // Room for the first body whole (1,999 characters once trimmed), and then
    // less than an excerpt worth reading.
    const { notes, leftOut } = packContext(candidates, digests, 1_999 + MIN_EXCERPT_CHARS - 1);
    expect(notes.map((n) => n.path)).toEqual(['big.md']);
    expect(leftOut).toEqual([
      { path: 'next.md', title: 'next', reason: 'matches "x"' },
      { path: 'last.md', title: 'last', reason: 'matches "x"' },
    ]);
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
