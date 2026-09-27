import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  OWN_VAULT,
  activity,
  buildGraphModel,
  colorOf,
  findPath,
  hopsFrom,
  neighbourToward,
  noteHref,
  sharedVaultNames,
  shortLabel,
  summariseVaults,
  type AffinityInput,
  type GraphLayers,
  type GraphNode,
  type InputEdge,
  type InputNode,
} from './graph-model';
import { OTHER_VAULT_COLOR, OWN_VAULT_COLOR, SHARED_VAULT_COLORS } from './graph-palette';

const VIEWER = 'me';
const note = (path: string, extra: Partial<InputNode> = {}): InputNode => {
  const project = path.split('/')[0]!;
  return {
    id: path,
    path,
    title: path,
    ownerId: VIEWER,
    project: { id: `folder:|${project}`, label: project },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...extra,
  };
};

const nodes = [note('Atlas/_Atlas.md'), note('Atlas/lector.md'), note('Nimbus/clasificador.md'), note('Nimbus/arquitectura.md')];
const edges: InputEdge[] = [
  { source: 'Atlas/_Atlas.md', target: 'Atlas/lector.md', weight: 1 },
  { source: 'Nimbus/arquitectura.md', target: 'Nimbus/clasificador.md', weight: 1 },
];
const affinity: AffinityInput = {
  topics: [
    { id: 'facet:technologies:gemini-api', kind: 'facet', key: 'technologies', label: 'gemini-api', notes: ['Atlas/lector.md', 'Nimbus/clasificador.md'], weight: 0.5 },
    { id: 'tag:solo', kind: 'tag', key: null, label: 'solo', notes: ['Atlas/lector.md', 'Otra/oculta.md'], weight: 0.5 },
  ],
  edges: [
    { source: 'Atlas/lector.md', target: 'Nimbus/clasificador.md', weight: 0.5, shared: ['gemini-api'] },
    { source: 'Nimbus/arquitectura.md', target: 'Nimbus/clasificador.md', weight: 0.3, shared: ['postgres'] },
  ],
};

function build(layers: Partial<GraphLayers> = {}, input: { nodes?: InputNode[]; edges?: InputEdge[]; cache?: Map<string, GraphNode> } = {}) {
  return buildGraphModel({
    nodes: input.nodes ?? nodes,
    edges: input.edges ?? edges,
    affinity,
    layers: { ...DEFAULT_LAYERS, ...layers },
    viewerId: VIEWER,
    vaultNames: new Map([['ana', { label: 'Research', owner: 'Ana' }], ['bruno', { label: 'Atlas', owner: 'Bruno' }]]),
    cache: input.cache ?? new Map(),
  });
}
const kinds = (model: ReturnType<typeof build>) => model.edges.map((e) => e.kind).sort();
const byId = (model: ReturnType<typeof build>, id: string) => model.nodes.find((n) => n.id === id)!;

describe('buildGraphModel', () => {
  it('tells index links from content links', () => {
    expect(kinds(build({ affinity: false }))).toEqual(['link', 'structure']);
  });

  it('adds a shared-topic edge between notes nobody linked, only while that layer is on', () => {
    const on = build().edges.filter((e) => e.kind === 'affinity');
    expect(on.map((e) => [e.source.id, e.target.id, e.shared])).toEqual([['Atlas/lector.md', 'Nimbus/clasificador.md', ['gemini-api']]]);
    expect(build({ affinity: false }).edges.some((e) => e.kind === 'affinity')).toBe(false);
  });

  it('skips the shared-topic edge when the pair is already linked', () => {
    const between = build().edges.filter((e) => [e.source.id, e.target.id].sort().join() === 'Nimbus/arquitectura.md,Nimbus/clasificador.md');
    expect(between.map((e) => e.kind)).toEqual(['link']);
  });

  it('does not let a shared topic grow a node', () => {
    expect(byId(build(), 'Atlas/lector.md').size).toBe(byId(build({ affinity: false }), 'Atlas/lector.md').size);
  });

  it('hides indexes and their links when the layer is off', () => {
    const model = build({ indexes: false });
    expect(model.nodes.some((n) => n.isIndex)).toBe(false);
    expect(model.edges.some((e) => e.kind === 'structure')).toBe(false);
  });

  it('adds a topic node joined to each visible carrier, skipping topics only one visible note carries', () => {
    const model = build({ topics: true });
    const topics = model.nodes.filter((n) => n.kind === 'topic');
    expect(topics.map((t) => [t.id, t.label, t.carriers])).toEqual([['topic:facet:technologies:gemini-api', 'technologies: gemini-api', 2]]);
    const spokes = model.edges.filter((e) => e.kind === 'topic');
    expect(spokes.map((e) => e.source.id).sort()).toEqual(['Atlas/lector.md', 'Nimbus/clasificador.md']);
    expect(topics[0]!.project).toBeNull();
  });

  it('lists the topics each note carries, for the preview', () => {
    expect(byId(build(), 'Atlas/lector.md').topics).toEqual(['technologies: gemini-api', '#solo']);
  });

  it('keeps node objects, and their positions, across rebuilds', () => {
    const cache = new Map<string, GraphNode>();
    const first = byId(build({}, { cache }), 'Atlas/lector.md');
    first.x = 42;
    const second = byId(build({ affinity: false }, { cache }), 'Atlas/lector.md');
    expect(second).toBe(first);
    expect(second.x).toBe(42);
  });

  it('groups notes by project', () => {
    const model = build();
    expect(model.projects.map((p) => [p.label, p.nodes.length]).sort()).toEqual([
      ['Atlas', 2],
      ['Nimbus', 2],
    ]);
  });
});

