// Where each note stands in Crawl's cluster, and how its threads run there:
// the pure layout behind the dormant network. Pure and deterministic — the
// same vault always lands the same way, whatever order its notes arrive in —
// so the walk through it is tested without a canvas.
//
// Notes fill the volume of a form (cluster.ts): a hub with lobes round it on
// short necks, and a satellite apart. They stand on the sites of an FCC
// lattice cut to the form (lattice.ts), one per site, with about 30% of the
// sites left free: room for every project to grow in one piece, and gutters
// that let neighbouring projects read apart. The sites are spaced like the
// brain's links, so the Sentinel's grips meet the same density of threads here
// as there, and the form is sized from the vault, so that density holds at 69
// notes and at 1,600.
//
// Each project is a region: one piece of ground, grown with capacity before
// any note is placed, nearest site first from its seed and only into a stretch
// of free ground big enough to hold it — contiguous by construction. The
// biggest projects each fill a lobe; the hub holds every other one and is the
// crossroads, so the threads between projects cross it. Projects are not
// ordered by affinity: long journeys through the centre are the point, as in
// the brain, where projects sit by hash. Somebody else's vault fills a lobe of
// its own behind a moat of empty sites; a project no thread reaches (an
// island) floats on the satellite, and a walk there crosses open space.
// Where several regions share a bulb, the first leans against its surface and
// grows inwards as a cap: grown round the bulb's middle, it would leave the
// rest a skin too thin to hold them whole.
//
// Inside a region its index stands at the ground's medoid, its heart. The
// notes of the project's own folder gather round it; each folder below takes
// a cone out from it, sized by its notes; and every note is placed beside the
// note it was reached from over the links, so linked notes sit close. Notes
// are placed only beside notes already there, so a region's notes are one
// piece too. Then each is jittered a little off its site, so the cluster does
// not read as a grid, but never closer than three quarters of a spacing to
// another. Threads run as straight chords with a gentle bow.
//
// The lab lays a vault out again at every knob it turns, so the work goes by
// each note's rank, in typed arrays, rather than by id through maps; the maps
// in the result are filled once at the end.

import { OWN_VAULT, hash01, type GraphModel, type GraphNode } from '@/lib/graph-model';

import { walkable } from '../../crawl-plan';
import { threadKey, type ThreadKey } from '../../threads';
import type { Vec3 } from '../../vec';

import {
  MAX_LOBES,
  PARTS,
  PART_HUB,
  PART_SATELLITE,
  clusterFor,
  formDirection,
  lobePart,
  neckPart,
  openDirection,
  probe,
  type Bulb,
  type Cluster,
  type ClusterNeeds,
  type Probe,
} from './cluster';
import { MinHeap } from './heap';
import { fccLattice, type VolumeLattice } from './lattice';

/** World units per creature unit. */
const VOLUME_UNIT = 10;
/**
 * Creature units between neighbouring sites. The brain's unit is 0.6 of its
 * median link, so its links run 1.7 units: the density the grips were tuned on.
 */
export const VOLUME_SPACING = 1.7;
/** Where a thread's control point sits off its chord, as a share of its length: the brain's bezier's 0.1. */
export const VOLUME_BOW = 0.1;
/** The least a neck is across, spacings: two, so the threads between a lobe and the hub pass through it. */
export const NECK_WIDTH = 2;

/** `owner` of a site no region has claimed. */
const FREE = -1;
/** `owner` of a site in a moat: kept empty round a region that stands apart. */
const MOAT = -2;

export type CrystalKind = 'index' | 'decision' | 'note';

/** The share of sites notes take: the rest is room to grow, gutters and moats. */
const OCCUPANCY = 0.7;
/** The share of a region's ground its notes take; the rest is the gutter round its rim. */
const FILL = 0.85;
/** The least a project is to get a lobe: this many notes, and this share of the vault. */
const LOBE_MIN_NOTES = 12;
const LOBE_MIN_SHARE = 0.03;
/**
 * The hub keeps at least this many times the notes of the biggest lobe, as
 * the sketch's hub (0.44) is to its biggest lobe (0.33).
 */
const HUB_OVER = 2;
/**
 * Building the form: at most this many passes; a part may come out this share
 * short of its need, and one that comes out shorter is drawn bigger by at
 * least this factor next pass. Small balls gain sites a shell at a time, so
 * the satellite takes the most passes: three on the large vaults.
 */
const FORM_PASSES = 4;
const FORM_SLACK = 0.02;
const FORM_STEP = 1.04;
/** The furthest a note moves off its site, spacings: enough that the cluster does not read as a grid. */
const JITTER = 0.25;
/** The least two notes are apart, spacings, so their crystals never meet. */
const MIN_GAP = 0.75;
/** A jittered note stays at least this many spacings inside the form's surface. */
const NOTE_INSET = 0.1;
/**
 * Creature units a route's straight piece covers, and the most pieces a route
 * has: planning grips measures every one.
 */
const ROUTE_STEP = 1.5;
const MAX_SEGMENTS = 8;
/** How hard a note is kept inside its folder's cone, per spacing out from the heart. */
const WEDGE_PULL = 1.2;
/** How hard every note is drawn towards its region's heart, per spacing out. */
const INWARD = 0.15;
/** Where a folder's first note aims: this share of the way from the heart to the region's rim. */
const HUB_OUT = 0.4;
/** Above this many ground sites the medoid is sought among the ones nearest the ground's middle only. */
const MEDOID_ALL = 600;
const MEDOID_NEAR = 128;
/** The side of the hub its first project leans against when there is no satellite to turn away from. */
const HUB_HOME: Vec3 = [-0.3, -0.2, 0.93];

export interface VolumeOptions {
  /** World units per creature unit. */
  unit?: number;
  /** Creature units between neighbouring sites. */
  spacing?: number;
  /** Where a thread's control point sits off its chord, as a share of its length. */
  bow?: number;
  /** The least a neck is across, spacings. */
  neck?: number;
  /**
   * Notes that record a decision, by id: they get the decision crystal. From
   * the data (a decision tag, the crawl's own flag), never guessed from a title.
   */
  decisions?: ReadonlySet<string>;
}

export interface VolumeRegion {
  /** `${vault}|${project id}`. */
  key: string;
  /** The project's name. */
  label: string;
  vault: string;
  /** Its notes' ids in the order they were placed: its heart first. */
  notes: readonly string[];
  /** The site each of `notes` stands on, same order. */
  sites: Uint32Array;
  /** The medoid of its ground, where its heart stands. */
  centre: number;
  /** The part it was grown in: PART_HUB, lobePart(i) or PART_SATELLITE. */
  part: number;
  /** Another person's vault behind a moat, or an island on the satellite; null otherwise. */
  apart: 'annex' | 'island' | null;
  /** Pieces its notes fall in beyond the first: 0 is the promise. */
  pieces: number;
}

