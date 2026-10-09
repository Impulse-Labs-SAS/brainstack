// The form Crawl's dormant network fills: a hub sphere with lobes round it,
// each joined to the hub by a short neck, smooth-unioned so the silhouette
// reads as a bunch from afar and every neck flares into its bulbs. Pure
// geometry — sizes, a signed distance, which part a point is in — so the
// layout over it is tested in Node.
//
// The form is sized from the data, as the brain is (`brainScaleFor`): every
// part is a ball holding as many lattice sites as it is asked for, so the
// volume grows with the vault and the density of notes, and of threads, holds.
// The biggest projects each get a lobe of their own; the hub holds the rest
// and is the crossroads, so a journey between projects runs through it. The
// island floats apart on a satellite with no neck: reaching it crosses open
// space, and the gap says so before the walk does.
//
// Distances are in world units and measured against the lattice's spacing
// `a`. A part's radius is the ball that holds its sites, plus the inset that
// keeps every site inside the surface; a lobe's centre sits on a site (fcc.ts)
// so its first shell is whole.

import type { Vec3 } from '../../vec';

import { nearestSite } from './fcc';

/** The most lobes a cluster grows: the cube's eight diagonals. */
export const MAX_LOBES = 8;
/** Sites stay this many spacings inside the surface, so no crystal pokes through the cage. */
export const SITE_INSET = 0.35;
/** The cage sits this many spacings outside the surface (cage.ts). */
export const CAGE_OUT = 0.3;
/** Open space between the satellite's surface and any other bulb's, spacings: about five creature units. */
export const ISLAND_GAP = 3;
/** A neck's radius is at most this share of the smaller of its lobe's and the hub's: a lobe stays a bulb. */
export const NECK_MAX = 0.75;

/** Part numbers, one per site (lattice.ts `part`): they fit an Int8Array. */
export const PART_HUB = 0;
export const PART_SATELLITE = 1;
export const lobePart = (i: number): number => 2 + i;
export const neckPart = (i: number): number => 2 + MAX_LOBES + i;
export const PARTS = 2 + 2 * MAX_LOBES;

/** The least a hub is, spacings: a hub alone, even for an empty vault, still has sites and a cage. */
const HUB_MIN = 1.5;
/** The least a lobe or the satellite is, spacings. */
const LOBE_MIN_R = 1.5;
/** A lobe's centre sits its radius times this beyond the hub's surface, plus the neck's gap: the approved sketch. */
const LOBE_SINK = 0.7;
/** The neck's gap, as a share of the hub's radius (the sketch's 0.16 against a hub of 0.44), and its least, spacings. */
const NECK_GAP = 0.36;
const NECK_GAP_MIN = 0.5;
/** A neck's radius is at least this share of its lobe's, so a big lobe's neck carries its threads. */
const NECK_SHARE = 0.4;
/** Smooth-min width, spacings: how far a neck flares into the bulbs it joins. */
const BLEND = 0.75;
/**
 * The hub is never under this many times its biggest lobe's radius. Only a
 * shared vault bigger than your own gets near it: its lobe would otherwise
 * swallow part of the hub.
 */
const HUB_OVER_LOBE = 1.1;
/** How far the satellite steps out at a time, spacings, until it clears everything else, and how many steps at most. */
const SATELLITE_STEP = 0.25;
const SATELLITE_STEPS = 400;
/** Where the satellite goes when there are no lobes to keep clear of, before the form's turn. */
const SATELLITE_AWAY: Vec3 = [0.85, -0.3, -0.45];

export interface Bulb {
  /** World units. */
  centre: Vec3;
  radius: number;
}

export interface Neck {
  /** The capsule's axis, hub centre to lobe centre, and its radius, world units. */
  from: Vec3;
  to: Vec3;
  radius: number;
}

export interface Cluster {
  /** World units between neighbouring sites: every size here is measured against it. */
  spacing: number;
  hub: Bulb;
  /** Biggest first; `necks[i]` joins `lobes[i]` to the hub. */
  lobes: readonly Bulb[];
  necks: readonly Neck[];
  satellite: Bulb | null;
  /** Smooth-min width where a neck meets a bulb, world units. */
  blend: number;
  /** The hub's centre: the layout's origin, [0, 0, 0]. */
  centre: Vec3;
  /** Everything (bulbs and the cage over them) lies within this of the centre, world units. */
  radius: number;
  /** Per lobe, packed for `probe`: cx, cy, cz, r, neck r, |axis|² — 6 floats a lobe. Read-only. */
  readonly packed: Float64Array;
}