describe('vaults', () => {
  const shared = [...nodes, note('Zuno/arquitectura.md', { ownerId: 'ana' }), note('Zuno/pricing.md', { ownerId: 'ana' }), note('Brutus/ux.md', { ownerId: 'bruno' })];

  it('puts your notes in your vault and each owner in theirs, with a ring for others', () => {
    const model = build({}, { nodes: shared });
    expect(byId(model, 'Atlas/lector.md')).toMatchObject({ vault: OWN_VAULT, foreign: false });
    expect(byId(model, 'Zuno/pricing.md')).toMatchObject({ vault: 'ana', foreign: true });
  });

  it('treats a note without an owner (self-host) as yours', () => {
    const model = build({}, { nodes: [note('Solo/a.md', { ownerId: null })] });
    expect(model.nodes[0]!.vault).toBe(OWN_VAULT);
  });

  it('drops hidden vaults from the model but keeps them listed, with their size', () => {
    const model = build({ hiddenVaults: ['ana'] }, { nodes: shared });
    expect(model.nodes.some((n) => n.vault === 'ana')).toBe(false);
    expect(model.vaults.find((v) => v.id === 'ana')).toMatchObject({ hidden: true, total: 2, label: 'Research', owner: 'Ana' });
  });

  it('lists your vault first and colours shared vaults by owner, so a colour survives hiding another vault', () => {
    const vaults = summariseVaults(shared, VIEWER, new Map([['ana', { label: 'Research', owner: 'Ana' }], ['bruno', { label: 'Atlas', owner: 'Bruno' }]]), []);
    expect(vaults.map((v) => [v.id, v.color])).toEqual([
      [OWN_VAULT, OWN_VAULT_COLOR],
      ['ana', SHARED_VAULT_COLORS[0]],
      ['bruno', SHARED_VAULT_COLORS[1]],
    ]);
    const without = summariseVaults(shared, VIEWER, new Map([['ana', { label: 'Research', owner: 'Ana' }], ['bruno', { label: 'Atlas', owner: 'Bruno' }]]), ['ana']);
    expect(without.find((v) => v.id === 'bruno')!.color).toBe(SHARED_VAULT_COLORS[1]);
  });

  it('names a shared vault after the folders shared, with the person beside them', () => {
    const root = (ownerId: string, folderPath: string, ownerDisplayName: string | null = null) => ({
      ownerId,
      folderPath,
      ownerDisplayName,
      ownerEmail: `${ownerId}.smith@example.com`,
    });
    const names = sharedVaultNames([root('fede', 'Kora'), root('fede', 'Brutus/App'), root('ana', 'Research', 'Ana')]);
    expect(names.get('fede')).toEqual({ label: 'App, Kora', owner: 'fede.smith' });
    expect(names.get('ana')).toEqual({ label: 'Research', owner: 'Ana' });
  });

  it('falls back to a neutral once the palette runs out', () => {
    const many = Array.from({ length: 7 }, (_, i) => note(`P${i}/n.md`, { ownerId: `owner${i}` }));
    const vaults = summariseVaults(many, VIEWER, new Map(), []);
    expect(vaults.at(-1)!.color).toBe(OTHER_VAULT_COLOR);
    expect(colorOf({ vaults }, { kind: 'note', vault: 'owner0' })).toBe(SHARED_VAULT_COLORS[0]);
  });
});

describe('shortLabel', () => {
  it('drops a trailing project name the position already says', () => {
    expect(shortLabel('Arquitectura y stack técnico — Gestor de Trámites FI', 'Gestor de Trámites FI')).toBe('Arquitectura y stack técnico');
    expect(shortLabel('Modelo de datos - Billing Service', 'billing service')).toBe('Modelo de datos');
  });

  it('keeps a dash that is part of the title', () => {
    expect(shortLabel('Qué hace el bot — flujos automatizados', 'Asistente sudocu-bot')).toBe('Qué hace el bot — flujos automatizados');
    expect(shortLabel('Isotipo — ronda 1', 'Marca Impulse')).toBe('Isotipo — ronda 1');
  });
});

