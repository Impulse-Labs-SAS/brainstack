// A vault made up for the crawl's tests and the Sentinel lab: seeded, so every
// run lays out the same notes, and shaped to exercise everything a replay does
// — long walks along threads, an index with structure edges, a decision, a
// cluster no thread reaches (a crossing through the void) and references the
// engine could not settle.

import { seededRandom } from '@/lib/graph-brain';
import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import type { CrawlResult } from './crawl-plan';

/** World units between neighbouring notes: about what the force layout settles a link at. */
const SPACING = 44;

const TITLES = [
  'Ingest pipeline',
  'Schema registry',
  'Retention policy',
  'Access review',
  'Billing export',
  'Search ranking',
  'Onboarding flow',
  'Error budget',
  'Release train',
  'Pricing model',
  'Data contracts',
  'Audit trail',
  'Sync engine',
  'Offline mode',
  'Rate limits',
  'Webhook retries',
  'Cache warmup',
  'Index rebuild',
  'Backfill job',
  'Feature flags',
  'Session store',
  'Token rotation',
  'Usage metering',
  'Alert routing',
  'Capacity plan',
  'Query planner',
  'Vector notes',
  'Graph layout',
  'Import wizard',
  'Export formats',
  'Team roles',
  'Invite flow',
  'Recovery codes',
  'Status page',
  'Incident review',
  'Runbook: deploy',
  'Runbook: restore',
  'Latency budget',
  'Cold start',
  'Edge cache',
  'Theme tokens',
  'Keyboard map',
  'Command palette',
  'Wikilink parser',
  'Facet index',
  'Mention scan',
  'Tag cloud',
  'Daily notes',
  'Weekly review',
  'Reading list',
  'Design critique',
  'Spike: CRDTs',
  'Spike: WASM',
  'Load test',
  'Chaos drill',
  'Cost report',
  'Vendor review',
  'Privacy notice',
  'Legal hold',
  'Changelog',
];
const ISLAND = [
  'Field notes',
  'Sketchbook',
  'Loose ideas',
  'Quotes',
  'Travel log',
  'Recipes',
  'Bookmarks',
  'Someday',
];

export interface SampleVault {
  model: GraphModel;
  /** Crawls to replay over it, from a short walk to a tour of everything. */
  crawls: {
    /** Two named notes a few threads apart, and the links out of the first. */
    walk: CrawlResult;
    /** A named note in the cluster no thread reaches: the walk crosses the void. */
    gap: CrawlResult;
    /** References the engine could not settle: one into the void, one between two candidates. */
    ask: CrawlResult;
    /** All of the above in one answer. */
    tour: CrawlResult;
  };
}