export interface VolumeLayout {
  cluster: Cluster;
  lattice: VolumeLattice;
  /** The hub's centre, world units: [0, 0, 0]. */
  centre: Vec3;
  /** Bounding radius about `centre`, world units (cluster.radius). */
  radius: number;
  /** World units per creature unit. */
  unit: number;
  /** World units between neighbouring sites. */
  spacing: number;
  /** Where each note stands, by id, rounded to float32: also where its threads start. */
  positions: Map<string, Vec3>;
  /** The site each note stands on. */
  siteOf: Map<string, number>;
  /** Per site: the region whose ground it is; -1 free, -2 in a moat. */
  owner: Int32Array;
  /**
   * In the order they were claimed: annex vaults, lobe projects, islands, the
   * hub's moated drafts, then the rest of the hub's.
   */
  regions: VolumeRegion[];
  /** Each note's index in `regions`. */
  regionOf: Map<string, number>;
  kinds: Map<string, CrystalKind>;
  /** Each walkable thread whose notes both stand, from its key's first note to its second. */
  routes: Map<ThreadKey, Float32Array>;
  /** The routed threads at each note. */
  adjacency: Map<string, ThreadKey[]>;
  stats: {
    ms: number;
    lobes: number;
    satellite: boolean;
    sites: number;
    /** Pieces beyond the first, over every region: 0 is the promise. */
    pieces: number;
    /**
     * Notes left with no site, because their region's ground came out short:
     * 0 is the promise. They have no position, so nothing draws them and a
     * walk cannot reach them; counted, so the layout never reports itself
     * whole while it is not.
     */
    unplaced: number;
    /** The share of sites with no note. */
    vacancy: number;
  };
}

/** A walkable thread between two notes. */
interface Thread {
  key: ThreadKey;
  /** The key's first note, and its second, and their ranks. */
  a: GraphNode;
  b: GraphNode;
  ra: number;
  rb: number;
  /** Its place in the fixed order: by its first note's rank, then its second's. */
  order: number;
}

/** A project before it has ground. */
interface Draft {
  key: string;
  label: string;
  vault: string;
  /** In id order: note k has rank `base + k`. */
  notes: GraphNode[];
  base: number;
  /** The walkable threads between its own notes, in the fixed order. */
  within: Thread[];
  /** Sites its ground takes: its notes and the gutter round them. */
  ground: number;
  apart: 'annex' | 'island' | null;
  /** A moat after it, and none of its ground beside anyone else's: an annex or island kept in the hub. */
  moated: boolean;
}

/** A lobe, before the form: one vault of somebody else's, or one project of your own. */
interface LobeDraft {
  key: string;
  notes: number;
  drafts: Draft[];
  annex: boolean;
}

