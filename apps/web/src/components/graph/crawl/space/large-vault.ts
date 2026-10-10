// A vault the size of a real one, for judging Crawl's spaces at the density
// they will meet: the sample vault's 69 notes say nothing about whether pipes
// tangle, cells crowd or a frame holds 60 fps with 1,600 notes behind it.
//
// Seeded, so every run builds the same notes, links and crawls. Shaped like a
// vault people actually keep rather than a random graph:
//
//  - Project sizes follow a Zipf curve — a few big projects, many small ones —
//    because that is what makes a layout's districts uneven and its busiest
//    lanes busy.
//  - Each project files its notes in a few folders, keeps some at its root and
//    has an index (`_<Project>.md`) linking most of them: structure edges, the
//    hubs a crawl climbs through.
//  - Links are dense inside a folder, thinner across a project and sparse
//    between projects, where a handful of notes everyone cites become hubs.
//  - A small shared vault from someone else sits beside it, and one project no
//    thread reaches, so a crawl can cross the void.
//
// The positions are only a cheap stand-in for the brain (projects as clusters
// on a shell), for the lab's backdrop; every space lays the notes out itself.
// The crawls are picked by distance in the graph, not in space, so whatever a
// space does with positions its walk still crosses as many threads.

import { brainScaleFor, seededRandom } from '@/lib/graph-brain';
import {
  DEFAULT_LAYERS,
  buildGraphModel,
  hash01,
  type GraphModel,
  type GraphNode,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { findWalk, walkable, type CrawlResult } from '../crawl-plan';
import type { SampleVault } from '../sample-vault';

/** The vault this module is tuned at: about 60 projects for 1,600 notes. */
const BASE_NOTES = 1600;
const BASE_PROJECTS = 60;
/** The smallest project: an index and a few notes. */
const MIN_PROJECT = 5;
/** Zipf exponent of the project sizes: under 1, so the biggest is a few hundred, not half the vault. */
const ZIPF = 0.85;

/** Share of a project's notes its index links to. */
const INDEX_SHARE = 0.6;
/** Chance a note links to a second folder-mate, beyond the one that ties the folder together. */
const FOLDER_CHORD = 0.38;
/** Chance a note links to a note in another folder of its project. */
const PROJECT_LINK = 0.2;
/** Links between projects, per note. */
const CROSS_LINKS = 0.26;
/** Share of a project's outside links that go to its partner projects rather than anywhere. */
const PARTNER_SHARE = 0.6;
/** Pareto tail of how often a note is cited from other projects: low enough for a few hubs. */
const FAME_TAIL = 1.1;

/** World units per cube root of a project's notes: about the force layout's link length apart. */
const CLUSTER = 20;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const SUBJECTS = [
  'Ingest',
  'Schema',
  'Retention',
  'Access',
  'Billing',
  'Search',
  'Onboarding',
  'Release',
  'Pricing',
  'Audit',
  'Sync',
  'Offline',
  'Webhook',
  'Cache',
  'Backfill',
  'Feature flag',
  'Session',
  'Token',
  'Usage',
  'Alerting',
  'Capacity',
  'Query',
  'Import',
  'Export',
  'Invite',
  'Recovery',
  'Status page',
  'Incident',
  'Latency',
  'Theme',
  'Keyboard',
  'Tagging',
  'Vendor',
  'Privacy',
  'Hiring',
  'Budget',
  'Customer',
  'Partner',
  'Interview',
  'Workshop',
  'Launch',
  'Migration',
  'Storage',
  'Permissions',
  'Localization',
  'Accessibility',
  'Analytics',
  'Support',
  'Pipeline',
  'Dashboard',
  'Checkout',
  'Roadmap',
  'Notification',
  'Upload',
  'Backup',
  'Compliance',
  'Contract',
  'Mobile',
  'Sharing',
  'Editor',
];
const KINDS = [
  'plan',
  'notes',
  'review',
  'checklist',
  'spec',
  'draft',
  'retro',
  'sketch',
  'decision',
  'proposal',
  'outline',
  'log',
  'summary',
  'questions',
  'runbook',
  'metrics',
  'ideas',
  'research',
  'risks',
  'timeline',
  'FAQ',
  'postmortem',
  'brief',
  'experiment',
  'benchmarks',
  'glossary',
  'principles',
  'open issues',
];
const AREAS = [
  'Data',
  'Mobile',
  'Web',
  'Billing',
  'Growth',
  'Infra',
  'Design',
  'Research',
  'Hiring',
  'Support',
  'Legal',
  'Finance',
  'Ops',
  'Docs',
  'Platform',
  'Security',
  'Search',
  'Sync',
  'Brand',
  'Content',
  'Partner',
  'Pricing',
  'Identity',
  'Reporting',
  'Community',
  'Desktop',
  'API',
  'Payments',
  'Editor',
  'Storage',
];
const EFFORTS = [
  'platform',
  'revamp',
  'migration',
  'launch',
  'study',
  'program',
  'audit',
  'rollout',
  'handbook',
  'redesign',
  'pilot',
  'cleanup',
  'guild',
  'overhaul',
];
const FOLDERS = [
  'Specs',
  'Meetings',
  'Research',
  'Decisions',
  'Drafts',
  'Archive',
  'Notes',
  'Reviews',
  'Reference',
  'Planning',
  'Design',
  'Interviews',
  'Experiments',
  'Ops',
  'Retros',
  'Inbox',
];
/** The project no thread reaches. Its name is one word, so no generated project can take it. */
const ISLAND_NAME = 'Sketchbook';
const ISLAND = [
  'Loose ideas',
  'Field notes',
  'Quotes',
  'Travel log',
  'Recipes',
  'Bookmarks',
  'Someday',
  'Dream log',
  'Word list',
  'Doodles',
  'Gift ideas',
  'Playlists',
];
/** The shared vault beside yours: someone else's project, linked only within itself. */
const ANNEX_OWNER = 'ana';
const ANNEX_NAME = 'Field research';
const ANNEX_FOLDERS = ['Interviews', 'Observations', 'Synthesis'];

type Point = [number, number, number];

/** A project as the links between projects see it: its index, and the notes it filed. */
interface Project {
  index: string;
  notes: string[];
}

/**
 * `notes` notes (at least 60) in projects of Zipf sizes, with an index each,
 * folders, and links within and between them, beside a small shared vault and
 * an island; at the default size, 60 projects, a 40-note annex and 12 islanders.
 * Plus the four crawls the lab replays over it.
 */
export function largeVault(seed = 11, notes = BASE_NOTES): SampleVault {
  const rnd = seededRandom(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const shuffled = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const around = (c: Point, r: number): Point => {
    for (;;) {
      const x = rnd() * 2 - 1;
      const y = rnd() * 2 - 1;
      const z = rnd() * 2 - 1;
      if (x * x + y * y + z * z <= 1) return [c[0] + x * r, c[1] + y * r, c[2] + z * r];
    }
  };

  const nodes: InputNode[] = [];
  const positions = new Map<string, Point>();
  const edges: InputEdge[] = [];
  const pairs = new Set<string>();
  const link = (a: string, b: string): boolean => {
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (a === b || pairs.has(key)) return false;
    pairs.add(key);
    edges.push({ source: a, target: b, weight: 1 });
    return true;
  };
  const note = (owner: string, project: string, path: string, title: string, at: Point) => {
    const id = `${owner}/${path}`;
    nodes.push({
      id,
      path,
      title,
      ownerId: owner,
      project: { id: `${owner}|${project}`, label: project },
      createdAt: nodes.length,
      updatedAt: nodes.length,
    });
    positions.set(id, at);
    return id;
  };

  // How the vault splits: the annex and the island are small fixed shares, the
  // rest goes to the projects, whose count grows with the square root of the
  // size, so a bigger vault has both more and bigger projects.
  const total = Math.max(notes, 60);
  const annexSize = clamp(Math.round(total * 0.025), 6, 60);
  const islandSize = clamp(Math.round(total * 0.0075), 4, ISLAND.length);
  const lattice = total - annexSize - islandSize;
  const projectCount = clamp(
    Math.round(BASE_PROJECTS * Math.sqrt(total / BASE_NOTES)),
    2,
    Math.floor(lattice / MIN_PROJECT),
  );
  const sizes = zipfSizes(lattice, projectCount, rnd);

  // Every project, the annex and the island get a spot on a shell shaped like
  // the brain the backdrop draws, in a shuffled order so the big ones spread.
  const scale = brainScaleFor(total);
  const slots = shuffled(Array.from({ length: projectCount + 2 }, (_, k) => k));
  const spot = (slot: number, radius: number): Point => {
    const y = 1 - (2 * (slot + 0.5)) / slots.length;
    const r = Math.sqrt(1 - y * y);
    const a = slot * GOLDEN_ANGLE;
    // Pulled in by its own radius, so a big project does not bulge out of the brain.
    const k = scale * (1 - radius / (scale * 1.6));
    return [Math.cos(a) * r * 0.75 * k, y * 0.6 * k - 0.13 * scale, Math.sin(a) * r * 0.6 * k];
  };

  const buildProject = (name: string, owner: string, size: number, slot: number): Project => {
    const radius = CLUSTER * Math.cbrt(size);
    const centre = spot(slot, radius);
    const index = note(owner, name, `${name}/_${name}.md`, name, centre);
    const count = size - 1;

    // A theme: the subjects this project's notes are about, more for a bigger
    // one, so its titles read as one project's and repeat across a few others.
    const subjects = shuffled(SUBJECTS).slice(0, clamp(Math.ceil(count / 10), 6, SUBJECTS.length));
    const titles = new Set<string>();
    const title = () => {
      for (let tries = 0; ; tries++) {
        const base = `${pick(subjects)} ${pick(KINDS)}`;
        const t = tries < 12 ? base : `${base} ${tries - 10}`;
        if (!titles.has(t)) {
          titles.add(t);
          return t;
        }
      }
    };

    // One to six folders, more as the project grows, of uneven sizes; a few
    // notes stay at the root. Group 0 is the root; every folder gets a note first.
    const folders = owner === ANNEX_OWNER ? ANNEX_FOLDERS : shuffled(FOLDERS);
    const folderCount = clamp(
      Math.round(1 + Math.log2(count / 8) + (rnd() - 0.5)),
      1,
      Math.min(6, folders.length, Math.floor(count / 2)),
    );
    const rootShare = folderCount === 1 ? 0.3 : 0.12;
    const weights = Array.from({ length: folderCount }, (_, j) => (j + 1) ** -0.6);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const homes = Array.from({ length: count }, (_, i) => {
      if (i < folderCount) return i + 1;
      if (rnd() < rootShare) return 0;
      let w = rnd() * weightSum;
      for (let j = 0; j < folderCount; j++) if ((w -= weights[j]!) <= 0) return j + 1;
      return folderCount;
    });
    const groups: string[][] = Array.from({ length: folderCount + 1 }, () => []);
    const spread = groups.map((_, g) => ({
      centre: around(centre, g === 0 ? radius * 0.2 : radius * 0.65),
      radius: CLUSTER * 0.8 * Math.cbrt(homes.filter((h) => h === g).length) + 6,
    }));
    for (const g of homes) {
      const t = title();
      const folder = g === 0 ? '' : `${folders[g - 1]!}/`;
      groups[g]!.push(
        note(
          owner,
          name,
          `${name}/${folder}${t}.md`,
          t,
          around(spread[g]!.centre, spread[g]!.radius),
        ),
      );
    }

    // Inside a folder every note links to one written before it — mostly a
    // recent one, sometimes the folder's first, the note the others hang off —
    // so the folder is one piece; some link to a second.
    for (const group of groups) {
      for (let i = 1; i < group.length; i++) {
        const back = rnd() < 0.3 ? i : 1 + Math.floor(rnd() ** 2 * Math.min(i, 5));
        link(group[i]!, group[i - back]!);
        if (rnd() < FOLDER_CHORD) link(group[i]!, group[Math.floor(rnd() * i)]!);
      }
    }
    // Across the project's folders, thinner, and often to a folder's first note.
    const filled = groups.filter((g) => g.length > 0);
    if (filled.length > 1) {
      for (const [g, group] of filled.entries()) {
        for (const id of group) {
          if (rnd() >= PROJECT_LINK) continue;
          const other = filled[(g + 1 + Math.floor(rnd() * (filled.length - 1))) % filled.length]!;
          link(id, rnd() < 0.5 ? other[0]! : pick(other));
        }
      }
    }
    // The index files most notes, and at least one of every folder, so the
    // whole project hangs from it.
    for (const group of filled) {
      let any = false;
      for (const id of group) if (rnd() < INDEX_SHARE) any = link(index, id) || any;
      if (!any) link(index, group[0]!);
    }
    return { index, notes: groups.flat() };
  };

  // Generated names run out only past some 400 projects; a number keeps paths apart then.
  const names = shuffled(AREAS.flatMap((a) => EFFORTS.map((e) => `${a} ${e}`)));
  const projects = sizes.map((size, p) => {
    const lap = Math.floor(p / names.length);
    const name = `${names[p % names.length]!}${lap > 0 ? ` ${lap + 1}` : ''}`;
    return buildProject(name, 'me', size, slots[p]!);
  });
  buildProject(ANNEX_NAME, ANNEX_OWNER, annexSize, slots[projectCount]!);
  crossLinks(projects, edges, lattice, rnd, link, pick);

  // The island: notes nobody filed, linked among themselves and to nothing else.
  const islandRadius = CLUSTER * Math.cbrt(islandSize);
  const islandCentre = spot(slots[projectCount + 1]!, islandRadius);
  const island = ISLAND.slice(0, islandSize).map((t) =>
    note('me', ISLAND_NAME, `${ISLAND_NAME}/${t}.md`, t, around(islandCentre, islandRadius)),
  );
  for (let i = 1; i < island.length; i++) {
    link(island[i]!, island[Math.floor(rnd() * i)]!);
    if (rnd() < 0.4) link(island[i]!, island[Math.floor(rnd() * i)]!);
  }

  const model = buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map([[ANNEX_OWNER, { label: ANNEX_NAME, owner: ANNEX_OWNER }]]),
    cache: new Map(),
  });
  for (const n of model.nodes) {
    const p = positions.get(n.id);
    if (p) Object.assign(n, { x: p[0], y: p[1], z: p[2], ox: 0, oy: 0, oz: 0 });
  }

  return { model, crawls: pickCrawls(model, projects, island, seed) };
}

