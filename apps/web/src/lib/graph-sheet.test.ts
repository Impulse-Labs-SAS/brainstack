import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type AffinityInput,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from './graph-model';
import { connectionGroups, crumbsOf } from './graph-sheet';

const VIEWER = 'me';
const note = (path: string, project: string): InputNode => ({
  id: path,
  path,
  title: path.slice(path.lastIndexOf('/') + 1, -3),
  ownerId: VIEWER,
  project: { id: `folder:|${project}`, label: project },
  createdAt: 1_000,
  updatedAt: 2_000,
});

// An invented vault: Atlas, filed under its own folder with an index and two levels below it,
// and Orbit beside it.
const nodes = [
  note('Atlas/_Atlas.md', 'Atlas'),
  note('Atlas/Design/brief.md', 'Atlas'),
  note('Atlas/Design/Specs/api.md', 'Atlas'),
  note('Atlas/Design/Specs/schema.md', 'Atlas'),
  note('Atlas/Ops/runbook.md', 'Atlas'),
  note('Orbit/plan.md', 'Orbit'),
];
const edges: InputEdge[] = [
  { source: 'Atlas/_Atlas.md', target: 'Atlas/Design/brief.md', weight: 1 },
  { source: 'Atlas/Design/brief.md', target: 'Atlas/Design/Specs/api.md', weight: 1 },
  { source: 'Atlas/Design/brief.md', target: 'Orbit/plan.md', weight: 1 },
  { source: 'Atlas/Ops/runbook.md', target: 'Atlas/Design/brief.md', weight: 1 },
];
const affinity: AffinityInput = {
  topics: [
    {
      id: 'tag:launch',
      kind: 'tag',
      key: null,
      label: 'launch',
      notes: ['Atlas/Design/brief.md', 'Orbit/plan.md'],
      weight: 0.5,
    },
  ],
  edges: [
    {
      source: 'Atlas/Design/brief.md',
      target: 'Atlas/Design/Specs/schema.md',
      weight: 0.4,
      shared: ['postgres'],
    },
  ],
};

function build(
  input: { nodes?: InputNode[]; edges?: InputEdge[]; indexes?: boolean } = {},
): GraphModel {
  return buildGraphModel({
    nodes: input.nodes ?? nodes,
    edges: input.edges ?? edges,
    affinity,
    layers: { ...DEFAULT_LAYERS, topics: true, indexes: input.indexes ?? true },
    viewerId: VIEWER,
    vaultNames: new Map(),
    cache: new Map(),
  });
}
const byPath = (model: GraphModel, path: string) => model.nodes.find((n) => n.path === path)!;
const paths = (notes: { path: string }[]) => notes.map((n) => n.path).sort();

describe('crumbsOf', () => {
  it('steps up from a note through the folders under its project to the project and the vault', () => {
    const model = build();
    const crumbs = crumbsOf(model, byPath(model, 'Atlas/Design/Specs/api.md'));
    expect(crumbs.map((c) => [c.kind, c.label])).toEqual([
      ['vault', model.vaults[0]!.label],
      ['project', 'Atlas'],
      ['folder', 'Design'],
      ['folder', 'Specs'],
    ]);
  });

  it('gives each step the notes under it', () => {
    const model = build();
    const [vault, project, design, specs] = crumbsOf(
      model,
      byPath(model, 'Atlas/Design/Specs/api.md'),
    );
    expect(paths(vault!.notes)).toEqual(paths(nodes));
    expect(paths(project!.notes)).toEqual(paths(nodes.filter((n) => n.path.startsWith('Atlas/'))));
    expect(paths(design!.notes)).toEqual([
      'Atlas/Design/Specs/api.md',
      'Atlas/Design/Specs/schema.md',
      'Atlas/Design/brief.md',
    ]);
    expect(paths(specs!.notes)).toEqual([
      'Atlas/Design/Specs/api.md',
      'Atlas/Design/Specs/schema.md',
    ]);
  });

  it('has no folder step for a note filed in its project’s own folder', () => {
    const model = build();
    expect(crumbsOf(model, byPath(model, 'Atlas/_Atlas.md')).map((c) => c.kind)).toEqual([
      'vault',
      'project',
    ]);
    // A project of one note: its folder is the project's own.
    expect(crumbsOf(model, byPath(model, 'Orbit/plan.md')).map((c) => c.kind)).toEqual([
      'vault',
      'project',
    ]);
  });

  it('takes the project’s folder from the project, whichever of its notes a layer hides', () => {
    // With the index hidden, what the notes left share is Atlas/Design: the project is Atlas.
    const model = build({
      nodes: [
        note('Atlas/_Atlas.md', 'Atlas'),
        note('Atlas/Design/a.md', 'Atlas'),
        note('Atlas/Design/b.md', 'Atlas'),
      ],
      edges: [],
      indexes: false,
    });
    expect(crumbsOf(model, byPath(model, 'Atlas/Design/a.md')).map((c) => c.label)).toEqual([
      model.vaults[0]!.label,
      'Atlas',
      'Design',
    ]);
  });

  it('steps through a tag project’s folders from what its notes share', () => {
    const tagged = (path: string): InputNode => ({
      ...note(path, 'Launch'),
      project: { id: 'tag:|project/launch', label: 'Launch' },
    });
    const model = build({
      nodes: [tagged('Atlas/Design/x.md'), tagged('Atlas/Ops/y.md')],
      edges: [],
    });
    const crumbs = crumbsOf(model, byPath(model, 'Atlas/Design/x.md'));
    expect(crumbs.map((c) => c.label)).toEqual([model.vaults[0]!.label, 'Launch', 'Design']);
    expect(paths(crumbs[2]!.notes)).toEqual(['Atlas/Design/x.md']);
  });

  it('gives a topic its vault alone', () => {
    const model = build();
    const topic = model.nodes.find((n) => n.kind === 'topic')!;
    expect(crumbsOf(model, topic).map((c) => c.kind)).toEqual(['vault']);
  });
});