/** A number in [0, 1) that looks random but is fixed for a pair of sites. */
function scatter(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const positive = (x: number | undefined): number | null =>
  x !== undefined && x > 0 && Number.isFinite(x) ? x : null;
const byId = (x: GraphNode, y: GraphNode) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
/** Oldest first, then by id: the order notes were written in, so a new note goes last. */
const byAge = (x: GraphNode, y: GraphNode) => x.createdAt - y.createdAt || byId(x, y);
const byKey = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/** Biggest first, then by key. */
const bySize = (x: Draft, y: Draft) => y.notes.length - x.notes.length || byKey(x.key, y.key);
/**
 * About how many sites a moat round `ground` sites keeps empty: half a first
 * shell, as round a region that leans against its bulb's surface. A moat on
 * every side takes more; the room every part keeps free beyond its grounds
 * (OCCUPANCY under FILL) covers the difference.
 */
const ringOf = (ground: number) => Math.ceil(3 * ground ** (2 / 3) + 6);

/** Lays the model's notes out through a cluster, and its walkable threads as bowed chords through it. */
export function volumeLayout(model: GraphModel, opts: VolumeOptions = {}): VolumeLayout {
  const started = performance.now();
  const unit = positive(opts.unit) ?? VOLUME_UNIT;
  const a = (positive(opts.spacing) ?? VOLUME_SPACING) * unit;
  const bow = Math.max(0, opts.bow ?? VOLUME_BOW);
  const neck = Math.max(1, opts.neck ?? NECK_WIDTH);

  // Every note's rank: drafts in key order, notes in id order.
  const drafts = gather(model);
  const byRank: GraphNode[] = [];
  const rankOf = new Map<string, number>();
  for (const d of drafts) {
    d.base = byRank.length;
    for (const n of d.notes) {
      rankOf.set(n.id, byRank.length);
      byRank.push(n);
    }
  }
  const draftOf = new Int32Array(byRank.length);
  drafts.forEach((d, p) => draftOf.fill(p, d.base, d.base + d.notes.length));
  const threads = threadsOf(model, rankOf);
  const ties = new Int32Array(drafts.length);
  for (const t of threads) {
    const p = draftOf[t.ra]!;
    const q = draftOf[t.rb]!;
    if (p === q) drafts[p]!.within.push(t);
    else {
      ties[p]!++;
      ties[q]!++;
    }
  }
  const plan = classify(drafts, ties);

  // The form, grown until every part holds what it needs: the lattice rounds
  // small balls down, a shell at a time.
  const need = new Float64Array(PARTS);
  need[PART_HUB] = plan.needs.hub;
  plan.needs.lobes.forEach((n, i) => (need[lobePart(i)] = n));
  need[PART_SATELLITE] = plan.needs.satellite;
  const boost = new Float64Array(PARTS).fill(1);
  let cluster!: Cluster;
  let lattice!: VolumeLattice;
  for (let pass = 0; pass < FORM_PASSES; pass++) {
    cluster = clusterFor(plan.needs, { spacing: a, neck, boost });
    lattice = fccLattice(cluster);
    let short = false;
    for (let p = 0; p < PARTS; p++) {
      const want = need[p]!;
      const got = lattice.counts[p]!;
      if (want <= 0 || got >= want * (1 - FORM_SLACK)) continue;
      short = true;
      boost[p] = boost[p]! * Math.max(FORM_STEP, Math.cbrt(want / Math.max(1, got)));
    }
    if (!short) break;
  }

  const owner = new Int32Array(lattice.count).fill(FREE);
  const claimed = claim(cluster, lattice, plan, owner);

  // Regions are numbered in the order they were claimed; `owner` already is.
  const slot = new Int32Array(lattice.count).fill(-1);
  const siteOfRank = new Int32Array(byRank.length).fill(-1);
  const siteOf = new Map<string, number>();
  const regionOf = new Map<string, number>();
  const regions: VolumeRegion[] = [];
  let pieces = 0;
  claimed.forEach(({ draft: d, ground, part }, r) => {
    const placed = settle(lattice, d, ground, r, owner, slot);
    const ids = placed.notes.map((k) => d.notes[k]!.id);
    const region: VolumeRegion = {
      key: d.key,
      label: d.label,
      vault: d.vault,
      notes: ids,
      sites: Uint32Array.from(placed.sites),
      centre: placed.centre,
      part,
      apart: d.apart,
      pieces: piecesOf(lattice, placed.sites, slot),
    };
    pieces += region.pieces;
    regions.push(region);
    placed.notes.forEach((k, j) => {
      const v = placed.sites[j]!;
      siteOfRank[d.base + k] = v;
      siteOf.set(ids[j]!, v);
      regionOf.set(ids[j]!, r);
    });
  });

  // Rounded to what a Float32Array holds, so a thread's first and last points
  // are exactly its notes' positions.
  const at = jitter(cluster, lattice, siteOfRank);
  const positions = new Map<string, Vec3>();
  const kinds = new Map<string, CrystalKind>();
  byRank.forEach((n, k) => {
    if (siteOfRank[k]! < 0) return;
    positions.set(n.id, [at[k * 3]!, at[k * 3 + 1]!, at[k * 3 + 2]!]);
    kinds.set(n.id, n.isIndex ? 'index' : opts.decisions?.has(n.id) ? 'decision' : 'note');
  });

  // Threads, as chords with a gentle bow between their notes.
  const routes = new Map<ThreadKey, Float32Array>();
  const atNote: ThreadKey[][] = byRank.map(() => []);
  for (const t of threads) {
    const va = siteOfRank[t.ra]!;
    const vb = siteOfRank[t.rb]!;
    if (va < 0 || vb < 0) continue;
    const across = lattice.part[va] !== lattice.part[vb];
    routes.set(t.key, route(at, t.ra, t.rb, bow, across, scatter(va, vb), unit));
    atNote[t.ra]!.push(t.key);
    atNote[t.rb]!.push(t.key);
  }
  const adjacency = new Map<string, ThreadKey[]>();
  atNote.forEach((list, k) => {
    if (list.length > 0) adjacency.set(byRank[k]!.id, list);
  });

  return {
    cluster,
    lattice,
    centre: cluster.centre,
    radius: cluster.radius,
    unit,
    spacing: a,
    positions,
    siteOf,
    owner,
    regions,
    regionOf,
    kinds,
    routes,
    adjacency,
    stats: {
      ms: performance.now() - started,
      lobes: cluster.lobes.length,
      satellite: cluster.satellite !== null,
      sites: lattice.count,
      pieces,
      unplaced: byRank.length - positions.size,
      vacancy: 1 - positions.size / lattice.count,
    },
  };
}

/** The vault's projects as drafts, by key, each with its notes in id order. Topics are never placed. */
function gather(model: GraphModel): Draft[] {
  const groups = new Map<string, GraphNode[]>();
  for (const n of model.nodes) {
    if (n.kind !== 'note') continue;
    listAt(groups, `${n.vault}|${n.project?.id ?? ''}`).push(n);
  }
  return [...groups.keys()].sort().map((key) => {
    const notes = groups.get(key)!.sort(byId);
    const first = notes[0]!;
    return {
      key,
      label: first.project?.label ?? '',
      vault: first.vault,
      notes,
      base: 0,
      within: [],
      ground: Math.ceil(notes.length / FILL),
      apart: null,
      moated: false,
    };
  });
}

/** The walkable threads between notes, once each, in a fixed order whatever the model's. */
function threadsOf(model: GraphModel, rankOf: ReadonlyMap<string, number>): Thread[] {
  // Keyed and sorted by the notes' ranks, one number a pair, rather than by
  // the keys' long strings: the same fixed order, at a fraction of the cost.
  const notes = rankOf.size;
  const out = new Map<number, Thread>();
  for (const e of model.edges) {
    if (!walkable(e) || e.source.id === e.target.id) continue;
    const rs = rankOf.get(e.source.id);
    const rt = rankOf.get(e.target.id);
    if (rs === undefined || rt === undefined) continue;
    const forward = e.source.id < e.target.id;
    const order = forward ? rs * notes + rt : rt * notes + rs;
    if (out.has(order)) continue;
    out.set(order, {
      key: threadKey(e.source, e.target),
      a: forward ? e.source : e.target,
      b: forward ? e.target : e.source,
      ra: forward ? rs : rt,
      rb: forward ? rt : rs,
      order,
    });
  }
  return [...out.values()].sort((x, y) => x.order - y.order);
}

/** Who goes where: the lobes, the satellite's islands and the hub's drafts, and what each part needs. */
interface Plan {
  lobes: LobeDraft[];
  islands: Draft[];
  hub: Draft[];
  needs: ClusterNeeds;
}

/**
 * Decides, from the data only, which drafts get a lobe, which float on the
 * satellite and which the hub holds — and so how big each part is.
 *
 * Somebody else's vaults take a lobe each, biggest first. Your own projects
 * take one when they are big enough to fill one and the hub would still hold
 * twice the biggest lobe; the rest stay in the hub. A project of your own no
 * thread reaches is an island — except the biggest, the anchor, so a vault of
 * one project, or of projects that never link, is a hub and not an empty hub
 * with everything on the satellite. Islands go to the satellite while they
 * stay small next to the hub; the rest, and any vault beyond the lobes, stay
 * in the hub behind a moat.
 */
function classify(drafts: Draft[], ties: Int32Array): Plan {
  let notes = 0;
  for (const d of drafts) notes += d.notes.length;
  const tie = new Map(drafts.map((d, p) => [d, ties[p]!]));

  const own = drafts.filter((d) => d.vault === OWN_VAULT).sort(bySize);
  const anchor = own[0];
  const islands = own.filter((d) => d !== anchor && tie.get(d) === 0);
  const tied = own.filter((d) => d === anchor || tie.get(d)! > 0);

  const vaults = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.vault === OWN_VAULT) continue;
    d.apart = 'annex';
    listAt(vaults, d.vault).push(d);
  }
  const annexes: LobeDraft[] = [...vaults]
    .map(([vault, list]) => ({
      key: vault,
      notes: list.reduce((sum, d) => sum + d.notes.length, 0),
      drafts: list.sort(bySize),
      annex: true,
    }))
    .sort((x, y) => y.notes - x.notes || byKey(x.key, y.key));
  const lobes = annexes.slice(0, MAX_LOBES);
  const hub: Draft[] = [];
  for (const overflow of annexes.slice(MAX_LOBES)) {
    for (const d of overflow.drafts) {
      d.moated = true;
      hub.push(d);
    }
  }

  const lobeMin = Math.max(LOBE_MIN_NOTES, Math.ceil(LOBE_MIN_SHARE * notes));
  let hubNotes = tied.reduce((sum, d) => sum + d.notes.length, 0);
  let biggest = 0;
  for (const d of tied) {
    const size = d.notes.length;
    if (
      lobes.length < MAX_LOBES &&
      size >= lobeMin &&
      hubNotes - size >= HUB_OVER * Math.max(size, biggest)
    ) {
      lobes.push({ key: d.key, notes: size, drafts: [d], annex: false });
      hubNotes -= size;
      biggest = Math.max(biggest, size);
    } else hub.push(d);
  }
  lobes.sort((x, y) => y.notes - x.notes || byKey(x.key, y.key));

  // The satellite holds islands while they stay small beside the hub: a vault
  // of many unlinked projects must not grow a satellite bigger than its hub.
  const floating: Draft[] = [];
  let afloat = 0;
  let full = false;
  for (const d of islands) {
    d.apart = 'island';
    full ||= afloat + d.notes.length > hubNotes / HUB_OVER;
    if (full) {
      d.moated = true;
      hub.push(d);
    } else {
      floating.push(d);
      afloat += d.notes.length;
    }
  }
  // The moated first, while the hub is still open: one claimed after the
  // others could find every free site left beside somebody's ground, and so
  // no ground at all.
  hub.sort((x, y) => Number(y.moated) - Number(x.moated) || bySize(x, y));

  // The hub's need counts everything it holds, overflow and moats included.
  let hubNeed = 0;
  for (const d of hub) hubNeed += d.notes.length + (d.moated ? ringOf(d.ground) : 0);
  let satellite = 0;
  for (const d of floating) satellite += d.ground + (floating.length > 1 ? ringOf(d.ground) : 0);
  return {
    lobes,
    islands: floating,
    hub,
    needs: {
      hub: Math.ceil(hubNeed / OCCUPANCY),
      lobes: lobes.map((l) => Math.ceil(l.notes / OCCUPANCY)),
      satellite: Math.ceil(satellite / OCCUPANCY),
    },
  };
}