/** Sites each part must hold. */
export interface ClusterNeeds {
  hub: number;
  /** Biggest first. */
  lobes: readonly number[];
  /** 0: no satellite. */
  satellite: number;
}

export interface ClusterOptions {
  /** World units between neighbouring sites. */
  spacing: number;
  /** The least a neck is across, in spacings. */
  neck: number;
  /**
   * Per part number, how much bigger than its need says to draw it: the
   * lattice's rounding at the surface, made up by layout.ts. 1 when absent.
   */
  boost?: ArrayLike<number>;
}

/** What `probe` writes: the signed distance (negative inside) and the part the point is deepest in. */
export interface Probe {
  d: number;
  part: number;
}

/** A rotation from Euler angles, x then y then z (three's 'XYZ'), row-major 3 × 3. */
function euler(x: number, y: number, z: number): number[] {
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(x),
    Math.sin(x),
    Math.cos(y),
    Math.sin(y),
    Math.cos(z),
    Math.sin(z),
  ];
  return [
    cy * cz,
    -cy * sz,
    sy,
    cx * sz + sx * sy * cz,
    cx * cz - sx * sy * sz,
    -sx * cy,
    sx * sz - cx * sy * cz,
    sx * cz + cx * sy * sz,
    cx * cy,
  ];
}

/**
 * The form's fixed turn, applied to every lobe and satellite direction: from
 * the lab's opening view (yaw 0.5, pitch 0.3) no lobe sits straight behind or
 * in front of the hub. A constant, tuned by eye, so the layout stays a pure
 * function of the vault.
 */
const FORM_TURN: readonly number[] = euler(0.42, 0, 0.31);

/** A direction in the form's frame: `v` turned by FORM_TURN, unit length. */
export function formDirection(v: Vec3): Vec3 {
  const m = FORM_TURN;
  const x = m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2];
  const y = m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2];
  const z = m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2];
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const S3 = Math.sqrt(3) / 2;
const TRIANGLE: Vec3[] = [
  [1, 0, 0],
  [-0.5, 0, S3],
  [-0.5, 0, -S3],
];
/** Five round the equator, 72° apart. */
const PENTAGON: Vec3[] = [0, 1, 2, 3, 4].map((k): Vec3 => {
  const a = (2 * Math.PI * k) / 5;
  return [Math.cos(a), 0, Math.sin(a)];
});
/**
 * The lobes' directions for each count, biggest lobe first: the spreads that
 * keep the closest two furthest apart (Thomson's problem), except eight, which
 * is the cube's diagonals — the cluster the user chose.
 */
const SPREADS: readonly (readonly Vec3[])[] = [
  [],
  [[0, 1, 0]],
  [
    [0, 1, 0],
    [0, -1, 0],
  ],
  TRIANGLE,
  [
    [1, 1, 1],
    [-1, 1, -1],
    [1, -1, -1],
    [-1, -1, 1],
  ],
  [[0, 1, 0], [0, -1, 0], ...TRIANGLE],
  [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  [[0, 1, 0], [0, -1, 0], ...PENTAGON],
  [
    [1, 1, 1],
    [-1, 1, -1],
    [1, 1, -1],
    [-1, 1, 1],
    [1, -1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [-1, -1, -1],
  ],
];

/** Unit directions for `count` lobes (at most MAX_LOBES), biggest first, before the form's turn. */
export function lobeDirections(count: number): Vec3[] {
  return SPREADS[Math.max(0, Math.min(MAX_LOBES, Math.floor(count)))]!.map(unit);
}

/**
 * Where the satellite goes: the widest open sky between the lobes. With no
 * lobes, to the right of and a little below the opening view.
 */
export function satelliteDirection(lobes: readonly Vec3[]): Vec3 {
  return lobes.length === 0 ? unit(SATELLITE_AWAY) : openDirection(lobes);
}

/**
 * Of the cube's 26 directions (its faces, edges and corners, turned like the
 * lobes, in a fixed order), the one whose least angle to every direction in
 * `away` (unit length, at least one) is largest — the widest open sky — ties
 * to the first.
 */
export function openDirection(away: readonly Vec3[]): Vec3 {
  let best: Vec3 = [0, 0, 0];
  let bestNear = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        if (i === 0 && j === 0 && k === 0) continue;
        const d = formDirection([i, j, k]);
        // The nearest by the largest cosine: no arccosine per pair.
        let near = -Infinity;
        for (const a of away) near = Math.max(near, d[0] * a[0] + d[1] * a[1] + d[2] * a[2]);
        if (near < bestNear) {
          bestNear = near;
          best = d;
        }
      }
    }
  }
  return best;
}

