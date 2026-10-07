import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type GraphNode,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { findWalk, planCrawl, type CrawlResult } from './crawl-plan';

/** a — b — c — d in a line, e alone, plus somebody else's note with the same path as one of mine. */
function vault(): GraphModel {
  const note = (owner: string, path: string): InputNode => ({
    id: `${owner}/${path}`,
    path,
    title: path.replace('.md', ''),
    ownerId: owner,
    project: { id: `${owner}|p`, label: 'P' },
    createdAt: 0,
    updatedAt: 0,
  });
  const nodes = [
    note('me', 'a.md'),
    note('me', 'b.md'),
    note('me', 'c.md'),
    note('me', 'd.md'),
    note('me', 'e.md'),
    note('ana', 'a.md'),
  ];
  const edges: InputEdge[] = [
    { source: 'me/a.md', target: 'me/b.md', weight: 1 },
    { source: 'me/b.md', target: 'me/c.md', weight: 1 },
    { source: 'me/c.md', target: 'me/d.md', weight: 1 },
  ];
  const model = buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  // Lay them out on a line so distances mean something.
  model.nodes.forEach((n) => {
    const i = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].indexOf(n.path);
    Object.assign(n, { x: i * 10, y: 0, z: 0 });
  });
  return model;
}
const node = (m: GraphModel, path: string): GraphNode =>
  m.nodes.find((n) => n.path === path && !n.foreign)!;

const result: CrawlResult = {
  notes: [
    { path: 'a.md', title: 'a', isDecision: false, via: { kind: 'named', text: 'a', count: 1 } },
    { path: 'd.md', title: 'd', isDecision: false, via: { kind: 'search', term: 'dee', rank: 0 } },
    {
      path: 'b.md',
      title: 'b',
      isDecision: false,
      via: { kind: 'linked', from: 'a.md', fromTitle: 'a', direction: 'out', hop: 1 },
    },
    {
      path: 'c.md',
      title: 'c',
      isDecision: true,
      via: { kind: 'linked', from: 'd.md', fromTitle: 'd', direction: 'in', hop: 1 },
    },
  ],
  unresolved: [{ term: 'atlas', reason: 'no-match' }],
  coverage: { resolved: 2, total: 3 },
};

describe('planCrawl', () => {
  it('visits what the text names first, then asks, then follows the links from each note in turn', () => {
    const m = vault();
    const plan = planCrawl(result, m);
    expect(
      plan.steps.map((s) => (s.kind === 'visit' ? `${s.phase}:${s.at.path}` : s.kind)),
    ).toEqual(['0:a.md', '0:d.md', 'ask', '1:a.md', '1:d.md', 'finish']);
    const fromD = plan.steps[4]!;
    expect(fromD.kind === 'visit' && fromD.reach.map((r) => [r.node.path, r.kind])).toEqual([
      ['c.md', 'decision'],
    ]);
  });

  it('only ever lands on the viewer’s own notes, whatever path another vault shares', () => {
    const m = vault();
    const plan = planCrawl(result, m);
    for (const s of plan.steps) if (s.kind === 'visit') expect(s.at.foreign).toBe(false);
  });

  it('counts what the graph does not show instead of walking to it', () => {
    const m = vault();
    const plan = planCrawl(
      {
        ...result,
        notes: [
          ...result.notes,
          {
            path: 'hidden.md',
            title: 'hidden',
            isDecision: false,
            via: { kind: 'linked', from: 'a.md', fromTitle: 'a', direction: 'out', hop: 1 },
          },
        ],
      },
      m,
    );
    expect(plan.offGraph).toBe(1);
  });
});

describe('findWalk', () => {
  it('walks along the links, note by note', () => {
    const m = vault();
    expect(findWalk(m, node(m, 'a.md'), node(m, 'd.md'))?.map((n) => n.path)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md',
    ]);
  });

  it('says so when no link joins two notes, rather than walking through the void', () => {
    const m = vault();
    expect(findWalk(m, node(m, 'a.md'), node(m, 'e.md'))).toBeNull();
  });

  it('stands still when it is already there', () => {
    const m = vault();
    expect(findWalk(m, node(m, 'b.md'), node(m, 'b.md'))?.map((n) => n.path)).toEqual(['b.md']);
  });
});