/** A draft's ground, and the part it was grown in. */
interface Claimed {
  draft: Draft;
  ground: number[];
  part: number;
}

/** How a region picks its seed among a bulb's free sites, and where its growth is measured from. */
interface Seeding {
  /** The part whose sites may be the seed. */
  part: number;
  /** Candidates nearest it first; growth is keyed from it too until a seed is found. */
  point: Vec3;
  /** When given, the deepest free site first, nearest `point` on ties. */
  depth: Int32Array | null;
  /** Growth keyed by distance to `point` rather than to the seed site. */
  fromPoint: boolean;
}

/**
 * Claims every draft's ground, in order: somebody else's vaults in their
 * lobes, then your lobe projects, then the islands on the satellite, then the
 * hub's drafts, the moated first. Each grows nearest site first from its seed, only over free
 * sites of the parts it may use, and only from a seed whose stretch of such
 * sites holds it whole. Marks `owner` with each region's number, and MOAT
 * round the ones that stand apart.
 */
function claim(cluster: Cluster, lattice: VolumeLattice, plan: Plan, owner: Int32Array): Claimed[] {
  const { count, points, part, offsets, adj } = lattice;
  const all = (1 << PARTS) - 1;
  const bit = (p: number) => 1 << p;

  // Each part's sites, ascending: the candidates for a seed.
  const byPart: number[][] = Array.from({ length: PARTS }, () => []);
  for (let v = 0; v < count; v++) byPart[part[v]!]!.push(v);

  // Scratch for every region, stamped with the region's number rather than
  // cleared: a site belongs to the current region's set when its stamp is the
  // region's own.
  const sized = new Int32Array(count).fill(-1); // met while sizing up a stretch of free ground
  const queued = new Int32Array(count).fill(-1); // on the region's heap
  const queue = new Int32Array(count);
  const heap = new MinHeap(256);
  const claimed: Claimed[] = [];

  const d2 = (v: number, p: Vec3) => {
    const x = points[v * 3]! - p[0];
    const y = points[v * 3 + 1]! - p[1];
    const z = points[v * 3 + 2]! - p[2];
    return x * x + y * y + z * z;
  };

  /** Whether a free site touches anybody else's ground: a moated region keeps one site clear. */
  const touches = (v: number, r: number) => {
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const o = owner[adj[k]!]!;
      if (o >= 0 && o !== r) return true;
    }
    return false;
  };

  /**
   * Grows `d` as the next region. `masks` are the parts it may use, widest
   * last: it widens only once no site of the narrower ones is left free.
   */
  const grow = (d: Draft, masks: readonly number[], seeding: Seeding, regionPart: number) => {
    const r = claimed.length;
    const g = d.ground;
    let mask = masks[0]!;
    let level = 0;
    const allowed = (v: number) =>
      owner[v] === FREE && ((mask >>> part[v]!) & 1) === 1 && !(d.moated && touches(v, r));

    // The seed: the best candidate whose stretch of allowed sites holds the
    // whole region — sized up breadth first, stopping as soon as it does. A
    // stretch too small is skipped whole. Failing every stretch, the
    // candidate of the biggest.
    const { depth, point } = seeding;
    let seed = -1;
    let fallback = -1;
    let fallbackSize = -1;
    for (;;) {
      let best = -1;
      let bestDepth = 0;
      let bestNear = 0;
      for (const v of byPart[seeding.part]!) {
        if (sized[v] === r || !allowed(v)) continue;
        const deep = depth ? depth[v]! : 0;
        const near = d2(v, point);
        if (best < 0 || deep > bestDepth || (deep === bestDepth && near < bestNear)) {
          best = v;
          bestDepth = deep;
          bestNear = near;
        }
      }
      if (best < 0) break;
      let tail = 0;
      sized[best] = r;
      queue[tail++] = best;
      for (let head = 0; head < tail && tail < g; head++) {
        const v = queue[head]!;
        for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
          const w = adj[k]!;
          if (sized[w] === r || !allowed(w)) continue;
          sized[w] = r;
          queue[tail++] = w;
        }
      }
      if (tail >= g) {
        seed = best;
        break;
      }
      if (tail > fallbackSize) {
        fallback = best;
        fallbackSize = tail;
      }
    }
    if (seed < 0) seed = fallback;

    const from: Vec3 =
      seed >= 0 && !seeding.fromPoint
        ? [points[seed * 3]!, points[seed * 3 + 1]!, points[seed * 3 + 2]!]
        : point;
    const ground: number[] = [];
    claimed.push({ draft: d, ground, part: regionPart });
    const offer = (w: number) => {
      if (queued[w] === r || !allowed(w)) return;
      queued[w] = r;
      heap.push(d2(w, from), w);
    };
    heap.clear();
    if (seed >= 0) offer(seed);
    while (ground.length < g) {
      let v = heap.pop();
      if (v < 0) {
        // Hemmed in before it is whole: it carries on from the nearest free
        // site it may use but has not reached, in another piece — counted,
        // never hidden. With none left, it widens to the next parts, from
        // its own edge first.
        let bestKey = Infinity;
        for (let w = 0; w < count; w++) {
          if (queued[w] === r || !allowed(w)) continue;
          const key = d2(w, from);
          if (key < bestKey) {
            v = w;
            bestKey = key;
          }
        }
        if (v < 0) {
          if (++level >= masks.length) break;
          mask = masks[level]!;
          for (const u of ground) {
            for (let k = offsets[u]!; k < offsets[u + 1]!; k++) offer(adj[k]!);
          }
          continue;
        }
        queued[v] = r;
      }
      owner[v] = r;
      ground.push(v);
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) offer(adj[k]!);
    }
    return ground;
  };

  /** Every free site beside `grounds` becomes moat. Returns the sites it took. */
  const moat = (grounds: readonly (readonly number[])[]) => {
    const dug: number[] = [];
    for (const ground of grounds) {
      for (const v of ground) {
        for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
          const w = adj[k]!;
          if (owner[w] !== FREE) continue;
          owner[w] = MOAT;
          dug.push(w);
        }
      }
    }
    return dug;
  };

  /**
   * How the k-th of `count` drafts in a bulb is seeded. One alone grows round
   * the bulb's centre. The first of several leans against the bulb's far
   * side, away from the hub, and grows from there inwards as a cap: grown
   * round the centre instead, it would leave the rest a skin round it too
   * thin to hold them whole. Each after it takes the deepest free pocket left.
   */
  const inBulb = (p: number, bulb: Bulb, count: number, k: number): Seeding => {
    if (k > 0) {
      return {
        part: p,
        point: bulb.centre,
        depth: depthOf(lattice, owner, byPart[p]!, p),
        fromPoint: false,
      };
    }
    const far = add(bulb.centre, scale(unitOf(bulb.centre), bulb.radius));
    return { part: p, point: count > 1 ? far : bulb.centre, depth: null, fromPoint: true };
  };

  // Somebody else's vaults, then your biggest projects, each in its lobe —
  // spilling into its neck and the hub's rim only if it must; a vault's last
  // draft is followed by its moat.
  const lobeOrder = plan.lobes
    .map((lobe, i) => ({ lobe, i }))
    .sort((x, y) => Number(y.lobe.annex) - Number(x.lobe.annex) || x.i - y.i);
  for (const { lobe, i } of lobeOrder) {
    const masks = [bit(lobePart(i)) | bit(neckPart(i)) | bit(PART_HUB), all];
    const first = claimed.length;
    lobe.drafts.forEach((d, k) => {
      const seeding = inBulb(lobePart(i), cluster.lobes[i]!, lobe.drafts.length, k);
      grow(d, masks, seeding, lobePart(i));
    });
    if (lobe.annex) moat(claimed.slice(first).map((c) => c.ground));
  }

  // The islands, on the satellite, a moat round each of several.
  const satellite = cluster.satellite;
  if (satellite) {
    const masks = [bit(PART_SATELLITE), all];
    const several = plan.islands.length > 1;
    plan.islands.forEach((d, k) => {
      const seeding = inBulb(PART_SATELLITE, satellite, plan.islands.length, k);
      const ground = grow(d, masks, seeding, PART_SATELLITE);
      if (several) moat([ground]);
    });
  }

  // The hub's drafts, the moated first, each biggest first. The moated ones
  // lean against the hub's surface as caps, each on the side most open — as
  // far as can be from the necks, from every cap before it and from the side
  // kept for the first unmoated one — so each keeps its moat on its inner
  // face only: round a core, a moat would take a whole shell, and leave the
  // rest a skin. The first unmoated one leans against a fixed side, away from
  // the satellite, as a cap too, and the rest take the deepest free pocket
  // left: the deepest free hub site, by hops to anything taken or to the
  // surface, kept up to date after every claim. A draft alone in the hub
  // grows round its centre. Necks stay open as mouths for the threads through
  // them, used only once the hub is full.
  const depth = depthOf(lattice, owner, byPart[PART_HUB]!, PART_HUB);
  let necks = 0;
  for (let i = 0; i < cluster.lobes.length; i++) necks |= bit(neckPart(i));
  const masks = [bit(PART_HUB), bit(PART_HUB) | necks, all];
  const side = satellite ? scale(unitOf(satellite.centre), -1) : formDirection(HUB_HOME);
  const away: Vec3[] = [side, ...cluster.lobes.map((l) => unitOf(l.centre))];
  const several = plan.hub.length > 1;
  const capped = several ? plan.hub.find((d) => !d.moated) : undefined;
  const cap = (dir: Vec3): Seeding => ({
    part: PART_HUB,
    point: scale(dir, cluster.hub.radius),
    depth: null,
    fromPoint: true,
  });
  for (const d of plan.hub) {
    let seeding: Seeding = { part: PART_HUB, point: cluster.centre, depth, fromPoint: false };
    if (d === capped) seeding = cap(side);
    else if (d.moated && several) {
      const dir = openDirection(away);
      away.push(dir);
      seeding = cap(dir);
    }
    const ground = grow(d, masks, seeding, PART_HUB);
    shallower(lattice, owner, depth, PART_HUB, ground, d.moated ? moat([ground]) : []);
  }
  return claimed;
}