/** A ball's radius holding `sites` FCC sites `spacing` apart: cbrt(3·sites·a³/√2 / 4π). */
export function ballRadius(sites: number, spacing: number): number {
  if (!(sites > 0)) return 0;
  return Math.cbrt((3 * sites * spacing * spacing * spacing) / Math.SQRT2 / (4 * Math.PI));
}

/** The cluster that holds `needs`, every part a ball of its sites, the lobes on necks round the hub. */
export function clusterFor(needs: ClusterNeeds, opts: ClusterOptions): Cluster {
  const a = opts.spacing;
  const boost = (p: number) => opts.boost?.[p] ?? 1;
  const blend = BLEND * a;
  const count = Math.min(MAX_LOBES, needs.lobes.length);

  const radii = needs.lobes
    .slice(0, count)
    .map(
      (n, i) => (Math.max(LOBE_MIN_R * a, ballRadius(n, a)) + SITE_INSET * a) * boost(lobePart(i)),
    );
  let hubR = (Math.max(HUB_MIN * a, ballRadius(needs.hub, a)) + SITE_INSET * a) * boost(PART_HUB);
  for (const r of radii) hubR = Math.max(hubR, HUB_OVER_LOBE * r);

  // Each lobe a little more than its radius out past the hub, across the
  // neck's gap, its centre on a site.
  const gap = Math.max(NECK_GAP_MIN * a, NECK_GAP * hubR);
  const dirs = lobeDirections(count).map(formDirection);
  const reach = radii.map((r) => hubR + LOBE_SINK * r + gap);
  const place = (stretch: number) =>
    dirs.map((d, i) => nearestSite(scale(d, reach[i]! * stretch), a));
  let centres = place(1);

  // A small hub with many lobes round it puts neighbouring lobes too close to
  // read as bulbs: every lobe then moves out by one common factor, the least
  // that clears every pair by both blends, with room for each centre to snap
  // to its site twice (a/√2 each). The necks lengthen; nothing else changes.
  const clear = (i: number, j: number) => radii[i]! + radii[j]! + 2 * blend;
  let crowded = false;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (distance(centres[i]!, centres[j]!) < clear(i, j)) crowded = true;
    }
  }
  if (crowded) {
    let stretch = 1;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const apart = distance(scale(dirs[i]!, reach[i]!), scale(dirs[j]!, reach[j]!));
        stretch = Math.max(stretch, (clear(i, j) + 1.5 * a) / apart);
      }
    }
    centres = place(stretch);
  }

  const lobes: Bulb[] = centres.map((centre, i) => ({ centre, radius: radii[i]! }));
  const necks: Neck[] = centres.map((centre, i) => ({
    from: [0, 0, 0],
    to: centre,
    radius: Math.min(
      NECK_MAX * Math.min(radii[i]!, hubR),
      Math.max((opts.neck * a) / 2, NECK_SHARE * radii[i]!),
    ),
  }));
  const packed = new Float64Array(count * 6);
  centres.forEach((c, i) => {
    packed.set([c[0], c[1], c[2], radii[i]!, necks[i]!.radius, dot(c, c)], i * 6);
  });

  const centre: Vec3 = [0, 0, 0];
  const hub: Bulb = { centre, radius: hubR };
  let radius = hubR;
  for (const l of lobes) radius = Math.max(radius, length(l.centre) + l.radius);
  const form: Cluster = {
    spacing: a,
    hub,
    lobes,
    necks,
    satellite: null,
    blend,
    centre,
    radius: radius + CAGE_OUT * a,
    packed,
  };
  if (!(needs.satellite > 0)) return form;

  // The satellite, out along the widest open sky until everything else —
  // hub, necks, lobes, blended — is the island's gap clear of it. The quarter
  // blend covers the smooth-min's bulge; the test is on the centre after it
  // snaps to its site, so the snap never eats into the gap.
  const rs =
    (Math.max(LOBE_MIN_R * a, ballRadius(needs.satellite, a)) + SITE_INSET * a) *
    boost(PART_SATELLITE);
  const s = satelliteDirection(dirs);
  const wanted = rs + ISLAND_GAP * a + blend / 4;
  const out: Probe = { d: 0, part: 0 };
  let reachS = hubR + rs + ISLAND_GAP * a;
  let at = nearestSite(scale(s, reachS), a);
  for (let step = 0; step < SATELLITE_STEPS; step++) {
    if (probe(form, at[0], at[1], at[2], out).d >= wanted) break;
    reachS += SATELLITE_STEP * a;
    at = nearestSite(scale(s, reachS), a);
  }
  return {
    ...form,
    satellite: { centre: at, radius: rs },
    radius: Math.max(radius, length(at) + rs) + CAGE_OUT * a,
  };
}