/** A 5 × 4 × 3 lattice of notes, jittered and linked to most neighbours, an index over one corner, and a linked island of eight far to the side. */
export function sampleVault(seed = 7): SampleVault {
  const rnd = seededRandom(seed);
  const nodes: InputNode[] = [];
  const edges: InputEdge[] = [];
  const positions = new Map<string, [number, number, number]>();
  const note = (path: string, title: string, project: string, p: [number, number, number]) => {
    const id = `me/${path}`;
    nodes.push({
      id,
      path,
      title,
      ownerId: 'me',
      project: { id: `me|${project}`, label: project },
      createdAt: nodes.length,
      updatedAt: nodes.length,
    });
    positions.set(id, p);
    return id;
  };
  const jitter = () => (rnd() - 0.5) * SPACING * 0.5;

  const grid = new Map<string, string>();
  let t = 0;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 5; i++) {
        const title = TITLES[t++]!;
        const id = note(`Main/${title}.md`, title, i < 3 ? 'Core' : 'Edge', [
          (i - 2) * SPACING + jitter(),
          (j - 1.5) * SPACING + jitter(),
          (k - 1) * SPACING + jitter(),
        ]);
        grid.set(`${i},${j},${k}`, id);
      }
    }
  }
  const link = (a: string, b: string) => edges.push({ source: a, target: b, weight: 1 });
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 5; i++) {
        const id = grid.get(`${i},${j},${k}`)!;
        for (const [di, dj, dk] of [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ] as const) {
          const other = grid.get(`${i + di},${j + dj},${k + dk}`);
          // Most neighbours are linked, so walks have choices but the lattice stays a lattice.
          if (other && rnd() < 0.62) link(id, other);
        }
        const diag = grid.get(`${i + 1},${j + 1},${k}`);
        if (diag && rnd() < 0.18) link(id, diag);
      }
    }
  }
  // The first and last notes are always joined to the lattice, so a walk between them exists.
  link(grid.get('0,0,0')!, grid.get('1,0,0')!);
  link(grid.get('4,3,2')!, grid.get('3,3,2')!);

  // An index over one corner: its edges are structure, walkable but drawn faint.
  const index = note('Main/_Core.md', 'Core', 'Core', [
    -2.6 * SPACING,
    -2.1 * SPACING,
    -0.4 * SPACING,
  ]);
  for (const c of ['0,0,0', '0,1,0', '1,0,0', '0,0,1']) link(index, grid.get(c)!);

  // The island: linked among itself, never to the lattice.
  const island: string[] = [];
  ISLAND.forEach((title, n) => {
    const i = n % 2;
    const j = Math.floor(n / 2) % 2;
    const k = Math.floor(n / 4);
    island.push(
      note(`Island/${title}.md`, title, 'Island', [
        5.2 * SPACING + i * SPACING * 0.8 + jitter() * 0.5,
        0.8 * SPACING + j * SPACING * 0.8 + jitter() * 0.5,
        -0.5 * SPACING + k * SPACING * 0.8 + jitter() * 0.5,
      ]),
    );
  });
  for (let n = 0; n < island.length; n++) {
    for (let m = n + 1; m < island.length; m++) if (rnd() < 0.45) link(island[n]!, island[m]!);
  }
  link(island[0]!, island[1]!);

  const model = buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  for (const n of model.nodes) {
    const p = positions.get(n.id);
    if (p) Object.assign(n, { x: p[0], y: p[1], z: p[2] });
  }

  const pathOf = (id: string) => id.slice('me/'.length);
  const titleOf = (id: string) => nodes.find((n) => n.id === id)!.title;
  const entry = (id: string, via: CrawlResult['notes'][number]['via'], isDecision = false) => ({
    path: pathOf(id),
    title: titleOf(id),
    isDecision,
    via,
  });
  const start = grid.get('0,0,0')!;
  const far = grid.get('4,3,2')!;
  const mid = grid.get('2,1,1')!;
  const linkedFrom = (from: string, ids: string[], decision = -1) =>
    ids.map((id, i) =>
      entry(
        id,
        { kind: 'linked', from: pathOf(from), fromTitle: titleOf(from), direction: 'out', hop: 1 },
        i === decision,
      ),
    );

  const walk: CrawlResult = {
    notes: [
      entry(start, { kind: 'named', text: titleOf(start), count: 1 }),
      entry(far, { kind: 'search', term: 'latency', rank: 0 }),
      ...linkedFrom(start, [grid.get('1,0,0')!, grid.get('0,1,0')!, grid.get('0,0,1')!], 1),
    ],
    unresolved: [],
    coverage: { resolved: 2, total: 2 },
  };
  const gap: CrawlResult = {
    notes: [
      entry(mid, { kind: 'prompt', rank: 0 }),
      entry(island[0]!, { kind: 'named', text: titleOf(island[0]!), count: 1 }),
      ...linkedFrom(island[0]!, [island[1]!, island[2]!]),
    ],
    unresolved: [],
    coverage: { resolved: 2, total: 2 },
  };
  const ask: CrawlResult = {
    notes: [entry(mid, { kind: 'named', text: titleOf(mid), count: 1 })],
    unresolved: [
      { term: 'the Q3 roadmap', reason: 'no-match' },
      {
        term: 'the runbook',
        reason: 'ambiguous',
        candidates: [grid.get('0,3,1')!, grid.get('1,3,1')!].map((id) => ({
          path: pathOf(id),
          title: titleOf(id),
        })),
      },
    ],
    coverage: { resolved: 1, total: 3 },
  };
  const tour: CrawlResult = {
    notes: [...walk.notes, ...gap.notes.filter((n) => !walk.notes.some((w) => w.path === n.path))],
    unresolved: ask.unresolved,
    coverage: { resolved: 4, total: 6 },
  };

  return { model, crawls: { walk, gap, ask, tour } };
}