/**
 * Links between projects. Most go to a project's partners — the few it works
 * with — and the rest anywhere; either way the note cited is drawn by how
 * famous it is, a Pareto weight, so a few notes collect many links and become
 * the hubs real vaults have. A few indexes link each other's. Then any project
 * still apart from the rest is tied in: only the island stands alone.
 */
function crossLinks(
  projects: readonly Project[],
  edges: readonly InputEdge[],
  lattice: number,
  rnd: () => number,
  link: (a: string, b: string) => boolean,
  pick: <T>(list: readonly T[]) => T,
): void {
  const count = projects.length;
  const tables = projects.map((p) => {
    const cum: number[] = [];
    let sum = 0;
    for (let i = 0; i < p.notes.length; i++) {
      cum.push((sum += Math.min((1 - rnd()) ** (-1 / FAME_TAIL), 400)));
    }
    return { cum, sum };
  });
  const famous = (p: number): string => {
    const { cum, sum } = tables[p]!;
    const w = rnd() * sum;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < w) lo = mid + 1;
      else hi = mid;
    }
    return projects[p]!.notes[lo]!;
  };
  // A project is cited in proportion to its notes' fame, so big projects with
  // famous notes draw more of the vault's outside links.
  const projectCum: number[] = [];
  let projectSum = 0;
  for (const t of tables) projectCum.push((projectSum += t.sum));
  const anyProject = (): number => {
    const w = rnd() * projectSum;
    const at = projectCum.findIndex((c) => c >= w);
    return at < 0 ? count - 1 : at;
  };
  const partners = projects.map((_, p) =>
    Array.from(
      { length: 2 + Math.floor(rnd() * 2) },
      () => (p + 1 + Math.floor(rnd() * (count - 1))) % count,
    ),
  );

  const want = Math.round(lattice * CROSS_LINKS);
  for (let made = 0, tries = 0; made < want && tries < want * 4; tries++) {
    const from = Math.floor(rnd() * count);
    const to = rnd() < PARTNER_SHARE ? pick(partners[from]!) : anyProject();
    if (to !== from && link(pick(projects[from]!.notes), famous(to))) made++;
  }
  for (let k = 0; k < Math.round(count / 5); k++) {
    const from = Math.floor(rnd() * count);
    link(projects[from]!.index, projects[pick(partners[from]!)]!.index);
  }

  // Tie in what is still apart: union-find over the projects through every
  // link so far, then each loose project's index to the one before it, which
  // by then is tied in itself.
  const parent = projects.map((_, p) => p);
  const root = (p: number): number => {
    while (parent[p] !== p) {
      parent[p] = parent[parent[p]!]!;
      p = parent[p]!;
    }
    return p;
  };
  const projectOf = new Map<string, number>();
  projects.forEach((p, i) => {
    for (const id of p.notes) projectOf.set(id, i);
    projectOf.set(p.index, i);
  });
  for (const e of edges) {
    const a = projectOf.get(e.source);
    const b = projectOf.get(e.target);
    if (a !== undefined && b !== undefined) parent[root(a)] = root(b);
  }
  for (let p = 1; p < count; p++) {
    if (root(p) === root(0)) continue;
    link(projects[p]!.index, projects[p - 1]!.index);
    parent[root(p)] = root(p - 1);
  }
}