/** Polynomial smooth minimum, as the brain's (graph-brain.ts): min − h²k/4. */
function smin(x: number, y: number, k: number): number {
  const h = Math.max(k - Math.abs(x - y), 0) / k;
  return Math.min(x, y) - h * h * k * 0.25;
}

/**
 * The signed distance at (x, y, z), negative inside, and the part the point
 * is deepest in: the primitive — hub, lobe, neck or satellite — whose own
 * distance there is least. That labels the funnel at each neck's mouth, a
 * little way into the hub and the lobe along the axis, as neck: the layout
 * never grows a hub project there, so every neck keeps an open mouth for the
 * threads through it. Allocates nothing: it runs for every candidate site.
 */
export function probe(c: Cluster, x: number, y: number, z: number, out: Probe): Probe {
  const k = c.blend;
  const lobes = c.packed;
  let d = Math.sqrt(x * x + y * y + z * z) - c.hub.radius;
  let best = d;
  let part = PART_HUB;
  for (let i = 0, o = 0; o < lobes.length; i++, o += 6) {
    const cx = lobes[o]!;
    const cy = lobes[o + 1]!;
    const cz = lobes[o + 2]!;
    // The neck: a capsule from the hub's centre to the lobe's.
    let t = (x * cx + y * cy + z * cz) / lobes[o + 5]!;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const nx = x - cx * t;
    const ny = y - cy * t;
    const nz = z - cz * t;
    const dn = Math.sqrt(nx * nx + ny * ny + nz * nz) - lobes[o + 4]!;
    const lx = x - cx;
    const ly = y - cy;
    const lz = z - cz;
    const dl = Math.sqrt(lx * lx + ly * ly + lz * lz) - lobes[o + 3]!;
    if (dl < best) {
      best = dl;
      part = lobePart(i);
    }
    if (dn < best) {
      best = dn;
      part = neckPart(i);
    }
    d = smin(d, smin(dn, dl, k), k);
  }
  const s = c.satellite;
  if (s) {
    const sx = x - s.centre[0];
    const sy = y - s.centre[1];
    const sz = z - s.centre[2];
    // No blend: it stands apart.
    const ds = Math.sqrt(sx * sx + sy * sy + sz * sz) - s.radius;
    if (ds < best) part = PART_SATELLITE;
    if (ds < d) d = ds;
  }
  out.d = d;
  out.part = part;
  return out;
}

const scratch: Probe = { d: 0, part: 0 };

/** The signed distance alone, for tests, the layout's jitter and the cage. */
export function clusterSdf(c: Cluster, p: Vec3): number {
  return probe(c, p[0], p[1], p[2], scratch).d;
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const length = (v: Vec3): number => Math.sqrt(dot(v, v));
const distance = (u: Vec3, v: Vec3): number =>
  Math.sqrt((u[0] - v[0]) ** 2 + (u[1] - v[1]) ** 2 + (u[2] - v[2]) ** 2);
