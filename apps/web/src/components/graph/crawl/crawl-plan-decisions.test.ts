import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputNode,
} from '@/lib/graph-model';

import { decisionIds, type CrawlResult } from './crawl-plan';

/** Three notes of mine, one of them a decision, and one of Ana's with the same path as one of mine. */
function vault(): GraphModel {
  const note = (owner: string, path: string, isDecision = false): InputNode => ({
    id: `${owner}/${path}`,
    path,
    title: path.replace('.md', ''),
    ownerId: owner,
    project: { id: `${owner}|Ledger`, label: 'Ledger' },
    createdAt: 0,
    updatedAt: 0,
    isDecision,
  });
  return buildGraphModel({
    nodes: [
      note('me', 'atlas.md', true),
      note('me', 'erebor.md'),
      note('me', 'orbit.md'),
      note('ana', 'orbit.md'),
    ],
    edges: [{ source: 'me/atlas.md', target: 'me/erebor.md', weight: 1 }],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
}

type Handed = CrawlResult['notes'][number];

function crawl(...notes: Handed[]): CrawlResult {
  return { notes, unresolved: [], coverage: { resolved: notes.length, total: notes.length } };
}

const named = (path: string, isDecision: boolean, ownerId?: string): Handed => ({
  path,
  ...(ownerId ? { ownerId } : {}),
  title: path,
  isDecision,
  via: { kind: 'named', text: path, count: 1 },
});

const linked = (path: string, isDecision: boolean, ownerId?: string): Handed => ({
  path,
  ...(ownerId ? { ownerId } : {}),
  title: path,
  isDecision,
  via: { kind: 'linked', from: 'atlas.md', fromTitle: 'atlas', direction: 'out', hop: 1 },
});

describe('decisionIds', () => {
  it('takes what the graph marks when there is no crawl', () => {
    expect([...decisionIds(null, vault())]).toEqual(['me/atlas.md']);
  });

  it("adds a decision the crawl hands over over a link, and keeps the graph's", () => {
    const ids = decisionIds(crawl(named('atlas.md', false), linked('erebor.md', true)), vault());
    expect([...ids].sort()).toEqual(['me/atlas.md', 'me/erebor.md']);
  });

  it('ignores a crawl decision the graph does not show', () => {
    const ids = decisionIds(crawl(linked('lost/elsewhere.md', true)), vault());
    expect([...ids]).toEqual(['me/atlas.md']);
  });

  it('matches a shared note by its owner, never my note with the same path', () => {
    const ids = decisionIds(crawl(linked('orbit.md', true, 'ana')), vault());
    expect(ids.has('ana/orbit.md')).toBe(true);
    expect(ids.has('me/orbit.md')).toBe(false);
  });
});