/** Hops apart the walk crawl's two notes are, along the fewest threads. */
const WALK_HOPS = { min: 6, max: 10, aim: 7 };

/**
 * The four crawls, picked by distance in the graph rather than by place, so
 * they mean the same in every space: a walk between two notes some seven
 * threads apart, a reach into the island, two references nothing settles,
 * and all of it at once.
 */
function pickCrawls(
  model: GraphModel,
  projects: readonly Project[],
  island: readonly string[],
  seed: number,
): SampleVault['crawls'] {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const node = (id: string) => byId.get(id)!;
  const notes = projects.flatMap((p) => p.notes.map(node));
  const projectOf = new Map<GraphNode, number>();
  projects.forEach((p, i) => p.notes.forEach((id) => projectOf.set(node(id), i)));
  // A seeded order for every choice, so a different seed picks different notes.
  const rank = new Map(model.nodes.map((n) => [n, hash01(`${seed}:${n.id}`)]));
  const ordered = (list: readonly GraphNode[]) =>
    [...list].sort((a, b) => rank.get(a)! - rank.get(b)! || a.id.localeCompare(b.id));
  const linkCount = (n: GraphNode) =>
    (model.adjacency.get(n) ?? []).reduce((k, x) => k + (x.edge.kind === 'link' ? 1 : 0), 0);
  const linksOf = (n: GraphNode) =>
    ordered(
      (model.adjacency.get(n) ?? []).filter((x) => x.edge.kind === 'link').map((x) => x.node),
    );

  const entry = (n: GraphNode, via: CrawlResult['notes'][number]['via'], isDecision = false) => ({
    path: n.path,
    title: n.title,
    isDecision,
    via,
  });
  const named = (n: GraphNode) => entry(n, { kind: 'named', text: n.title, count: 1 });
  const linkedFrom = (from: GraphNode, to: readonly GraphNode[], decision = -1) =>
    to.map((n, i) =>
      entry(
        n,
        { kind: 'linked', from: from.path, fromTitle: from.title, direction: 'out', hop: 1 },
        i === decision,
      ),
    );

  // The note most linked to: what a question about the vault would match first.
  const hub = notes.reduce((best, n) => (linkCount(n) > linkCount(best) ? n : best));

  // The walk: from a note with three links of its own (not counting the hub,
  // which the other crawls name) to one the right number of threads away. The
  // fewest threads come from a breadth-first search, so no space can make the
  // walk shorter; the walk the replay takes here, shortest by length, is
  // checked too, so in this layout it is no longer than the crawl allows.
  let start = notes[0]!;
  let far = notes[notes.length - 1]!;
  let farHops = -1;
  const starts = ordered(notes.filter((n) => n !== hub && linkCount(n) >= 4)).slice(0, 40);
  search: for (const from of starts) {
    const hops = hopsAlongThreads(model, from);
    const targets = ordered(
      notes.filter((n) => {
        const h = hops.get(n) ?? -1;
        return n !== hub && h >= WALK_HOPS.min && h <= WALK_HOPS.max;
      }),
    ).sort(
      (a, b) => Math.abs(hops.get(a)! - WALK_HOPS.aim) - Math.abs(hops.get(b)! - WALK_HOPS.aim),
    );
    for (const to of targets.slice(0, 3)) {
      const walk = findWalk(model, from, to);
      if (walk && walk.length - 1 <= WALK_HOPS.max) {
        start = from;
        far = to;
        break search;
      }
    }
    // Too small a vault for the full distance: the farthest note found will do.
    for (const [n, h] of hops) {
      if (h > farHops && n !== hub && projectOf.has(n)) {
        farHops = h;
        start = from;
        far = n;
      }
    }
  }
  const walk: CrawlResult = {
    notes: [
      named(start),
      named(far),
      ...linkedFrom(
        start,
        linksOf(start)
          .filter((n) => n !== hub)
          .slice(0, 3),
        1,
      ),
    ],
    unresolved: [],
    coverage: { resolved: 2, total: 2 },
  };

  // The gap: a question matches the hub, then names the island's best-linked note.
  const shore = island.map(node).reduce((best, n) => (linkCount(n) > linkCount(best) ? n : best));
  const gap: CrawlResult = {
    notes: [
      entry(hub, { kind: 'prompt', rank: 0 }),
      named(shore),
      ...linkedFrom(shore, linksOf(shore).slice(0, 2)),
    ],
    unresolved: [],
    coverage: { resolved: 2, total: 2 },
  };

  // The ask: one reference nothing matches, and one two notes could mean —
  // two projects that each keep a note of the same title, as vaults do.
  const seen = new Map<string, GraphNode>();
  let twins: [GraphNode, GraphNode] | null = null;
  for (const n of notes) {
    const other = seen.get(n.title);
    if (other && projectOf.get(other) !== projectOf.get(n)) {
      twins = [other, n];
      break;
    }
    if (!other) seen.set(n.title, n);
  }
  twins ??= [notes[0]!, notes.find((n) => projectOf.get(n) !== projectOf.get(notes[0]!))!];
  const ask: CrawlResult = {
    notes: [named(hub)],
    unresolved: [
      { term: 'the offsite agenda', reason: 'no-match' },
      {
        term: `the ${twins[0].title.toLowerCase()}`,
        reason: 'ambiguous',
        candidates: twins.map((n) => ({ path: n.path, title: n.title })),
      },
    ],
    coverage: { resolved: 1, total: 3 },
  };

  const tour: CrawlResult = {
    notes: [...walk.notes, ...gap.notes, ...ask.notes].filter(
      (n, i, all) => all.findIndex((m) => m.path === n.path) === i,
    ),
    unresolved: ask.unresolved,
    coverage: {
      resolved: walk.coverage.resolved + gap.coverage.resolved + ask.coverage.resolved,
      total: walk.coverage.total + gap.coverage.total + ask.coverage.total,
    },
  };

  return { walk, gap, ask, tour };
}