/**
 * Per free site of part `p`: lattice hops to the nearest site that is not a
 * free site of `p`, or to the surface (a site with fewer than twelve
 * neighbours). Breadth first from every such edge at once.
 */
function depthOf(
  lattice: VolumeLattice,
  owner: Int32Array,
  sites: readonly number[],
  p: number,
): Int32Array {
  const { count, part, offsets, adj } = lattice;
  const depth = new Int32Array(count).fill(-1);
  const open = (v: number) => owner[v] === FREE && part[v] === p;
  const queue: number[] = [];
  for (const v of sites) {
    if (!open(v)) continue;
    let edge = offsets[v + 1]! - offsets[v]! < 12;
    for (let k = offsets[v]!; k < offsets[v + 1]! && !edge; k++) edge = !open(adj[k]!);
    if (!edge) continue;
    depth[v] = 0;
    queue.push(v);
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = adj[k]!;
      if (!open(w) || depth[w]! >= 0) continue;
      depth[w] = depth[v]! + 1;
      queue.push(w);
    }
  }
  return depth;
}

/**
 * `depth` after the sites of `taken` stopped being free: lowered breadth first
 * from them, going on only while it lowers something. Taking ground only ever
 * brings an edge nearer, so this is exactly what `depthOf` would now say.
 */
