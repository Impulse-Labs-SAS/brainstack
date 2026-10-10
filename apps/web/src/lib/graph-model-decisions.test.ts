import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type GraphNode,
  type InputNode,
} from './graph-model';

const VIEWER = 'me';

function note(path: string, extra: Partial<InputNode> = {}): InputNode {
  return {
    id: `${VIEWER}/${path}`,
    path,
    title: path,
    ownerId: VIEWER,
    project: { id: 'folder:|Orbit', label: 'Orbit' },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...extra,
  };
}

function build(nodes: InputNode[], cache = new Map<string, GraphNode>()): GraphModel {
  return buildGraphModel({
    nodes,
    edges: [],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: VIEWER,
    vaultNames: new Map(),
    cache,
  });
}

const flag = (m: GraphModel, path: string) => m.nodes.find((n) => n.path === path)?.isDecision;

describe('isDecision on the graph model', () => {
  it('carries what the server says', () => {
    const m = build([
      note('Orbit/launch.md', { isDecision: true }),
      note('Orbit/notes.md', { isDecision: false }),
    ]);
    expect(flag(m, 'Orbit/launch.md')).toBe(true);
    expect(flag(m, 'Orbit/notes.md')).toBe(false);
  });

  it('is false when the input leaves it out', () => {
    expect(flag(build([note('Orbit/launch.md')]), 'Orbit/launch.md')).toBe(false);
  });

  it('is refreshed on a rebuild over the same cache, both ways', () => {
    const cache = new Map<string, GraphNode>();
    const first = build(
      [note('Orbit/launch.md', { isDecision: true }), note('Orbit/notes.md')],
      cache,
    );
    const again = build(
      [note('Orbit/launch.md'), note('Orbit/notes.md', { isDecision: true })],
      cache,
    );
    // The same node objects, so positions survive; the flag is the new input's.
    expect(again.nodes.find((n) => n.path === 'Orbit/launch.md')).toBe(
      first.nodes.find((n) => n.path === 'Orbit/launch.md'),
    );
    expect(flag(again, 'Orbit/launch.md')).toBe(false);
    expect(flag(again, 'Orbit/notes.md')).toBe(true);
  });
});
