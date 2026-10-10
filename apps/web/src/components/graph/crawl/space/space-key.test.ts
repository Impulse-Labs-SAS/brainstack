import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type AffinityInput,
  type GraphLayers,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { spaceKey } from './space-key';

const VIEWER = 'me';
const FRIEND = 'friend';

function note(owner: string, path: string, project: string, extra: Partial<InputNode> = {}) {
  return {
    id: `${owner}/${path}`,
    path,
    title: path.replace(/\.md$/, ''),
    ownerId: owner,
    project: { id: `folder:${owner}|${project}`, label: project },
    createdAt: 1_000 + path.length,
    updatedAt: 5_000,
    ...extra,
  } satisfies InputNode;
}

/** Two projects of your own under an index, and a friend's shared folder linked into one. */
function input(): { nodes: InputNode[]; edges: InputEdge[]; affinity: AffinityInput } {
  const nodes = [
    note(VIEWER, 'Orbit/_Orbit.md', 'Orbit'),
    note(VIEWER, 'Orbit/launch.md', 'Orbit'),
    note(VIEWER, 'Orbit/crew.md', 'Orbit'),
    note(VIEWER, 'Orbit/fuel.md', 'Orbit'),
    note(VIEWER, 'Atlas/maps.md', 'Atlas'),
    note(VIEWER, 'Atlas/roads.md', 'Atlas'),
    note(VIEWER, 'Atlas/rivers.md', 'Atlas'),
    note(FRIEND, 'Ledger/accounts.md', 'Ledger'),
    note(FRIEND, 'Ledger/audit.md', 'Ledger'),
  ];
  const link = (a: InputNode, b: InputNode, weight = 1): InputEdge => ({
    source: a.id,
    target: b.id,
    weight,
  });
  const [index, launch, crew, fuel, maps, roads, rivers, accounts, audit] = nodes as [
    InputNode,
    InputNode,
    InputNode,
    InputNode,
    InputNode,
    InputNode,
    InputNode,
    InputNode,
    InputNode,
  ];
  const edges = [
    link(index, launch),
    link(index, crew),
    link(index, fuel),
    link(launch, crew),
    link(crew, fuel),
    link(maps, roads),
    link(roads, rivers),
    link(launch, maps),
    link(accounts, audit),
    link(audit, fuel),
  ];
  const affinity: AffinityInput = {
    topics: [
      { id: 't1', kind: 'tag', key: null, label: 'travel', notes: [maps.id, rivers.id], weight: 1 },
    ],
    edges: [{ source: maps.id, target: rivers.id, weight: 0.5, shared: ['#travel'] }],
  };
  return { nodes, edges, affinity };
}

function model(data = input(), layers: Partial<GraphLayers> = {}): GraphModel {
  return buildGraphModel({
    nodes: data.nodes,
    edges: data.edges,
    affinity: data.affinity,
    layers: { ...DEFAULT_LAYERS, ...layers },
    viewerId: VIEWER,
    vaultNames: new Map([[FRIEND, { label: 'Ledger', owner: 'Friend' }]]),
    cache: new Map(),
  });
}

/** The fixture with `edit` applied to one copy of its input. */
function edited(edit: (d: ReturnType<typeof input>) => void): GraphModel {
  const d = input();
  edit(d);
  return model(d);
}

const byPath = (d: ReturnType<typeof input>, path: string) => d.nodes.find((n) => n.path === path)!;

describe('spaceKey', () => {
  const base = spaceKey(model());

  it('is the same for the same inputs built twice, and counts notes and threads', () => {
    expect(spaceKey(model())).toBe(base);
    expect(base.startsWith('9:10:')).toBe(true);
  });

  it('ignores what the cluster never reads: titles, edit dates, link weights, decisions', () => {
    expect(spaceKey(edited((d) => (byPath(d, 'Orbit/launch.md').title = 'Lift-off')))).toBe(base);
    expect(spaceKey(edited((d) => (byPath(d, 'Atlas/maps.md').updatedAt = 9_999)))).toBe(base);
    expect(spaceKey(edited((d) => (d.edges[0]!.weight = 7)))).toBe(base);
    expect(spaceKey(edited((d) => (byPath(d, 'Orbit/fuel.md').isDecision = true)))).toBe(base);
  });

  it('ignores the layers the cluster does not walk: affinity and topics', () => {
    expect(spaceKey(model(input(), { affinity: false }))).toBe(base);
    expect(spaceKey(model(input(), { topics: true }))).toBe(base);
  });

  it('changes when the notes it lays out change: indexes off, a vault hidden, a note moved', () => {
    expect(spaceKey(model(input(), { indexes: false }))).not.toBe(base);
    expect(spaceKey(model(input(), { hiddenVaults: [FRIEND] }))).not.toBe(base);
    expect(
      spaceKey(
        edited((d) => {
          const n = byPath(d, 'Atlas/rivers.md');
          n.path = 'Atlas/water/rivers.md';
        }),
      ),
    ).not.toBe(base);
    expect(
      spaceKey(edited((d) => (byPath(d, 'Atlas/roads.md').project = { id: 'x', label: 'Erebor' }))),
    ).not.toBe(base);
  });

  it('changes when a link is added or one goes', () => {
    const added = edited((d) =>
      d.edges.push({
        source: byPath(d, 'Atlas/rivers.md').id,
        target: byPath(d, 'Orbit/crew.md').id,
        weight: 1,
      }),
    );
    expect(spaceKey(added)).not.toBe(base);
    expect(spaceKey(added).startsWith('9:11:')).toBe(true);
    expect(spaceKey(edited((d) => d.edges.pop()))).not.toBe(base);
  });
});