describe('connectionGroups', () => {
  it('groups the links a note makes, the links to it, its indexes, topics and shared topics', () => {
    const model = build();
    const groups = connectionGroups(model, byPath(model, 'Atlas/Design/brief.md'));
    expect(groups.map((g) => [g.label, paths(g.items.map((i) => i.node))])).toEqual([
      ['Links to', ['Atlas/Design/Specs/api.md', 'Orbit/plan.md']],
      ['Linked from', ['Atlas/Ops/runbook.md']],
      ['Indexes', ['Atlas/_Atlas.md']],
      ['Topics', [model.nodes.find((n) => n.kind === 'topic')!.path]],
      ['Shared topics', ['Atlas/Design/Specs/schema.md']],
    ]);
  });

  it('lists a note linked both ways under the links it makes and the links to it', () => {
    const model = build({
      edges: [...edges, { source: 'Orbit/plan.md', target: 'Atlas/Design/brief.md', weight: 1 }],
    });
    const brief = connectionGroups(model, byPath(model, 'Atlas/Design/brief.md'));
    const plan = connectionGroups(model, byPath(model, 'Orbit/plan.md'));
    const linked = (groups: typeof brief) =>
      groups
        .filter((g) => g.key === 'out' || g.key === 'in')
        .map((g) => [g.label, paths(g.items.map((i) => i.node))]);
    expect(linked(brief)).toEqual([
      ['Links to', ['Atlas/Design/Specs/api.md', 'Orbit/plan.md']],
      ['Linked from', ['Atlas/Ops/runbook.md', 'Orbit/plan.md']],
    ]);
    expect(linked(plan)).toEqual([
      ['Links to', ['Atlas/Design/brief.md']],
      ['Linked from', ['Atlas/Design/brief.md']],
    ]);
  });

  it('has an index list the indexes in the folders below it, whichever way they link', () => {
    const model = build({
      nodes: [
        note('Atlas/_Atlas.md', 'Atlas'),
        note('Atlas/Design/_Design.md', 'Atlas'),
        note('Atlas/Design/brief.md', 'Atlas'),
      ],
      edges: [
        { source: 'Atlas/Design/_Design.md', target: 'Atlas/_Atlas.md', weight: 1 },
        { source: 'Atlas/Design/_Design.md', target: 'Atlas/Design/brief.md', weight: 1 },
      ],
    });
    const groups = (path: string) =>
      connectionGroups(model, byPath(model, path)).map((g) => [
        g.label,
        paths(g.items.map((i) => i.node)),
      ]);
    expect(groups('Atlas/_Atlas.md')).toEqual([['Listed here', ['Atlas/Design/_Design.md']]]);
    expect(groups('Atlas/Design/_Design.md')).toEqual([
      ['Indexes', ['Atlas/_Atlas.md']],
      ['Listed here', ['Atlas/Design/brief.md']],
    ]);
  });

  it('puts the best-connected first in each group', () => {
    // The hub links to three: b is linked by two others, c by one, a by none.
    const model = build({
      nodes: ['hub', 'a', 'b', 'c', 'x', 'y'].map((n) => note(`Orbit/${n}.md`, 'Orbit')),
      edges: [
        { source: 'Orbit/hub.md', target: 'Orbit/a.md', weight: 1 },
        { source: 'Orbit/hub.md', target: 'Orbit/b.md', weight: 1 },
        { source: 'Orbit/hub.md', target: 'Orbit/c.md', weight: 1 },
        { source: 'Orbit/x.md', target: 'Orbit/b.md', weight: 1 },
        { source: 'Orbit/y.md', target: 'Orbit/b.md', weight: 1 },
        { source: 'Orbit/x.md', target: 'Orbit/c.md', weight: 1 },
      ],
    });
    const [out] = connectionGroups(model, byPath(model, 'Orbit/hub.md'));
    expect(out!.items.map((i) => i.node.path)).toEqual(['Orbit/b.md', 'Orbit/c.md', 'Orbit/a.md']);
  });

  it('lists what an index lists, and a topic’s notes', () => {
    const model = build();
    const index = connectionGroups(model, byPath(model, 'Atlas/_Atlas.md'));
    expect(index.map((g) => [g.label, paths(g.items.map((i) => i.node))])).toEqual([
      ['Listed here', ['Atlas/Design/brief.md']],
    ]);
    const topic = model.nodes.find((n) => n.kind === 'topic')!;
    expect(connectionGroups(model, topic).map((g) => [g.label, g.items.length])).toEqual([
      ['Notes', 2],
    ]);
  });

  it('keeps the connections whose title holds the filter, accents and case aside', () => {
    const model = build();
    const brief = byPath(model, 'Atlas/Design/brief.md');
    const plan = byPath(model, 'Orbit/plan.md');
    plan.label = 'Plán de lanzamiento';
    const groups = connectionGroups(model, brief, '  PLAN ');
    expect(groups.map((g) => [g.label, g.items.map((i) => i.node)])).toEqual([
      ['Links to', [plan]],
    ]);
    expect(connectionGroups(model, brief, 'nothing like it')).toEqual([]);
  });
});