function shallower(
  lattice: VolumeLattice,
  owner: Int32Array,
  depth: Int32Array,
  p: number,
  ...taken: readonly (readonly number[])[]
): void {
  const { part, offsets, adj } = lattice;
  const open = (v: number) => owner[v] === FREE && part[v] === p;
  const queue: number[] = [];
  for (const list of taken) {
    for (const u of list) {
      depth[u] = -1;
      for (let k = offsets[u]!; k < offsets[u + 1]!; k++) {
        const w = adj[k]!;
        if (!open(w) || depth[w] === 0) continue;
        depth[w] = 0;
        queue.push(w);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    const next = depth[v]! + 1;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = adj[k]!;
      if (!open(w) || depth[w]! <= next) continue;
      depth[w] = next;
      queue.push(w);
    }
  }
}

/** What `settle` places: notes (by their index in the draft) and their sites, the heart first. */
interface Settled {
  notes: number[];
  sites: number[];
  centre: number;
}

/** One note to place, by its index in the draft, the note it hangs off (-1: none) and its folder (-1: the heart's own). */
interface Step {
  note: number;
  parent: number;
  folder: number;
}

/**
 * Places a region's notes on its ground: its index on the ground's medoid,
 * the notes of its own folder round it, each folder below in a cone out from
 * it, every note beside the one it was reached from. A note only ever takes a
 * site next to one already taken, so the notes stay in one piece.
 */
function settle(
  lattice: VolumeLattice,
  d: Draft,
  ground: readonly number[],
  region: number,
  owner: Int32Array,
  slot: Int32Array,
): Settled {
  const { points, offsets, adj } = lattice;
  const a = lattice.spacing;
  const out: Settled = { notes: [], sites: [], centre: ground[0] ?? 0 };
  if (ground.length === 0) return out;
  ground.forEach((v, k) => (slot[v] = k));
  const centre = medoidOf(points, ground);
  out.centre = centre;

  const { steps, folders } = stepsOf(d);

  // Each folder's direction out from the heart, on a Fibonacci sphere turned
  // by the project's hash, and the half-angle of a cone holding its share of
  // the sphere: one folder alone gets all of it, and no pull.
  let total = 0;
  for (const size of folders) total += size;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spin = 2 * Math.PI * hash01(d.key);
  const cones = folders.map((size, i) => {
    const y = 1 - (2 * (i + 0.5)) / folders.length;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden + spin;
    const cosHalf = Math.max(-1, Math.min(1, 1 - (2 * size) / total));
    return {
      dir: [ring * Math.cos(phi), y, ring * Math.sin(phi)] as Vec3,
      half: Math.acos(cosHalf),
      cosHalf,
    };
  });

  // How far out each site is from the heart, in spacings, and which way.
  const hx = points[centre * 3]!;
  const hy = points[centre * 3 + 1]!;
  const hz = points[centre * 3 + 2]!;
  const far = new Float64Array(ground.length);
  const dir = new Float64Array(ground.length * 3);
  let rim = 0;
  ground.forEach((v, k) => {
    const x = points[v * 3]! - hx;
    const y = points[v * 3 + 1]! - hy;
    const z = points[v * 3 + 2]! - hz;
    const l = Math.sqrt(x * x + y * y + z * z);
    far[k] = l / a;
    if (l > 0) dir.set([x / l, y / l, z / l], k * 3);
    rim = Math.max(rim, far[k]!);
  });
  /** How far, radians, ground site `k` lies outside folder `f`'s cone. */
  const outside = (k: number, f: number) => {
    const c = cones[f]!;
    const cos = dir[k * 3]! * c.dir[0] + dir[k * 3 + 1]! * c.dir[1] + dir[k * 3 + 2]! * c.dir[2];
    // Inside the cone without an arccosine: most of the frontier is.
    if (cos >= c.cosHalf) return 0;
    return Math.max(0, Math.acos(Math.max(-1, cos)) - c.half);
  };

  // Placing, each note on the free site next to the notes already placed
  // that costs least: near the note it hangs off, inside its folder's cone,
  // and drawn in a little towards the heart.
  const taken = new Uint8Array(ground.length);
  const edge = new Uint8Array(ground.length);
  const frontier: number[] = [];
  const siteOfNote = new Int32Array(d.notes.length).fill(-1);
  const take = (note: number, v: number) => {
    taken[slot[v]!] = 1;
    siteOfNote[note] = v;
    out.notes.push(note);
    out.sites.push(v);
    for (let j = offsets[v]!; j < offsets[v + 1]!; j++) {
      const w = adj[j]!;
      if (owner[w] !== region) continue;
      const kw = slot[w]!;
      if (taken[kw] || edge[kw]) continue;
      edge[kw] = 1;
      frontier.push(w);
    }
  };
  take(steps[0]!.note, centre);

  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let s = 1; s < steps.length; s++) {
    const { parent, folder } = steps[s]!;
    const from = parent >= 0 ? siteOfNote[parent]! : -1;
    if (from >= 0) {
      ax = points[from * 3]!;
      ay = points[from * 3 + 1]!;
      az = points[from * 3 + 2]!;
    } else if (folder >= 0) {
      // A folder's first note aims part way out along the middle of its cone.
      const c = cones[folder]!.dir;
      const reach = HUB_OUT * rim * a;
      ax = hx + c[0] * reach;
      ay = hy + c[1] * reach;
      az = hz + c[2] * reach;
    } else {
      ax = hx;
      ay = hy;
      az = hz;
    }

    let pool = frontier;
    if (pool.length === 0) {
      // Every site beside the notes is taken but ground is left elsewhere:
      // only a region that grew in pieces gets here.
      pool = ground.filter((_, k) => !taken[k]);
      if (pool.length === 0) break;
    }
    let best = -1;
    let bestCost = Infinity;
    for (const v of pool) {
      const k = slot[v]!;
      const x = points[v * 3]! - ax;
      const y = points[v * 3 + 1]! - ay;
      const z = points[v * 3 + 2]! - az;
      let cost = Math.sqrt(x * x + y * y + z * z) / a + INWARD * far[k]!;
      if (folder >= 0) cost += WEDGE_PULL * outside(k, folder) * far[k]!;
      if (cost < bestCost || (cost === bestCost && v < best)) {
        best = v;
        bestCost = cost;
      }
    }
    if (pool === frontier) {
      const i = frontier.indexOf(best);
      frontier[i] = frontier[frontier.length - 1]!;
      frontier.pop();
    }
    take(steps[s]!.note, best);
  }

  for (const v of ground) slot[v] = -1;
  return out;
}

