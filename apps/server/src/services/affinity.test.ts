import { describe, expect, it } from 'vitest';

import { affinityEdges, buildTopics, isTopicRow, type TopicRow } from './affinity.js';

const tag = (path: string, value: string): TopicRow => ({ path, kind: 'tag', value });
const facet = (path: string, key: string, value: string): TopicRow => ({
  path,
  kind: 'facet',
  key,
  value,
});

describe('isTopicRow', () => {
  it('keeps content tags and facets', () => {
    expect(isTopicRow(tag('a.md', 'proyecto/atlas'))).toBe(true);
    expect(isTopicRow(tag('a.md', 'ia'))).toBe(true);
    expect(isTopicRow(facet('a.md', 'technologies', 'nextjs'))).toBe(true);
  });

  it('drops tags that classify a note instead of describing it', () => {
    expect(isTopicRow(tag('a.md', 'tipo/moc'))).toBe(false);
    expect(isTopicRow(tag('a.md', 'persona/frodo'))).toBe(false);
    expect(isTopicRow(tag('a.md', 'decisión'))).toBe(false);
  });

  it('drops workflow, authorship, date and presentation facets', () => {
    for (const key of ['status', 'owner', 'created', 'aliases', 'title']) {
      expect(isTopicRow(facet('a.md', key, 'x'))).toBe(false);
    }
  });
});

describe('buildTopics', () => {
  it('keeps a topic shared by two notes, weighted by rarity', () => {
    const topics = buildTopics(
      [facet('a.md', 'technologies', 'gemini-api'), facet('b.md', 'technologies', 'gemini-api')],
      20,
    );
    expect(topics).toEqual([
      {
        id: 'facet:technologies:gemini-api',
        kind: 'facet',
        key: 'technologies',
        label: 'gemini-api',
        notes: ['a.md', 'b.md'],
        weight: 0.5,
      },
    ]);
  });

  it('drops a topic only one note carries', () => {
    expect(buildTopics([tag('a.md', 'ia')], 20)).toEqual([]);
  });

  it('drops a topic that covers more than a quarter of the vault', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => tag(`${n}.md`, 'comun'));
    // 20 notes: cap is 5, and six carry it.
    expect(buildTopics(rows, 20)).toEqual([]);
  });

  it('still lets a small vault have topics of three notes', () => {
    const rows = ['a', 'b', 'c'].map((n) => tag(`${n}.md`, 'ia'));
    expect(buildTopics(rows, 6).map((t) => t.label)).toEqual(['ia']);
  });

  it('counts a note once per topic even if the row repeats', () => {
    const topics = buildTopics([tag('a.md', 'ia'), tag('a.md', 'ia'), tag('b.md', 'ia')], 20);
    expect(topics[0]!.notes).toEqual(['a.md', 'b.md']);
  });
});

describe('affinityEdges', () => {
  it('joins notes that share topics, summing the weights', () => {
    const topics = buildTopics(
      [
        facet('a.md', 'technologies', 'gemini-api'),
        facet('b.md', 'technologies', 'gemini-api'),
        tag('a.md', 'ia'),
        tag('b.md', 'ia'),
      ],
      20,
    );
    expect(affinityEdges(topics)).toEqual([
      { source: 'a.md', target: 'b.md', weight: 1, shared: ['gemini-api', 'ia'] },
    ]);
  });

  it("keeps each note's strongest edges only", () => {
    // Hub shares a rare topic with each of four notes; with perNote = 2 the hub
    // keeps its two strongest, but every leaf keeps its only edge to the hub.
    const rows: TopicRow[] = [];
    ['a', 'b', 'c', 'd'].forEach((leaf, i) => {
      for (let k = 0; k <= i; k++) {
        rows.push(tag('hub.md', `t${leaf}${k}`), tag(`${leaf}.md`, `t${leaf}${k}`));
      }
    });
    const edges = affinityEdges(buildTopics(rows, 100), 2);
    expect(edges.map((e) => [e.source, e.target].sort().join('-')).sort()).toEqual([
      'a.md-hub.md',
      'b.md-hub.md',
      'c.md-hub.md',
      'd.md-hub.md',
    ]);
  });

  it('drops an edge that is in neither end’s top', () => {
    // `fuerte` (2 notes) weighs 1/2, `debil` (3 notes) 1/3. With one edge per
    // note: x keeps x–y, w keeps w–x, z keeps w–z (tie with x–z, broken by
    // name). Nobody's best is x–z, so it goes.
    const rows: TopicRow[] = [
      tag('x.md', 'fuerte'),
      tag('y.md', 'fuerte'),
      tag('w.md', 'debil'),
      tag('x.md', 'debil'),
      tag('z.md', 'debil'),
    ];
    const edges = affinityEdges(buildTopics(rows, 100), 1);
    expect(edges.map((e) => `${e.source}-${e.target}`).sort()).toEqual([
      'w.md-x.md',
      'w.md-z.md',
      'x.md-y.md',
    ]);
  });
});
