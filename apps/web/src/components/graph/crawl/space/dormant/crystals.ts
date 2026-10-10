// The crystals notes stand as in the dormant network, as pure geometry: three
// closed, faceted shapes and the matrix that puts one on its note. No three,
// so their shape and placement are tested in Node; the GPU side
// (crystal-meshes.ts) uploads what this builds.
//
// Each shape is built in the gem's own frame: +y its axis, x and z across it,
// in units of its footprint (the widest it gets across its axis is 1). Its
// crown — the highest point — sits at y = 0 and its keel below, because the
// shader measures from there: the swell of a find grows about the light
// inside, and the band a reading sends up the gem runs from keel to crown.
// The matrix puts that inner light on the note itself and turns the gem every
// way by a hash of the note, so the cluster reads as loose crystals in a
// volume, not a lattice of gems all standing one way.
//
// Facets are flat: every triangle carries its own outward normal, and the
// three corners of each triangle carry the barycentric coordinates the shader
// draws the crystal's edges from. Every triangle is a real facet — no facet is
// split into two coplanar triangles — so every edge it draws is an edge of the
// gem.
//
//  - A note is a hexagonal bipyramid: a short point above the girdle, a long
//    keel below, like a shard of quartz.
//  - An index is a geode: an icosahedron with a low pyramid raised on each
//    face, squashed flat, bigger than a note — the heart of its project.
//  - A decision is an octahedron: a diamond.

import type { Vec3 } from '../../vec';
import type { CrystalKind } from '../volume/layout';

export type { CrystalKind };

/** Footprint radius of each kind, creature units: notes stay well clear of their neighbours 1.7 away. */
export const CRYSTAL_RADIUS: Readonly<Record<CrystalKind, number>> = {
  note: 0.15,
  index: 0.24,
  decision: 0.19,
};

export interface CrystalShape {
  kind: CrystalKind;
  triangles: number;
  /** xyz per vertex, three vertices a triangle, counter-clockwise seen from outside. */
  positions: Float32Array;
  /** The triangle's outward normal at each of its vertices. */
  normals: Float32Array;
  /** Barycentric coordinates at each vertex: an edge of the gem is where one of them is 0. */
  edges: Float32Array;
  /** The keel, local y: the lowest point. The crown is at 0. */
  bottom: number;
  /** The light inside the gem: a sphere at local y `coreY`, radius `coreR`. */
  coreY: number;
  coreR: number;
}

/** A shape as triangles of corner points, before it is laid out flat. */
type Facets = [Vec3, Vec3, Vec3][];

/** A ring of `n` points `r` from the axis at height `y`, the first at `phase` radians. */
function ring(n: number, r: number, y: number, phase = 0): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const a = phase + (k * Math.PI * 2) / n;
    return [Math.cos(a) * r, y, Math.sin(a) * r] as Vec3;
  });
}

/** A bipyramid over a regular girdle: a point `top` above it and a keel `keel` below. */
function bipyramid(sides: number, top: number, keel: number, phase: number): Facets {
  const girdle = ring(sides, 1, 0, phase);
  const apex: Vec3 = [0, top, 0];
  const foot: Vec3 = [0, -keel, 0];
  const out: Facets = [];
  for (let k = 0; k < sides; k++) {
    const a = girdle[k]!;
    const b = girdle[(k + 1) % sides]!;
    out.push([apex, a, b], [foot, b, a]);
  }
  return out;
}

/** An icosahedron with a vertex at each pole, each face raised into a pyramid `raise` high. */
function geode(raise: number): Facets {
  const y = 1 / Math.sqrt(5);
  const r = 2 / Math.sqrt(5);
  const top: Vec3 = [0, 1, 0];
  const bottom: Vec3 = [0, -1, 0];
  const upper = ring(5, r, y);
  const lower = ring(5, r, -y, Math.PI / 5);
  const faces: Facets = [];
  for (let k = 0; k < 5; k++) {
    const u0 = upper[k]!;
    const u1 = upper[(k + 1) % 5]!;
    const l0 = lower[k]!;
    const l1 = lower[(k + 1) % 5]!;
    faces.push([top, u0, u1], [u0, l0, u1], [u1, l0, l1], [bottom, l1, l0]);
  }
  const out: Facets = [];
  for (const [a, b, c] of faces) {
    const m: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const l = Math.hypot(m[0], m[1], m[2]);
    const k = (l + raise) / l;
    const apex: Vec3 = [m[0] * k, m[1] * k, m[2] * k];
    out.push([a, b, apex], [b, c, apex], [c, a, apex]);
  }
  return out;
}

/** The shapes, unscaled, each round its girdle or middle at y = 0, and how flat each is squashed. */
const FACETS: Record<CrystalKind, () => { facets: Facets; squash: number }> = {
  // The point above the girdle is half the keel: most of a shard hangs below.
  note: () => ({ facets: bipyramid(6, 0.6, 1.2, Math.PI / 6), squash: 1 }),
  index: () => ({ facets: geode(0.18), squash: 0.6 }),
  decision: () => ({ facets: bipyramid(4, 0.6, 1.1, 0), squash: 1 }),
};

/** The inner light's radius, as a share of the footprint. */
const CORE_SHARE = 0.45;

