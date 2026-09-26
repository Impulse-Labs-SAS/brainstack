import { describe, expect, it } from 'vitest';

import {
  buildGraphModel,
  projectNodeId,
  summariseProjects,
  type AffinityInput,
  type GraphMode,
  type InputNode,
} from './graph-model';

const mine = () => false;
const note = (path: string, project = path.split('/')[0]!): InputNode => ({
  id: path,
  path,
  title: path,
  ownerId: null,
  project: { id: `folder:|${project}`, label: project },
});

const nodes = [
  note('Atlas/_Atlas.md'),
  note('Atlas/lector.md'),
  note('Nimbus/clasificador.md'),
  note('Nimbus/arquitectura.md'),
];
const edges = [
  { source: 'Atlas/_Atlas.md', target: 'Atlas/lector.md', weight: 1 },
  { source: 'Nimbus/arquitectura.md', target: 'Nimbus/clasificador.md', weight: 1 },
];
const affinity: AffinityInput = {
  topics: [
    {
      id: 'facet:technologies:gemini-api',
      kind: 'facet',
      key: 'technologies',
      label: 'gemini-api',
      notes: ['Atlas/lector.md', 'Nimbus/clasificador.md'],
      weight: 0.5,
    },
    {
      id: 'tag:solo',
      kind: 'tag',
      key: null,
      label: 'solo',
      notes: ['Atlas/lector.md', 'Otra/oculta.md'],
      weight: 0.5,
    },
  ],
  edges: [
    {
      source: 'Atlas/lector.md',
      target: 'Nimbus/clasificador.md',
      weight: 0.5,
      shared: ['gemini-api'],
    },
    {
      source: 'Nimbus/arquitectura.md',
      target: 'Nimbus/clasificador.md',
      weight: 0.3,
      shared: ['postgres'],
    },
  ],
};

function build(mode: GraphMode, showIndexes = true, input = { nodes, edges }) {
  return buildGraphModel({ ...input, affinity, mode, showIndexes, isForeign: mine });
}

describe('buildGraphModel', () => {
  it('tells index links from content links', () => {
    const { counts } = build('links');
    expect(counts).toMatchObject({ links: 1, structure: 1, affinity: 0, topics: 0 });
  });

  it('draws no affinity outside the affinity view', () => {
    expect(build('links').simEdges.some((e) => e.kind === 'affinity')).toBe(false);
    expect(build('topics').simEdges.some((e) => e.kind === 'affinity')).toBe(false);
  });

  it('adds a dashed edge between notes that share a topic but are not linked', () => {
    const model = build('affinity');
    const affinityEdges = model.simEdges.filter((e) => e.kind === 'affinity');
    expect(affinityEdges.map((e) => [e.source.id, e.target.id])).toEqual([
      ['Atlas/lector.md', 'Nimbus/clasificador.md'],
    ]);
    expect(affinityEdges[0]!.shared).toEqual(['gemini-api']);
  });

  it('skips the dashed edge when the pair is already linked, but keeps it for the hover card', () => {
    const model = build('affinity');
    const between = model.simEdges.filter(
      (e) =>
        [e.source.id, e.target.id].sort().join() ===
        ['Nimbus/arquitectura.md', 'Nimbus/clasificador.md'].join(),
    );
    expect(between.map((e) => e.kind)).toEqual(['link']);
    expect(model.related.get('Nimbus/arquitectura.md')).toEqual([
      { id: 'Nimbus/clasificador.md', title: 'Nimbus/clasificador.md', shared: ['postgres'], links: 0 },
    ]);
  });

  it('does not let affinity grow a node', () => {
    const size = (mode: GraphMode) => build(mode).simNodes.find((n) => n.id === 'Atlas/lector.md')!.size;
    expect(size('affinity')).toBe(size('links'));
  });

  it('adds a topic node joined to each visible carrier, skipping topics with one', () => {
    const model = build('topics');
    const topics = model.simNodes.filter((n) => n.kind === 'topic');
    expect(topics.map((t) => t.id)).toEqual(['topic:facet:technologies:gemini-api']);
    expect(topics[0]!.path).toBe('technologies: gemini-api');
    const spokes = model.simEdges.filter((e) => e.kind === 'topic');
    expect(spokes.map((e) => e.source.id).sort()).toEqual(['Atlas/lector.md', 'Nimbus/clasificador.md']);
  });

  it('hides indexes and their links when asked', () => {
    const model = build('links', false);
    expect(model.simNodes.some((n) => n.isIndex)).toBe(false);
    expect(model.counts.structure).toBe(0);
  });
});

describe('the projects view', () => {
  it('draws one node per project, sized by its notes', () => {
    const model = build('projects');
    expect(model.simNodes.map((n) => [n.title, n.size])).toEqual([
      ['Atlas', 2],
      ['Nimbus', 2],
    ]);
    expect(model.counts.projects).toBe(2);
  });

  it('joins two projects with a dashed edge when only a topic connects them', () => {
    const model = build('projects');
    expect(model.simEdges.map((e) => [e.kind, e.shared])).toEqual([['affinity', ['gemini-api']]]);
  });

  it('turns a link between notes of two projects into a solid edge, and folds links inside one', () => {
    const model = build('projects', true, {
      nodes,
      edges: [...edges, { source: 'Atlas/lector.md', target: 'Nimbus/arquitectura.md', weight: 2 }],
    });
    expect(model.simEdges.map((e) => [e.kind, e.weight])).toEqual([['link', 2]]);
    expect(model.related.get(projectNodeId('folder:|Atlas'))).toEqual([
      { id: projectNodeId('folder:|Nimbus'), title: 'Nimbus', shared: ['gemini-api'], links: 2 },
    ]);
  });
});

describe('summariseProjects', () => {
  it('counts notes per project, largest first', () => {
    expect(summariseProjects([...nodes, note('Nimbus/extra.md')])).toEqual([
      { id: 'folder:|Nimbus', label: 'Nimbus', count: 3 },
      { id: 'folder:|Atlas', label: 'Atlas', count: 2 },
    ]);
  });
});