describe('activity', () => {
  const day = 86_400_000;
  it('lights this week fully and fades older edits to an ember', () => {
    const now = 100 * day;
    expect(activity(now - 2 * day, now)).toBe(1);
    expect(activity(now - 20 * day, now)).toBeLessThan(1);
    expect(activity(now - 90 * day, now)).toBeLessThan(activity(now - 20 * day, now));
    expect(activity(0, now)).toBeGreaterThan(0);
  });
});

describe('hops and paths', () => {
  const chain = [note('A/a.md'), note('A/b.md'), note('A/c.md'), note('A/d.md'), note('B/x.md')];
  const chainEdges: InputEdge[] = [
    { source: 'A/a.md', target: 'A/b.md', weight: 1 },
    { source: 'A/b.md', target: 'A/c.md', weight: 1 },
    { source: 'A/c.md', target: 'A/d.md', weight: 1 },
  ];

  it('finds everything within two hops, with its distance', () => {
    const model = build({}, { nodes: chain, edges: chainEdges });
    const hops = hopsFrom(model, byId(model, 'A/a.md'));
    expect([...hops].map(([n, h]) => [n.id, h])).toEqual([
      ['A/a.md', 0],
      ['A/b.md', 1],
      ['A/c.md', 2],
    ]);
  });

  it('traces the shortest path through links', () => {
    const model = build({}, { nodes: chain, edges: chainEdges });
    const path = findPath(model, byId(model, 'A/a.md'), byId(model, 'A/d.md'))!;
    expect(path.nodes.map((n) => n.id)).toEqual(['A/a.md', 'A/b.md', 'A/c.md', 'A/d.md']);
    expect(path.implicit).toBe(false);
  });

  it('prefers links, and says so when only a shared topic connects two notes', () => {
    const model = build();
    const path = findPath(model, byId(model, 'Atlas/lector.md'), byId(model, 'Nimbus/arquitectura.md'))!;
    expect(path.nodes.map((n) => n.id)).toEqual(['Atlas/lector.md', 'Nimbus/clasificador.md', 'Nimbus/arquitectura.md']);
    expect(path.implicit).toBe(true);
  });

  it('returns null between islands', () => {
    const model = build({}, { nodes: chain, edges: chainEdges });
    expect(findPath(model, byId(model, 'A/a.md'), byId(model, 'B/x.md'))).toBeNull();
  });
});

describe('neighbourToward', () => {
  // b links to a (left), c (right, slightly up) and d (straight up).
  const star = [note('S/a.md'), note('S/b.md'), note('S/c.md'), note('S/d.md')];
  const starEdges: InputEdge[] = ['S/a.md', 'S/c.md', 'S/d.md'].map((t) => ({ source: 'S/b.md', target: t, weight: 1 }));
  const placed = () => {
    const model = build({}, { nodes: star, edges: starEdges });
    const at: Record<string, [number, number]> = { 'S/a.md': [0, 100], 'S/b.md': [100, 100], 'S/c.md': [200, 90], 'S/d.md': [100, 0] };
    for (const n of model.nodes) Object.assign(n, { sx: at[n.id]![0], sy: at[n.id]![1], onScreen: true });
    return model;
  };

  it('picks the linked note lying in the pressed direction on screen', () => {
    const model = placed();
    const b = byId(model, 'S/b.md');
    expect(neighbourToward(model, b, 1, 0)?.id).toBe('S/c.md');
    expect(neighbourToward(model, b, -1, 0)?.id).toBe('S/a.md');
    expect(neighbourToward(model, b, 0, -1)?.id).toBe('S/d.md');
  });

  it('goes nowhere when nothing lies that way, or it is off screen', () => {
    const model = placed();
    const b = byId(model, 'S/b.md');
    expect(neighbourToward(model, b, 0, 1)).toBeNull();
    byId(model, 'S/c.md').onScreen = false;
    expect(neighbourToward(model, b, 1, 0)).toBeNull();
  });
});

describe('noteHref', () => {
  it('opens your notes by path and encodes what a URL would swallow', () => {
    expect(noteHref({ path: 'ideas/FAQ #1.md', foreign: false, ownerId: VIEWER })).toBe('/notes/ideas/FAQ%20%231');
    expect(noteHref({ path: 'x/100%.md', foreign: false, ownerId: null })).toBe('/notes/x/100%25');
  });

  it("opens somebody else's note under the shared route, with its owner", () => {
    expect(noteHref({ path: 'Zuno/Planes y pricing.md', foreign: true, ownerId: 'ana' })).toBe('/notes/shared/ana/Zuno/Planes%20y%20pricing');
  });
});