/**
 * The ground's medoid: the site with the least summed distance to every
 * other, ties to the smaller site — the middle of a region whatever its shape,
 * and always one of its own sites. Summed in ascending site order, so the same
 * ground always gives the same sums. A big ground looks among the sites
 * nearest its centroid only.
 */
function medoidOf(points: Float64Array, ground: readonly number[]): number {
  const sites = Int32Array.from(ground).sort();
  let candidates = sites;
  if (sites.length > MEDOID_ALL) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of sites) {
      cx += points[v * 3]!;
      cy += points[v * 3 + 1]!;
      cz += points[v * 3 + 2]!;
    }
    cx /= sites.length;
    cy /= sites.length;
    cz /= sites.length;
    const near = Array.from(sites, (v) => {
      const x = points[v * 3]! - cx;
      const y = points[v * 3 + 1]! - cy;
      const z = points[v * 3 + 2]! - cz;
      return [x * x + y * y + z * z, v] as const;
    });
    near.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    candidates = Int32Array.from(near.slice(0, MEDOID_NEAR), ([, v]) => v).sort();
  }
  let centre = candidates[0]!;
  let least = Infinity;
  for (const v of candidates) {
    const x = points[v * 3]!;
    const y = points[v * 3 + 1]!;
    const z = points[v * 3 + 2]!;
    let sum = 0;
    for (const w of sites) {
      const dx = points[w * 3]! - x;
      const dy = points[w * 3 + 1]! - y;
      const dz = points[w * 3 + 2]! - z;
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    if (sum < least) {
      least = sum;
      centre = v;
    }
  }
  return centre;
}

/**
 * The order a region's notes are placed in, each with the note it hangs off,
 * and the size of each folder below its own, biggest first. The heart first:
 * its shallowest index, or failing one the note with most threads in the
 * project. Then the notes of the project's own folder, breadth first over the
 * threads from the heart. Then each folder below it, biggest first: its own
 * index or else its oldest note, then breadth first over the folder's
 * threads, then any it did not reach, oldest first.
 *
 * Folders are read below the directory every note of the project shares, not
 * below the vault's top folder: a project is a tag, a MOC's folder or a top
 * folder (`projects.ts` on the server), and only the shared directory is the
 * project's own whichever it is.
 *
 * Notes go by their index in the draft, which is id order, so "then by id"
 * is "then the smaller index".
 */
function stepsOf(d: Draft): { steps: Step[]; folders: number[] } {
  const { notes, base } = d;
  const count = notes.length;
  const links: number[][] = Array.from({ length: count }, () => []);
  for (const t of d.within) {
    links[t.ra - base]!.push(t.rb - base);
    links[t.rb - base]!.push(t.ra - base);
  }
  const older = (x: number, y: number) => byAge(notes[x]!, notes[y]!);
  for (const list of links) if (list.length > 1) list.sort(older);
  const segments = notes.map((n) => n.path.split('/').slice(0, -1));
  /** The least deep of `list` (ascending), the first on ties; -1 for none. */
  const shallowest = (list: readonly number[]) => {
    let best = -1;
    for (const i of list) if (best < 0 || segments[i]!.length < segments[best]!.length) best = i;
    return best;
  };
  /** The oldest of `list`. */
  const oldest = (list: readonly number[]) => {
    let best = list[0]!;
    for (const i of list) if (older(i, best) < 0) best = i;
    return best;
  };
  const indexes = (list: readonly number[]) => list.filter((i) => notes[i]!.isIndex);

  const everyone = Array.from({ length: count }, (_, i) => i);
  let heart = shallowest(indexes(everyone));
  if (heart < 0) {
    heart = 0;
    for (let i = 1; i < count; i++) {
      const more = links[i]!.length - links[heart]!.length;
      if (more > 0 || (more === 0 && older(i, heart) < 0)) heart = i;
    }
  }

  let shared = segments[0]!;
  for (const s of segments) {
    let k = 0;
    while (k < shared.length && k < s.length && shared[k] === s[k]) k++;
    shared = shared.slice(0, k);
  }
  const groups = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    if (i !== heart) listAt(groups, segments[i]![shared.length] ?? '').push(i);
  }

  const steps: Step[] = [{ note: heart, parent: -1, folder: -1 }];
  const pending = new Uint8Array(count);
  /** Breadth first from `start` over threads to `members`, then whatever it missed, oldest first. */
  const spread = (start: number, members: readonly number[], folder: number, root: number) => {
    for (const i of members) pending[i] = 1;
    pending[start] = 0;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const n = queue[head]!;
      for (const m of links[n]!) {
        if (!pending[m]) continue;
        pending[m] = 0;
        steps.push({ note: m, parent: n, folder });
        queue.push(m);
      }
    }
    for (const m of members.filter((i) => pending[i]).sort(older)) {
      pending[m] = 0;
      steps.push({ note: m, parent: root, folder });
    }
  };
  spread(heart, groups.get('') ?? [], -1, heart);

  const below = [...groups.entries()]
    .filter(([f]) => f !== '')
    .sort(([fx, x], [fy, y]) => y.length - x.length || byKey(fx, fy));
  const folders: number[] = [];
  for (const [, list] of below) {
    const folder = folders.length;
    folders.push(list.length);
    const first = shallowest(indexes(list));
    const hub = first >= 0 ? first : oldest(list);
    steps.push({ note: hub, parent: -1, folder });
    spread(hub, list, folder, hub);
  }
  return { steps, folders };
}

/** Pieces a region's notes fall in beyond the first, over the lattice's neighbours. */
function piecesOf(lattice: VolumeLattice, sites: readonly number[], slot: Int32Array): number {
  if (sites.length === 0) return 0;
  const { offsets, adj } = lattice;
  sites.forEach((v, k) => (slot[v] = k));
  const seen = new Uint8Array(sites.length);
  let pieces = 0;
  for (let k = 0; k < sites.length; k++) {
    if (seen[k]) continue;
    pieces++;
    seen[k] = 1;
    const queue = [sites[k]!];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      for (let j = offsets[v]!; j < offsets[v + 1]!; j++) {
        const w = adj[j]!;
        const kw = slot[w]!;
        if (kw < 0 || seen[kw]) continue;
        seen[kw] = 1;
        queue.push(w);
      }
    }
  }
  for (const v of sites) slot[v] = -1;
  return pieces - 1;
}

