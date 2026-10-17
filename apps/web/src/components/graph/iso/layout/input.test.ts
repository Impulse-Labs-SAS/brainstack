import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, OWN_VAULT, buildGraphModel, type InputNode } from '@/lib/graph-model';

import { layoutInput } from './input';

const VIEWER = 'me';

function note(owner: string, path: string, createdAt = 1_000): InputNode {
  const project = path.split('/')[0]!;
  return {
    id: `${owner}/${path}`,
    path,
    title: path.slice(path.lastIndexOf('/') + 1, -3),
    ownerId: owner,
    project: { id: `folder:${owner}|${project}`, label: project },
    createdAt,
    updatedAt: createdAt,
  };
}

// Your vault, one shared with you on show and one hidden; topics drawn as nodes.
const model = buildGraphModel({
  nodes: [
    note(VIEWER, 'Orbit/_Orbit.md', 100),
    note(VIEWER, 'Orbit/Ledger/plan.md', 200),
    note(VIEWER, 'Orbit/brief.md', 300),
    note('arwen', 'Rivendell/council.md', 400),
    note('thorin', 'Erebor/hoard.md', 500),
  ],
  edges: [],
  affinity: {
    topics: [
      {
        id: 't1',
        kind: 'tag',
        key: null,
        label: 'maps',
        notes: ['me/Orbit/brief.md', 'me/Orbit/Ledger/plan.md'],
        weight: 1,
      },
    ],
    edges: [],
  },
  layers: { ...DEFAULT_LAYERS, topics: true, hiddenVaults: ['thorin'] },
  viewerId: VIEWER,
  vaultNames: new Map([
    ['arwen', { label: 'Rivendell', owner: 'Arwen' }],
    ['thorin', { label: 'Erebor', owner: 'Thorin' }],
  ]),
  cache: new Map(),
});

describe('layoutInput', () => {
  it('takes the notes filed in a project, as plain data', () => {
    const { notes } = layoutInput(model);
    // The topic node has no project and is left out; the hidden vault's note is not in the model.
    expect(model.nodes.some((n) => n.kind === 'topic')).toBe(true);
    expect(notes.map((n) => n.id).sort()).toEqual([
      'arwen/Rivendell/council.md',
      'me/Orbit/Ledger/plan.md',
      'me/Orbit/_Orbit.md',
      'me/Orbit/brief.md',
    ]);
    expect(notes.find((n) => n.id === 'me/Orbit/_Orbit.md')).toEqual({
      id: 'me/Orbit/_Orbit.md',
      path: 'Orbit/_Orbit.md',
      project: 'folder:me|Orbit',
      projectLabel: 'Orbit',
      vault: OWN_VAULT,
      isIndex: true,
      createdAt: 100,
    });
    expect(notes.find((n) => n.id === 'arwen/Rivendell/council.md')).toMatchObject({
      vault: 'arwen',
      isIndex: false,
    });
    // Nothing but the fields the layout reads: it is structured-cloned into a worker.
    for (const n of notes) expect(structuredClone(n)).toEqual(n);
  });

  it('takes the vaults on show, yours first, and says which are shared', () => {
    expect(layoutInput(model).vaults).toEqual([
      { id: OWN_VAULT, label: 'Your vault', shared: false },
      { id: 'arwen', label: 'Rivendell', shared: true },
    ]);
  });
});