/** How many threads away every note is from `start`, walking only threads a crawl walks. */
function hopsAlongThreads(model: GraphModel, start: GraphNode): Map<GraphNode, number> {
  const hops = new Map<GraphNode, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]!;
    const h = hops.get(u)! + 1;
    for (const { node, edge } of model.adjacency.get(u) ?? []) {
      if (!walkable(edge) || hops.has(node)) continue;
      hops.set(node, h);
      queue.push(node);
    }
  }
  return hops;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Project sizes on a Zipf curve, a little jittered, each at least
 * `MIN_PROJECT`, summing to exactly `total`.
 */
function zipfSizes(total: number, count: number, rnd: () => number): number[] {
  const weights = Array.from({ length: count }, (_, k) => (k + 1) ** -ZIPF * (0.8 + 0.4 * rnd()));
  const sum = weights.reduce((a, b) => a + b, 0);
  const spare = total - MIN_PROJECT * count;
  const raw = weights.map((w) => (w / sum) * spare);
  const sizes = raw.map((r) => MIN_PROJECT + Math.floor(r));
  const order = raw
    .map((r, i) => ({ rest: r - Math.floor(r), i }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  let left = total - sizes.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k = (k + 1) % count, left--) {
    const i = order[k]!.i;
    sizes[i] = sizes[i]! + 1;
  }
  return sizes;
}