/**
 * A crystal of `kind`, built flat: the footprint scaled to 1, squashed as its
 * kind is, its crown moved to y = 0, every triangle wound counter-clockwise
 * from outside with its outward normal.
 */
export function crystalShape(kind: CrystalKind): CrystalShape {
  const { facets, squash } = FACETS[kind]();
  let wide = 0;
  let high = -Infinity;
  for (const tri of facets) {
    for (const p of tri) {
      wide = Math.max(wide, Math.hypot(p[0], p[2]));
      high = Math.max(high, p[1] * squash);
    }
  }
  const place = (p: Vec3): Vec3 => [p[0] / wide, (p[1] * squash - high) / wide, p[2] / wide];

  // The middle of the shape: every facet faces away from it.
  const placed = facets.map((t) => t.map(place) as [Vec3, Vec3, Vec3]);
  const mid: Vec3 = [0, 0, 0];
  let n = 0;
  for (const tri of placed) {
    for (const p of tri) {
      mid[0] += p[0];
      mid[1] += p[1];
      mid[2] += p[2];
      n++;
    }
  }
  mid[0] /= n;
  mid[1] /= n;
  mid[2] /= n;

  const count = placed.length;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const edges = new Float32Array(count * 9);
  let bottom = 0;
  placed.forEach((tri, t) => {
    const a = tri[0];
    let [, b, c] = tri;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const out =
      nx * ((a[0] + b[0] + c[0]) / 3 - mid[0]) +
      ny * ((a[1] + b[1] + c[1]) / 3 - mid[1]) +
      nz * ((a[2] + b[2] + c[2]) / 3 - mid[2]);
    if (out < 0) {
      // Wound the other way round: swap two corners, and the normal turns out.
      [b, c] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz);
    [a, b, c].forEach((p, k) => {
      const o = (t * 3 + k) * 3;
      positions[o] = p[0];
      positions[o + 1] = p[1];
      positions[o + 2] = p[2];
      normals[o] = nx / l;
      normals[o + 1] = ny / l;
      normals[o + 2] = nz / l;
      edges[o + k] = 1;
      bottom = Math.min(bottom, p[1]);
    });
  });
  return {
    kind,
    triangles: count,
    positions,
    normals,
    edges,
    bottom,
    // Every shape is built round its girdle (or its middle) at y = 0: the light sits there.
    coreY: -high / wide,
    coreR: CORE_SHARE,
  };
}

/** Where and how a crystal is put on its note, world units. */
export interface CrystalPlacement {
  /** The note: where the gem's inner light sits. */
  position: Vec3;
  /** Three numbers in [0, 1), fixed per note: a turn uniform over every orientation. */
  turn: readonly [number, number, number];
  /** Footprint radius, world units. */
  radius: number;
  /** How much taller or shorter than its kind it stands: 1 as built. */
  stretch: number;
  /** The shape's light, local y (crystalShape's coreY): the point put on the note. */
  core: number;
}

/**
 * Writes the column-major 4 × 4 matrix that puts a crystal on its note into
 * `out` at `offset`: the rotation R from `turn` — Shoemake's uniform
 * quaternion q = (√(1−u₁) sin 2πu₂, √(1−u₁) cos 2πu₂, √u₁ sin 2πu₃,
 * √u₁ cos 2πu₃), so evenly spread numbers turn gems evenly every way, with no
 * favoured axis — its columns R·x̂·radius, R·ŷ·radius·stretch and R·ẑ·radius,
 * and the translation that lands the inner light, local (0, core, 0), on
 * `position`.
 */
export function crystalFrame(p: CrystalPlacement, out: Float32Array, offset = 0): void {
  const { position, radius } = p;
  const [u1, u2, u3] = p.turn;
  const a = Math.sqrt(Math.max(0, 1 - u1));
  const b = Math.sqrt(Math.max(0, u1));
  const x = a * Math.sin(2 * Math.PI * u2);
  const y = a * Math.cos(2 * Math.PI * u2);
  const z = b * Math.sin(2 * Math.PI * u3);
  const w = b * Math.cos(2 * Math.PI * u3);

  const h = radius * p.stretch;
  // R·ŷ: the gem's axis, which the light sits along.
  const yx = 2 * (x * y - z * w);
  const yy = 1 - 2 * (x * x + z * z);
  const yz = 2 * (y * z + x * w);
  out[offset] = (1 - 2 * (y * y + z * z)) * radius;
  out[offset + 1] = 2 * (x * y + z * w) * radius;
  out[offset + 2] = 2 * (x * z - y * w) * radius;
  out[offset + 3] = 0;
  out[offset + 4] = yx * h;
  out[offset + 5] = yy * h;
  out[offset + 6] = yz * h;
  out[offset + 7] = 0;
  out[offset + 8] = 2 * (x * z + y * w) * radius;
  out[offset + 9] = 2 * (y * z - x * w) * radius;
  out[offset + 10] = (1 - 2 * (x * x + y * y)) * radius;
  out[offset + 11] = 0;
  const lift = p.core * h;
  out[offset + 12] = position[0] - yx * lift;
  out[offset + 13] = position[1] - yy * lift;
  out[offset + 14] = position[2] - yz * lift;
  out[offset + 15] = 1;
}
