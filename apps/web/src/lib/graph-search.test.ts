import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, buildGraphModel, type AffinityInput, type InputEdge, type InputNode } from './graph-model';
import { DEFAULT_FILTERS, activeFilterCount, matchRange, projectOptions, searchGraph, tagOptions, type SearchFilters } from './graph-search';

const NOW = 1_000 * 86_400_000;
const DAY = 86_400_000;
const note = (path: string, extra: Partial<InputNode> = {}): InputNode => {
  const project = path.split('/')[0]!;
  return {
    id: path,
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    ownerId: 'me',
    project: { id: `folder:|${project}`, label: project },
    createdAt: 0,
    updatedAt: NOW - 200 * DAY,
    ...extra,
  };
};

const nodes = [
  note('Kora/_Kora.md'),
  note('Kora/Plan de corte.md', { updatedAt: NOW - 2 * DAY }),
  note('Kora/decisiones/Replanificación.md'),
  note('Lumen/Planes de ejecución.md', { updatedAt: NOW - 20 * DAY }),
  note('Lumen/Plan.md'),
  note('Lumen/Investigación UX.md'),
  note('Diario/Suelta.md'),
];
const edges: InputEdge[] = [
  { source: 'Kora/_Kora.md', target: 'Kora/Plan de corte.md', weight: 1 },
  ...['Lumen/Plan.md', 'Lumen/Investigación UX.md', 'Kora/Plan de corte.md', 'Kora/decisiones/Replanificación.md', 'Diario/Suelta.md'].map(
    (target) => ({ source: 'Lumen/Planes de ejecución.md', target, weight: 1 }),
  ),
];
const affinity: AffinityInput = {
  topics: [{ id: 'tag:ux', kind: 'tag', key: null, label: 'ux', notes: ['Lumen/Investigación UX.md', 'Lumen/Plan.md'], weight: 1 }],
  edges: [],
};
const model = buildGraphModel({ nodes, edges: edges.slice(0, 1), affinity, layers: DEFAULT_LAYERS, viewerId: 'me', vaultNames: new Map(), cache: new Map() });
const hubModel = buildGraphModel({ nodes, edges, affinity, layers: DEFAULT_LAYERS, viewerId: 'me', vaultNames: new Map(), cache: new Map() });

const search = (query: string, filters: Partial<SearchFilters> = {}, m = model) =>
  searchGraph(m.nodes, query, { ...DEFAULT_FILTERS, ...filters }, NOW)?.map((n) => n.path) ?? [];

describe('searchGraph', () => {
  it('is off with neither a query nor a filter', () => {
    expect(searchGraph(model.nodes, '', DEFAULT_FILTERS, NOW)).toBeNull();
    expect(searchGraph(model.nodes, '   ', DEFAULT_FILTERS, NOW)).toBeNull();
  });

  it('ranks an exact title, then a title start, then a word, then anywhere in a title', () => {
    expect(search('plan').slice(0, 4)).toEqual(['Lumen/Plan.md', 'Kora/Plan de corte.md', 'Lumen/Planes de ejecución.md', 'Kora/decisiones/Replanificación.md']);
  });

  it('ignores accents and case', () => {
    expect(search('EJECUCION')).toEqual(['Lumen/Planes de ejecución.md']);
  });

  it('needs every word, each in any field', () => {
    expect(search('kora plan')).toEqual(['Kora/Plan de corte.md', 'Kora/decisiones/Replanificación.md']);
  });

  it('ranks a title match above a match only in the project or the folders', () => {
    expect(search('decisiones')).toEqual(['Kora/decisiones/Replanificación.md']);
    expect(search('lumen', { fields: ['project'] })).toHaveLength(3);
    expect(search('ux')[0]).toBe('Lumen/Investigación UX.md');
  });

  it('only looks in the fields asked for', () => {
    expect(search('kora', { fields: ['title'] })).toEqual(['Kora/_Kora.md']);
    expect(search('ux', { fields: ['tags'] })).toEqual(['Lumen/Investigación UX.md', 'Lumen/Plan.md']);
  });

  it('filters alone find every node that passes, most recently edited first', () => {
    expect(search('', { edited: 'week' })).toEqual(['Kora/Plan de corte.md']);
    expect(search('', { edited: 'month' })).toEqual(['Kora/Plan de corte.md', 'Lumen/Planes de ejecución.md']);
  });

  it('filters by kind, project and tag', () => {
    expect(search('', { kinds: ['index'] })).toEqual(['Kora/_Kora.md']);
    expect(search('plan', { projects: ['folder:|Lumen'] })).toEqual(['Lumen/Plan.md', 'Lumen/Planes de ejecución.md']);
    expect(search('', { tags: ['#ux'] }).sort()).toEqual(['Lumen/Investigación UX.md', 'Lumen/Plan.md']);
  });

  it('finds notes without links, and hubs', () => {
    expect(search('', { links: 'orphans' })).not.toContain('Kora/Plan de corte.md');
    expect(search('', { links: 'orphans' })).toContain('Diario/Suelta.md');
    expect(search('', { links: 'hubs' }, hubModel)).toEqual(['Lumen/Planes de ejecución.md']);
  });
});

describe('activeFilterCount', () => {
  it('counts what narrows, not where the query looks', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, fields: ['title'] })).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, edited: 'week', tags: ['#ux'] })).toBe(2);
  });
});

describe('matchRange', () => {
  it('finds the query in a label, accents and all', () => {
    expect(matchRange('Planes de ejecución', 'EJECUCION')).toEqual([10, 19]);
    expect(matchRange('Plan de corte', 'kora plan')).toEqual([0, 4]);
    expect(matchRange('Plan', '')).toBeNull();
  });
});

describe('options', () => {
  it('lists projects and tags by how many notes they have', () => {
    expect(projectOptions(model.nodes).map((o) => [o.label, o.count])).toEqual([
      ['Kora', 3],
      ['Lumen', 3],
      ['Diario', 1],
    ]);
    expect(tagOptions(model.nodes)).toEqual([{ id: '#ux', label: '#ux', count: 2 }]);
  });
});
