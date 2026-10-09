// The cage over the cluster: a few line segments that show the form. Its
// bulbs, necks and satellite are dark, filled with dark glass, and from afar
// they would read as nothing at all; the cage is their outline. It is drawn
// very faint and only ever added (dormant/cage.ts), so it is never mistaken
// for a thread close up.
//
// Each bulb gets a low-poly icosahedral wire — the icosahedron, or for a big
// bulb the icosahedron with every edge split once — and each neck a few lines
// along it. The wire starts on a sphere just outside its bulb and is draped
// onto the form's own surface, the same small distance out, so it follows the
// smooth flare where a neck meets a bulb. A corner that slides off its own
// bulb on the way — into a neck, or onto the next bulb — is dropped with its
// edges, so no bulb's wire cuts across another's.
//
// Pure, like the rest of the volume: the dormant network turns the segments
// into one draw.

import type { Vec3 } from '../../vec';

import {
  CAGE_OUT,
  PART_HUB,
  PART_SATELLITE,
  lobePart,
  neckPart,
  probe,
  type Cluster,
  type Probe,
} from './cluster';

/** One part's share of the cage: a bulb's wire, or a neck's lines. */
export interface CageWire {
  part: number;
  /** Line segments, xyz xyz per segment, world units. */
  lines: Float32Array;
}

/** A bulb at least this many spacings in radius gets the finer wire; the hub always does. */
const FINE = 3;
/** Lines along each neck, evenly round it, and the pieces each is drawn in. */
const NECK_LINES = 6;
const NECK_PIECES = 6;
/** A neck's lines run from this share of the hub's radius out to this share of its lobe's radius short of the lobe's centre. */
const NECK_REACH = 0.9;
/** Newton steps that drape a corner onto the surface, and their finite-difference step, spacings. */
const DRAPE_STEPS = 4;
const DRAPE_H = 0.05;

const PHI = (1 + Math.sqrt(5)) / 2;
/** The icosahedron's corners, unnormalised, and its twenty faces, three corners each. */
const CORNERS: readonly Vec3[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];
const FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