/**
 * Where each note stands, by rank, xyz: its site, moved a little off it in a
 * direction and by an amount fixed per site, so the cluster does not read as a
 * grid. Notes go in site order; each takes the whole offset, or a half or a
 * quarter of it, if that keeps it inside the form and three quarters of a
 * spacing from every neighbour already moved, else stays on its site. Offsets
 * only ever shrink, so standing on its site always clears a neighbour: sites
 * are a spacing apart, and the neighbour is a quarter of one off its own at
 * the most. A note with no site stays at 0.
 */
function jitter(cluster: Cluster, lattice: VolumeLattice, siteOfRank: Int32Array): Float32Array {
  const { count, points, offsets, adj } = lattice;
  const a = lattice.spacing;
  const inside = -NOTE_INSET * a;
  const gap = MIN_GAP * a * MIN_GAP * a;
  const rankAt = new Int32Array(count).fill(-1);
  siteOfRank.forEach((v, k) => {
    if (v >= 0) rankAt[v] = k;
  });
  const at = new Float64Array(count * 3);
  const moved = new Uint8Array(count);
  const out: Probe = { d: 0, part: 0 };
  const positions = new Float32Array(siteOfRank.length * 3);
  for (let v = 0; v < count; v++) {
    const k = rankAt[v]!;
    if (k < 0) continue;
    // A direction uniform over the sphere, and a reach uniform over the ball.
    const up = 2 * scatter(v, 1) - 1;
    const phi = 2 * Math.PI * scatter(v, 2);
    const reach = JITTER * a * Math.cbrt(scatter(v, 3));
    const ring = Math.sqrt(Math.max(0, 1 - up * up));
    const ox = reach * ring * Math.cos(phi);
    const oy = reach * up;
    const oz = reach * ring * Math.sin(phi);
    let x = points[v * 3]!;
    let y = points[v * 3 + 1]!;
    let z = points[v * 3 + 2]!;
    for (const s of [1, 0.5, 0.25]) {
      const px = x + s * ox;
      const py = y + s * oy;
      const pz = z + s * oz;
      if (probe(cluster, px, py, pz, out).d > inside) continue;
      let clear = true;
      for (let j = offsets[v]!; j < offsets[v + 1]! && clear; j++) {
        const u = adj[j]!;
        if (!moved[u]) continue;
        const dx = at[u * 3]! - px;
        const dy = at[u * 3 + 1]! - py;
        const dz = at[u * 3 + 2]! - pz;
        clear = dx * dx + dy * dy + dz * dz >= gap;
      }
      if (!clear) continue;
      x = px;
      y = py;
      z = pz;
      break;
    }
    at[v * 3] = x;
    at[v * 3 + 1] = y;
    at[v * 3 + 2] = z;
    moved[v] = 1;
    positions[k * 3] = x;
    positions[k * 3 + 1] = y;
    positions[k * 3 + 2] = z;
  }
  return positions;
}

/**
 * The route from the note of rank `ra` to the note of rank `rb` (their
 * positions in `at`): a quadratic bezier whose control point sits `bow` of
 * its length off the middle of the chord, sampled into at most MAX_SEGMENTS
 * straight pieces, first and last points exactly its notes. Between parts of
 * the form it bows towards the centre, so a journey from a lobe curves
 * through the crossroads rather than across the open space between bulbs —
 * but never past it. Within a part it bows a way fixed per pair of sites, so
 * threads that cross do not meet.
 */
function route(
  at: Float32Array,
  ra: number,
  rb: number,
  bow: number,
  across: boolean,
  spin: number,
  unit: number,
): Float32Array {
  const ax = at[ra * 3]!;
  const ay = at[ra * 3 + 1]!;
  const az = at[ra * 3 + 2]!;
  const bx = at[rb * 3]!;
  const by = at[rb * 3 + 1]!;
  const bz = at[rb * 3 + 2]!;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) return Float32Array.of(ax, ay, az, bx, by, bz);
  const tx = dx / length;
  const ty = dy / length;
  const tz = dz / length;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const mz = (az + bz) / 2;

  let wx = 0;
  let wy = 0;
  let wz = 0;
  let off = bow * length;
  let toward = false;
  if (across) {
    // The way to the centre, square to the chord. The curve's middle moves
    // half the control point's offset, so capping that at twice the distance
    // keeps the middle from overshooting the centre's side.
    const along = -(mx * tx + my * ty + mz * tz);
    const px = -mx - along * tx;
    const py = -my - along * ty;
    const pz = -mz - along * tz;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl >= 1e-6 * length) {
      wx = px / pl;
      wy = py / pl;
      wz = pz / pl;
      off = Math.min(off, 2 * pl);
      toward = true;
    }
  }
  if (!toward) {
    // e1 = t̂ × ŷ, or t̂ × x̂ for a chord nearly upright; e2 = t̂ × e1.
    let e1x = -tz;
    let e1y = 0;
    let e1z = tx;
    if (Math.abs(ty) > 0.9) {
      e1x = 0;
      e1y = tz;
      e1z = -ty;
    }
    const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
    e1x /= l1;
    e1y /= l1;
    e1z /= l1;
    const e2x = ty * e1z - tz * e1y;
    const e2y = tz * e1x - tx * e1z;
    const e2z = tx * e1y - ty * e1x;
    const c = Math.cos(2 * Math.PI * spin);
    const s = Math.sin(2 * Math.PI * spin);
    wx = c * e1x + s * e2x;
    wy = c * e1y + s * e2y;
    wz = c * e1z + s * e2z;
  }
  const cx = mx + wx * off;
  const cy = my + wy * off;
  const cz = mz + wz * off;

  const n = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(length / (ROUTE_STEP * unit))));
  const line = new Float32Array((n + 1) * 3);
  line[0] = ax;
  line[1] = ay;
  line[2] = az;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const u = 1 - t;
    line[i * 3] = u * u * ax + 2 * t * u * cx + t * t * bx;
    line[i * 3 + 1] = u * u * ay + 2 * t * u * cy + t * t * by;
    line[i * 3 + 2] = u * u * az + 2 * t * u * cz + t * t * bz;
  }
  line[n * 3] = bx;
  line[n * 3 + 1] = by;
  line[n * 3 + 2] = bz;
  return line;
}

/** The list under `key`, made empty the first time. */
function listAt<K, T>(map: Map<K, T[]>, key: K): T[] {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  return list;
}

const add = (u: Vec3, v: Vec3): Vec3 => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const unitOf = (v: Vec3): Vec3 => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