/** A wire on the unit sphere: its corners and its edges, as pairs of corners. */
interface Wire {
  dirs: readonly Vec3[];
  edges: readonly (readonly [number, number])[];
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The icosahedron's wire (ν = 1: 12 corners, 30 edges), or with every edge
 * split at its middle and the middles pushed out onto the sphere (ν = 2: 42
 * corners, 120 edges). Built once each.
 */
const icoWire = (() => {
  const built = new Map<1 | 2, Wire>();
  return (nu: 1 | 2): Wire => {
    const hit = built.get(nu);
    if (hit) return hit;
    const dirs = CORNERS.map(unit);
    const edges: [number, number][] = [];
    const seen = new Set<number>();
    const join = (x: number, y: number) => {
      const key = Math.min(x, y) * 64 + Math.max(x, y);
      if (seen.has(key)) return;
      seen.add(key);
      edges.push([x, y]);
    };
    const middles = new Map<number, number>();
    const middle = (x: number, y: number) => {
      const key = Math.min(x, y) * 64 + Math.max(x, y);
      let m = middles.get(key);
      if (m === undefined) {
        const [p, q] = [dirs[x]!, dirs[y]!];
        m = dirs.length;
        dirs.push(unit([p[0] + q[0], p[1] + q[1], p[2] + q[2]]));
        middles.set(key, m);
      }
      return m;
    };
    for (let f = 0; f < FACES.length; f += 3) {
      const [a, b, c] = [FACES[f]!, FACES[f + 1]!, FACES[f + 2]!];
      if (nu === 1) {
        join(a, b);
        join(b, c);
        join(c, a);
        continue;
      }
      const [ab, bc, ca] = [middle(a, b), middle(b, c), middle(c, a)];
      for (const [x, y] of [
        [a, ab],
        [ab, b],
        [b, bc],
        [bc, c],
        [c, ca],
        [ca, a],
        [ab, bc],
        [bc, ca],
        [ca, ab],
      ] as const) {
        join(x, y);
      }
    }
    const wire = { dirs, edges };
    built.set(nu, wire);
    return wire;
  };
})();

/** The cage over `c`, part by part: the hub, each lobe, each neck, then the satellite. */
export function cageWires(c: Cluster): CageWire[] {
  const a = c.spacing;
  const out: Probe = { d: 0, part: 0 };
  const target = CAGE_OUT * a;
  const h = DRAPE_H * a;
  const sdf = (x: number, y: number, z: number) => probe(c, x, y, z, out).d;

  /** `p`, in place, moved onto the surface CAGE_OUT outside the form by Newton's method. */
  const drape = (p: Vec3) => {
    for (let step = 0; step < DRAPE_STEPS; step++) {
      const f = sdf(p[0], p[1], p[2]) - target;
      const gx = (sdf(p[0] + h, p[1], p[2]) - sdf(p[0] - h, p[1], p[2])) / (2 * h);
      const gy = (sdf(p[0], p[1] + h, p[2]) - sdf(p[0], p[1] - h, p[2])) / (2 * h);
      const gz = (sdf(p[0], p[1], p[2] + h) - sdf(p[0], p[1], p[2] - h)) / (2 * h);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (!(g2 > 1e-12)) return;
      const k = f / g2;
      p[0] -= k * gx;
      p[1] -= k * gy;
      p[2] -= k * gz;
    }
  };
  const partAt = (p: Vec3) => probe(c, p[0], p[1], p[2], out).part;

  /** A bulb's wire, draped, without the corners that slid off it. */
  const bulb = (centre: Vec3, radius: number, part: number, nu: 1 | 2): CageWire => {
    const wire = icoWire(nu);
    const reach = radius + target;
    const corners = wire.dirs.map((d): Vec3 => {
      const p: Vec3 = [
        centre[0] + d[0] * reach,
        centre[1] + d[1] * reach,
        centre[2] + d[2] * reach,
      ];
      drape(p);
      return p;
    });
    const own = corners.map((p) => partAt(p) === part);
    const lines: number[] = [];
    for (const [x, y] of wire.edges) {
      if (own[x] && own[y]) lines.push(...corners[x]!, ...corners[y]!);
    }
    return { part, lines: Float32Array.from(lines) };
  };

  /** A neck's lines, round its axis, draped; a piece that leaves the neck and its two bulbs is dropped. */
  const neck = (i: number): CageWire => {
    const n = c.necks[i]!;
    const [ax, ay, az] = n.to;
    const span = Math.sqrt(ax * ax + ay * ay + az * az);
    const along: Vec3 = [ax / span, ay / span, az / span];
    let e1: Vec3 = Math.abs(along[1]) > 0.9 ? [0, along[2], -along[1]] : [-along[2], 0, along[0]];
    e1 = unit(e1);
    const e2: Vec3 = [
      along[1] * e1[2] - along[2] * e1[1],
      along[2] * e1[0] - along[0] * e1[2],
      along[0] * e1[1] - along[1] * e1[0],
    ];
    const from = NECK_REACH * c.hub.radius;
    const to = span - NECK_REACH * c.lobes[i]!.radius;
    const lines: number[] = [];
    const part = neckPart(i);
    if (to <= from) return { part, lines: new Float32Array(0) };
    const near = (p: Vec3) => {
      const q = partAt(p);
      return q === part || q === PART_HUB || q === lobePart(i);
    };
    const offset = n.radius + target;
    for (let l = 0; l < NECK_LINES; l++) {
      const turn = (2 * Math.PI * l) / NECK_LINES;
      const ox = (Math.cos(turn) * e1[0] + Math.sin(turn) * e2[0]) * offset;
      const oy = (Math.cos(turn) * e1[1] + Math.sin(turn) * e2[1]) * offset;
      const oz = (Math.cos(turn) * e1[2] + Math.sin(turn) * e2[2]) * offset;
      let last: Vec3 | null = null;
      for (let k = 0; k <= NECK_PIECES; k++) {
        const s = from + ((to - from) * k) / NECK_PIECES;
        const p: Vec3 = [along[0] * s + ox, along[1] * s + oy, along[2] * s + oz];
        drape(p);
        const kept = near(p) ? p : null;
        if (last && kept) lines.push(...last, ...kept);
        last = kept;
      }
    }
    return { part, lines: Float32Array.from(lines) };
  };

  const wires = [bulb(c.hub.centre, c.hub.radius, PART_HUB, 2)];
  c.lobes.forEach((l, i) => {
    wires.push(bulb(l.centre, l.radius, lobePart(i), l.radius >= FINE * a ? 2 : 1));
  });
  c.necks.forEach((_, i) => wires.push(neck(i)));
  if (c.satellite) wires.push(bulb(c.satellite.centre, c.satellite.radius, PART_SATELLITE, 1));
  return wires;
}

/** The cage over a cluster: line segments, xyz xyz per segment, world units — every part's, in order. */
export function cageLines(c: Cluster): Float32Array {
  const wires = cageWires(c);
  let length = 0;
  for (const w of wires) length += w.lines.length;
  const lines = new Float32Array(length);
  let at = 0;
  for (const w of wires) {
    lines.set(w.lines, at);
    at += w.lines.length;
  }
  return lines;
}
