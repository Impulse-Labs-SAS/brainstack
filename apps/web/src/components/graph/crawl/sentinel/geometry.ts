// The Sentinel's shapes, built in code: the armoured hull, the vertebra every
// tentacle is made of, the talon and the iris blade. No model file — the
// hard-surface vocabulary here (plates, seams, hoops, sockets, bolts) is a
// handful of parameters, testable in Node, and needs no asset pipeline.
//
// What makes it ours and not the film's machine: an armoured seed of
// overlapping scale plates rather than a smooth head, one cyclopean lens with
// a mechanical iris rather than a cluster of eyes, a crown of sockets on a
// collar rather than squid tentacles trailing behind, octagonal vertebrae
// with polished rods, and grooves of light where the thread's light climbs
// into the body.
//
// Everything is in creature units (one unit is the vault's typical link), in
// the body frame: x right, y up, z forward. The vertebra, talon and iris are
// authored for instancing and documented where they are built.
//
// Each part is built non-indexed with the same attributes — position, normal,
// uv, aPart, aAO, aEdge (and aEmit for the instanced parts) — because
// mergeGeometries refuses anything else, and because a program that reads an
// attribute a geometry lacks gets whatever value the last draw left behind.
// Normals are creased at 30°: facets and chamfers stay crisp, curves stay
// smooth. aAO is ambient occlusion baked per vertex from the distance to the
// dark core (seams, sockets and walls darken); aEdge marks chamfers and rims,
// where the finish wears through first.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { cross, dot, norm, sub, type Vec3 } from '../vec';
import { COLLAR, EYE, HULL, TENTACLE_SPECS, type TentacleSpec } from './anatomy';
import { PART } from './look';

export type HullLod = 'high' | 'low';

const CREASE = (30 * Math.PI) / 180;
/** Wear texture tiles per creature unit on the hull: about 0.4 units a tile. */
const UV_PER_UNIT = 2.5;

// -- A small mesh builder ----------------------------------------------------------

interface Vert {
  p: Vec3;
  u: number;
  v: number;
  part: number;
  ao: number;
  edge: number;
  emit: number;
}

function vert(p: Vec3, u: number, v: number, part: number, ao = 1, edge = 0, emit = 0): Vert {
  return { p, u, v, part, ao, edge, emit };
}

/** Triangles with their attributes, wound counter-clockwise seen from outside. */
class Shape {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly part: number[] = [];
  private readonly ao: number[] = [];
  private readonly edge: number[] = [];
  private readonly emit: number[] = [];

  tri(a: Vert, b: Vert, c: Vert): void {
    // Rings that close to a point give zero-area triangles: they cost vertices and shade nothing.
    const n = cross(sub(b.p, a.p), sub(c.p, a.p));
    if (dot(n, n) < 1e-22) return;
    for (const q of [a, b, c]) {
      this.pos.push(q.p[0], q.p[1], q.p[2]);
      this.uv.push(q.u, q.v);
      this.part.push(q.part);
      this.ao.push(q.ao);
      this.edge.push(q.edge);
      this.emit.push(q.emit);
    }
  }

  quad(a: Vert, b: Vert, c: Vert, d: Vert): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** A triangle wound so that it faces along `out`. */
  triFacing(a: Vert, b: Vert, c: Vert, out: Vec3): void {
    if (dot(cross(sub(b.p, a.p), sub(c.p, a.p)), out) >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** Non-indexed geometry with creased normals; `emit` adds aEmit, which only the instanced parts carry. */
  geometry(emit: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.edge, 1));
    if (emit) g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emit, 1));
    // toCreasedNormals matches vertices on a 0.01 grid (BufferGeometryUtils.js:1319),
    // coarser than a bolt's chamfer here: scaled up first, nearby features keep
    // their own normals.
    g.scale(1000, 1000, 1000);
    const creased = toCreasedNormals(g, CREASE);
    creased.scale(0.001, 0.001, 0.001);
    return creased;
  }
}

/** Where a lathe sits: `y` is its axis, and x = y × z. */
export interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

function frame(o: Vec3, axis: Vec3, hint: Vec3): Frame {
  const y = norm(axis);
  let z = sub(hint, [y[0] * dot(hint, y), y[1] * dot(hint, y), y[2] * dot(hint, y)]);
  if (dot(z, z) < 1e-10) z = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  z = norm(sub(z, [y[0] * dot(z, y), y[1] * dot(z, y), y[2] * dot(z, y)]));
  return { o, y, z, x: cross(y, z) };
}

function place(f: Frame, r: number, phi: number, y: number): Vec3 {
  const s = Math.sin(phi) * r;
  const c = Math.cos(phi) * r;
  return [
    f.o[0] + f.y[0] * y + f.x[0] * s + f.z[0] * c,
    f.o[1] + f.y[1] * y + f.x[1] * s + f.z[1] * c,
    f.o[2] + f.y[2] * y + f.x[2] * s + f.z[2] * c,
  ];
}

/** One point of a lathe profile; walking the profile, the outside is on the right of (Δr, Δy). */
interface Ring {
  r: number;
  y: number;
  ao?: number;
  edge?: number;
  emit?: number;
  part?: number;
}

interface LatheOptions {
  segments: number;
  part: number;
  /** Angle range, radians; the default is a full turn. Partial turns may close their ends. */
  from?: number;
  to?: number;
  caps?: boolean;
  /** Occlusion floor where it meets the hull's core; omit for parts away from the hull. */
  aoFloor?: number;
  /** Wear texture tiles per unit of this lathe's own length. */
  uvScale: number;
}

function lathe(s: Shape, f: Frame, rings: readonly Ring[], o: LatheOptions): void {
  const from = o.from ?? 0;
  const to = o.to ?? Math.PI * 2;
  const rMax = Math.max(...rings.map((q) => q.r));
  const arc: number[] = [0];
  for (let k = 1; k < rings.length; k++) {
    const a = rings[k - 1]!;
    const b = rings[k]!;
    arc.push(arc[k - 1]! + Math.hypot(b.r - a.r, b.y - a.y));
  }
  const at = (i: number, k: number): Vert => {
    const phi = from + ((to - from) * i) / o.segments;
    const q = rings[k]!;
    const p = place(f, q.r, phi, q.y);
    const ao = (q.ao ?? 1) * (o.aoFloor === undefined ? 1 : nearCore(p, o.aoFloor));
    return vert(
      p,
      phi * rMax * o.uvScale,
      arc[k]! * o.uvScale,
      q.part ?? o.part,
      ao,
      q.edge ?? 0,
      q.emit ?? 0,
    );
  };
  for (let i = 0; i < o.segments; i++) {
    for (let k = 0; k < rings.length - 1; k++) {
      s.quad(at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k + 1));
    }
  }
  if (o.caps) {
    const cy = rings.reduce((t, q) => t + q.y, 0) / rings.length;
    const cr = rings.reduce((t, q) => t + q.r, 0) / rings.length;
    for (const [i, phi, sign] of [
      [0, from, -1],
      [o.segments, to, 1],
    ] as const) {
      // The end faces the way the lathe turns there.
      const out: Vec3 = [0, 1, 2].map(
        (a) => sign * (f.x[a]! * Math.cos(phi) - f.z[a]! * Math.sin(phi)),
      ) as Vec3;
      const centre = vert(place(f, cr, phi, cy), 0, 0, o.part, 0.8);
      for (let k = 0; k < rings.length - 1; k++) s.triFacing(centre, at(i, k), at(i, k + 1), out);
    }
  }
}

// -- The hull's body: an egg-shaped core under its armour --------------------------

/** The plates' crest is the hull's outline; the core sits this far below it. */
const ARMOUR = 0.03;
const CORE = {
  a: HULL.width / 2 - ARMOUR,
  b: HULL.height / 2 - ARMOUR,
  half: HULL.length / 2 - ARMOUR,
};
/** Fuller behind the collar, finer toward the eye: a seed, not an ellipsoid. */
const EGG = -0.12;
const EGG_PEAK = (() => {
  const z = (-1 + Math.sqrt(1 + 8 * EGG * EGG)) / (4 * EGG);
  return Math.sqrt(1 - z * z) * (1 + EGG * z);
})();

function egg(z: number): number {
  const zeta = Math.max(-1, Math.min(1, z / CORE.half));
  return (Math.sqrt(1 - zeta * zeta) * (1 + EGG * zeta)) / EGG_PEAK;
}

/** A point `h` above the core at angle `t` around the body axis (0 right, π/2 up) and length `z`. */
function onCore(t: number, z: number, h: number): Vec3 {
  const e = egg(z);
  return [(CORE.a * e + h) * Math.cos(t), (CORE.b * e + h) * Math.sin(t), z];
}

/** Roughly how far a point is above the core; negative inside. */
function coreHeight(p: Vec3): number {
  const e = egg(p[2]);
  const a = CORE.a * e;
  const b = CORE.b * e;
  const over = Math.abs(p[2]) - CORE.half;
  if (a < 1e-3 || b < 1e-3) return Math.hypot(p[0], p[1], Math.max(0, over));
  // An ellipse's distance, approximated from its implicit function and gradient.
  const k0 = Math.hypot(p[0] / a, p[1] / b);
  const k1 = Math.hypot(p[0] / (a * a), p[1] / (b * b));
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b);
}

/** Occlusion from the core's closeness: `floor` where a part meets it, 1 a little way off. */
function nearCore(p: Vec3, floor: number): number {
  const t = Math.max(0, Math.min(1, coreHeight(p) / 0.032));
  return floor + (1 - floor) * t * t * (3 - 2 * t);
}

/** The outward normal of the surface `h` above the core, numerically. */
function coreNormal(t: number, z: number, h: number): Vec3 {
  const d = 1e-4;
  const dt = sub(onCore(t + d, z, h), onCore(t - d, z, h));
  const dz = sub(onCore(t, z + d, h), onCore(t, z - d, h));
  return norm(cross(dt, dz));
}

interface Section {
  z: number;
  /** Height above the core; or explicit semi-axes, for a ring that follows the sockets. */
  h?: number;
  a?: number;
  b?: number;
  ao?: number;
  edge?: number;
}

/** A ring around the body axis through these sections, back to front or as a loop. */
function sweep(
  s: Shape,
  sections: readonly Section[],
  o: { segments: number; part: number; aoFloor: number },
): void {
  const point = (t: number, q: Section): Vec3 => {
    if (q.a !== undefined && q.b !== undefined) return [q.a * Math.cos(t), q.b * Math.sin(t), q.z];
    return onCore(t, q.z, q.h ?? 0);
  };
  const arc: number[] = [0];
  for (let k = 1; k < sections.length; k++) {
    arc.push(
      arc[k - 1]! +
        Math.hypot(
          sections[k]!.z - sections[k - 1]!.z,
          (sections[k]!.h ?? 0) - (sections[k - 1]!.h ?? 0),
        ),
    );
  }
  const at = (i: number, k: number): Vert => {
    const t = (Math.PI * 2 * i) / o.segments;
    const q = sections[k]!;
    const p = point(t, q);
    return vert(
      p,
      t * CORE.a * UV_PER_UNIT,
      arc[k]! * UV_PER_UNIT,
      o.part,
      (q.ao ?? 1) * nearCore(p, o.aoFloor),
      q.edge ?? 0,
    );
  };
  for (let i = 0; i < o.segments; i++) {
    for (let k = 0; k < sections.length - 1; k++) {
      s.quad(at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k + 1));
    }
  }
}

interface Detail {
  core: [segments: number, sections: number];
  plate: [across: number, along: number];
  hoop: number;
  groove: boolean;
  collar: number;
  cup: number;
  stub: number;
  boltsPerPlate: number;
  boltChamfer: boolean;
  eye: number;
  brow: number;
  roundFins: boolean;
}

const DETAIL: Record<HullLod, Detail> = {
  high: {
    core: [48, 28],
    plate: [10, 7],
    hoop: 64,
    groove: true,
    collar: 64,
    cup: 12,
    stub: 6,
    boltsPerPlate: 2,
    boltChamfer: true,
    eye: 32,
    brow: 14,
    roundFins: true,
  },
  low: {
    core: [32, 16],
    plate: [5, 4],
    hoop: 24,
    groove: false,
    collar: 24,
    cup: 8,
    stub: 4,
    boltsPerPlate: 1,
    boltChamfer: false,
    eye: 16,
    brow: 7,
    roundFins: false,
  },
};

function buildCore(d: Detail): Shape {
  const s = new Shape();
  const [segments, count] = d.core;
  // Closer together toward the ends, where the egg turns fastest.
  const sections: Section[] = Array.from({ length: count }, (_, k) => ({
    z: -Math.cos((Math.PI * k) / (count - 1)) * CORE.half,
    h: 0,
  }));
  sweep(s, sections, { segments, part: PART.core, aoFloor: 0.35 });
  return s;
}

// -- Armour plates: three bands of six, scales lapping front over back ------------

interface Band {
  /** Back and front edge. */
  z0: number;
  z1: number;
  /** Where the first plate's centre sits around the body. */
  turn: number;
  /** Where along the band the bolts go: the part no other band covers. */
  boltZ: number;
}

const BANDS: readonly Band[] = [
  { z0: 0.075, z1: 0.27, turn: Math.PI / 6, boltZ: 0.17 },
  { z0: -0.06, z1: 0.115, turn: 0, boltZ: 0.005 },
  { z0: -0.315, z1: -0.178, turn: Math.PI / 6, boltZ: -0.24 },
];
/** A plate's crest above the core at its front edge, and how much higher it rises at its back. */
const PLATE_LOW = 0.014;
const PLATE_RISE = 0.016;
const PLATE_CROWN = 0.003;
const CHAMFER = 0.0055;
/** Half the angle of the seam between two plates of a band. */
const SEAM = 0.011;
const FLOOR = 0.002;

function plateLoop(nu: number, nv: number): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < nu; i++) loop.push([i, 0]);
  for (let j = 0; j < nv; j++) loop.push([nu, j]);
  for (let i = nu; i > 0; i--) loop.push([i, nv]);
  for (let j = nv; j > 0; j--) loop.push([0, j]);
  return loop;
}

function buildPlates(d: Detail, bolts: Shape): Shape {
  const s = new Shape();
  const [nu, nv] = d.plate;
  const half = Math.PI / 6 - SEAM;
  const loop = plateLoop(nu, nv);
  for (const band of BANDS) {
    const { z0, z1 } = band;
    for (let n = 0; n < 6; n++) {
      const tc = band.turn + (n * Math.PI) / 3;
      // Each plate rises toward its back edge, so the band in front laps over the next.
      const crest = (t: number, z: number) => {
        const w = (t - tc) / half;
        return PLATE_LOW + (PLATE_RISE * (z1 - z)) / (z1 - z0) + PLATE_CROWN * (1 - w * w);
      };
      const mid = onCore(tc, (z0 + z1) / 2, 0);
      const dt = CHAMFER / Math.max(0.05, Math.hypot(mid[0], mid[1]));
      const param = (i: number, j: number, inset: boolean): [number, number] => {
        const ti = inset ? dt : 0;
        const zi = inset ? CHAMFER : 0;
        return [
          tc - half + ti + (2 * (half - ti) * i) / nu,
          z0 + zi + ((z1 - z0 - 2 * zi) * j) / nv,
        ];
      };
      const at = (t: number, z: number, h: number, edge: number): Vert => {
        const p = onCore(t, z, h);
        return vert(
          p,
          t * CORE.a * UV_PER_UNIT,
          z * UV_PER_UNIT,
          PART.plate,
          nearCore(p, 0.55),
          edge,
        );
      };
      const top = (i: number, j: number) => {
        const [t, z] = param(i, j, true);
        return at(t, z, crest(t, z), 0);
      };
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++)
          s.quad(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
      }
      const inner = loop.map(([i, j]) => {
        const [t, z] = param(i, j, true);
        return at(t, z, crest(t, z), 1);
      });
      const rim = loop.map(([i, j]) => {
        const [t, z] = param(i, j, false);
        return at(t, z, crest(t, z) - CHAMFER, 1);
      });
      const wallTop = loop.map(([i, j]) => {
        const [t, z] = param(i, j, false);
        return at(t, z, crest(t, z) - CHAMFER, 0.35);
      });
      const foot = loop.map(([i, j]) => {
        const [t, z] = param(i, j, false);
        return at(t, z, FLOOR, 0);
      });
      for (let k = 0; k < loop.length; k++) {
        const m = (k + 1) % loop.length;
        s.quad(rim[k]!, rim[m]!, inner[m]!, inner[k]!);
        s.quad(foot[k]!, foot[m]!, wallTop[m]!, wallTop[k]!);
      }
      const across = d.boltsPerPlate === 2 ? [-0.62, 0.62] : [0.62];
      for (const w of across) {
        const t = tc + w * half;
        const h = crest(t, band.boltZ);
        bolt(
          bolts,
          onCore(t, band.boltZ, h - 0.003),
          coreNormal(t, band.boltZ, h),
          1,
          d.boltChamfer,
        );
      }
    }
  }
  return s;
}

/** A hex bolt head standing on a surface, `scale` 1 being 0.0135 across the flats' corners. */
function bolt(s: Shape, base: Vec3, normal: Vec3, scale: number, chamfer: boolean): void {
  const f = frame(base, normal, [0, 0, 1]);
  const r = 0.0135 * scale;
  const rings: Ring[] = chamfer
    ? [
        { r, y: -0.004 * scale, ao: 0.7 },
        { r, y: 0.0045 * scale, edge: 0.6 },
        { r: r * 0.78, y: 0.0075 * scale, edge: 1 },
        { r: 0, y: 0.0075 * scale, edge: 0.5 },
      ]
    : [
        { r, y: -0.004 * scale, ao: 0.7 },
        { r, y: 0.006 * scale, edge: 1 },
        { r: 0, y: 0.006 * scale, edge: 0.5 },
      ];
  lathe(s, f, rings, { segments: 6, part: PART.bolt, aoFloor: 0.7, uvScale: UV_PER_UNIT });
}

// -- Hoops and the collar --------------------------------------------------------

/** A hoop's back and front, and how far it stands above the core. */
const HOOPS = [
  { z0: 0.268, z1: 0.302, h: 0.038 },
  { z0: -0.338, z1: -0.305, h: 0.038 },
] as const;

function buildHoops(d: Detail): Shape {
  const s = new Shape();
  for (const { z0, z1, h } of HOOPS) {
    const c = 0.006;
    const zm = (z0 + z1) / 2;
    // Back face, chamfer, crown (with a machined groove at high detail), chamfer, front face.
    const crown: Section[] = d.groove
      ? [
          { z: z0 + c, h, edge: 1 },
          { z: zm - 0.004, h, edge: 0.2 },
          { z: zm - 0.002, h: h - 0.004, ao: 0.7 },
          { z: zm + 0.002, h: h - 0.004, ao: 0.7 },
          { z: zm + 0.004, h, edge: 0.2 },
          { z: z1 - c, h, edge: 1 },
        ]
      : [
          { z: z0 + c, h, edge: 1 },
          { z: z1 - c, h, edge: 1 },
        ];
    sweep(
      s,
      [
        { z: z0, h: 0 },
        { z: z0, h: h - c, edge: 0.4 },
        ...crown,
        { z: z1, h: h - c, edge: 0.4 },
        { z: z1, h: 0 },
      ],
      { segments: d.hoop, part: PART.hoop, aoFloor: 0.6 },
    );
  }
  return s;
}

/**
 * The collar: a raised band with a channel round it, behind the hull's
 * middle. Its floor follows the crown's sockets, which sit on an ellipse of
 * their own — so the socket cups stand out of the channel all the way round.
 */
const COLLAR_BAND = { z0: COLLAR.z - 0.055, z1: COLLAR.z + 0.055, lip: 0.034 } as const;
const SOCKET_ELLIPSE = { a: COLLAR.radius, b: COLLAR.radius * COLLAR.squash };

function buildCollar(d: Detail): Shape {
  const s = new Shape();
  const { z0, z1, lip } = COLLAR_BAND;
  const c = 0.006;
  // The channel floor, a little under the sockets so the cups stand proud of it.
  const floor = { a: SOCKET_ELLIPSE.a - 0.013, b: SOCKET_ELLIPSE.b - 0.011 };
  sweep(
    s,
    [
      { z: z0, h: 0 },
      { z: z0, h: lip - c, edge: 0.4 },
      { z: z0 + c, h: lip, edge: 1 },
      { z: z0 + 0.017, h: lip, edge: 0.6 },
      { z: z0 + 0.025, ...floor, ao: 0.6 },
      { z: z1 - 0.025, ...floor, ao: 0.6 },
      { z: z1 - 0.017, h: lip, edge: 0.6 },
      { z: z1 - c, h: lip, edge: 1 },
      { z: z1, h: lip - c, edge: 0.4 },
      { z: z1, h: 0 },
    ],
    { segments: d.collar, part: PART.hoop, aoFloor: 0.5 },
  );
  return s;
}

/** The socket cup's rim, for a tentacle 0.06 thick at the root. */
export const CUP = { outer: 0.068, rim: 0.06, inner: 0.057 } as const;

/** A tentacle socket's frame: origin on the socket, y along the tentacle's resting axis. */
export function socketFrame(spec: TentacleSpec): Frame {
  return frame(spec.socket, spec.axis, spec.role === 'explorer' ? [0, 1, 0] : [0, 0, 1]);
}

function buildSockets(d: Detail): Shape {
  const s = new Shape();
  for (const spec of TENTACLE_SPECS) {
    const k = spec.rootRadius / 0.06;
    const f = socketFrame(spec);
    const rings: Ring[] =
      d.cup >= 12
        ? [
            { r: CUP.outer, y: -0.045, ao: 0.5 },
            { r: CUP.outer, y: -0.006, edge: 0.5 },
            { r: (CUP.outer + CUP.rim) / 2, y: 0, edge: 1 },
            { r: CUP.rim, y: 0, edge: 1 },
            { r: CUP.inner, y: -0.004, edge: 0.6, ao: 0.7 },
            { r: CUP.inner, y: -0.03, ao: 0.45 },
            { r: 0, y: -0.034, ao: 0.35 },
          ]
        : [
            { r: CUP.outer, y: -0.045, ao: 0.5 },
            { r: CUP.outer, y: 0, edge: 1 },
            { r: CUP.rim, y: 0, edge: 1 },
            { r: CUP.inner, y: -0.03, ao: 0.45 },
            { r: 0, y: -0.034, ao: 0.35 },
          ];
    lathe(
      s,
      f,
      rings.map((q) => ({ ...q, r: q.r * k, y: q.y * k })),
      { segments: d.cup, part: PART.hoop, aoFloor: 0.5, uvScale: UV_PER_UNIT },
    );
    // Two actuator stubs behind each cup, feeding it.
    for (const side of [-1, 1]) {
      const o: Vec3 = [0, 1, 2].map(
        (a) => f.o[a]! - f.z[a]! * (CUP.outer + 0.011) * k + f.x[a]! * side * 0.024 * k,
      ) as Vec3;
      const r = 0.009 * k;
      lathe(
        s,
        { ...f, o },
        [
          { r, y: -0.04 * k, ao: 0.6 },
          { r, y: 0.01 * k, edge: 0.8 },
          { r: 0, y: 0.012 * k, edge: 0.6 },
        ],
        { segments: d.stub, part: PART.rod, aoFloor: 0.5, uvScale: UV_PER_UNIT },
      );
    }
  }
  return s;
}

// -- Heat-sink fins on the hull's tail -------------------------------------------

const FINS = 7;

/** Copies a stock geometry's triangles in, placed by `m`, as one part. */
function addStock(s: Shape, g: THREE.BufferGeometry, m: THREE.Matrix4, part: number): void {
  const flat = g.index ? g.toNonIndexed() : g;
  const pos = flat.getAttribute('position');
  const uv = flat.getAttribute('uv');
  const normal = flat.getAttribute('normal');
  const v = new THREE.Vector3();
  const corners: Vert[] = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    const p: Vec3 = [v.x, v.y, v.z];
    // A rounded box's bevels have normals off its axes: those are its edges.
    const n = [normal.getX(i), normal.getY(i), normal.getZ(i)].map(Math.abs);
    const bevel = Math.max(...n) < 0.99 ? 1 : 0;
    corners.push(vert(p, uv.getX(i) * 0.3, uv.getY(i) * 0.3, part, nearCore(p, 0.55), bevel));
    if (corners.length === 3) {
      s.tri(corners[0]!, corners[1]!, corners[2]!);
      corners.length = 0;
    }
  }
  if (flat !== g) flat.dispose();
}

function buildFins(d: Detail): Shape {
  const s = new Shape();
  const radial = 0.14;
  const depth = 0.08;
  const box = d.roundFins
    ? new RoundedBoxGeometry(radial, 0.007, depth, 1, 0.0028)
    : new THREE.BoxGeometry(radial, 0.007, depth);
  const m = new THREE.Matrix4();
  for (let k = 0; k < FINS; k++) {
    const t = Math.PI / 2 + (k * Math.PI * 2) / FINS;
    // Box x runs out from the axis, y across the fin, z along the body.
    m.makeRotationZ(t).setPosition(
      Math.cos(t) * (0.03 + radial / 2),
      Math.sin(t) * (0.03 + radial / 2),
      -0.375,
    );
    addStock(s, box, m, PART.plate);
  }
  box.dispose();
  return s;
}

// -- The eye: housing, brow, lens, glass ------------------------------------------

/** The eye's frame: y looks forward along +z; angle 0 is right, π/2 is up. */
const EYE_FRAME: Frame = { o: EYE.position, y: [0, 0, 1], z: [1, 0, 0], x: [0, 1, 0] };

/** The glass's front ring: a spherical zone with a round opening for the iris. */
const GLASS = { radius: 0.11, outer: 0.078, inner: 0.045, outerY: 0.005 } as const;

/** Where the iris blades sit and how far they open, in the eye's frame. */
export const IRIS = {
  blades: 8,
  /** Aperture radius closed and open. */
  closed: 0.01,
  open: 0.04,
  /** The blades' length out from their inner edge. */
  length: 0.036,
  /** Depth along the eye's axis of the first blade, and the step between stacked blades. */
  y: 0.0008,
  step: 0.0004,
} as const;

function buildEye(d: Detail, bolts: Shape): Shape {
  const s = new Shape();
  const n = d.eye;
  lathe(
    s,
    EYE_FRAME,
    [
      { r: 0.112, y: -0.09, ao: 0.6 },
      { r: 0.104, y: -0.02 },
      { r: 0.098, y: 0.012, edge: 0.6 },
      { r: 0.093, y: 0.017, edge: 1 },
      { r: 0.082, y: 0.017, edge: 1 },
      { r: 0.078, y: 0.012, edge: 0.6 },
      { r: 0.078, y: -0.012, ao: 0.5 },
      { r: 0.05, y: -0.015, ao: 0.35 },
    ],
    { segments: n, part: PART.hoop, aoFloor: 0.6, uvScale: UV_PER_UNIT },
  );
  // The lens: the core that glows, deep in the housing.
  lathe(
    s,
    EYE_FRAME,
    [
      { r: 0.05, y: -0.015 },
      { r: 0.036, y: -0.008 },
      { r: 0.018, y: -0.0042 },
      { r: 0, y: -0.003 },
    ],
    { segments: n, part: PART.lens, uvScale: UV_PER_UNIT },
  );
  // The glass: a dark ring around the iris's opening, catching the hangar's strips.
  const centre = GLASS.outerY - Math.sqrt(GLASS.radius ** 2 - GLASS.outer ** 2);
  const zone: Ring[] = [0, 1, 2, 3].map((k) => {
    const r = GLASS.outer + ((GLASS.inner - GLASS.outer) * k) / 3;
    return { r, y: centre + Math.sqrt(GLASS.radius ** 2 - r * r) };
  });
  const lipY = zone[3]!.y;
  lathe(s, EYE_FRAME, [...zone, { r: GLASS.inner, y: lipY - 0.009, ao: 0.7 }], {
    segments: n,
    part: PART.glass,
    uvScale: UV_PER_UNIT,
  });
  // The brow over the eye, its front lip shading the glass from above.
  lathe(
    s,
    EYE_FRAME,
    [
      { r: 0.1, y: -0.075, ao: 0.7 },
      { r: 0.118, y: -0.06 },
      { r: 0.127, y: -0.005 },
      { r: 0.124, y: 0.024, edge: 1 },
      { r: 0.112, y: 0.034, edge: 1 },
      { r: 0.1, y: 0.033, edge: 0.6 },
      { r: 0.097, y: 0.02, ao: 0.8 },
      { r: 0.1, y: -0.075, ao: 0.7 },
    ],
    {
      segments: d.brow,
      part: PART.plate,
      from: (20 * Math.PI) / 180,
      to: (160 * Math.PI) / 180,
      caps: true,
      aoFloor: 0.6,
      uvScale: UV_PER_UNIT,
    },
  );
  for (let k = 0; k < 4; k++) {
    const phi = Math.PI / 4 + (k * Math.PI) / 2;
    bolt(bolts, place(EYE_FRAME, 0.0875, phi, 0.0165), [0, 0, 1], 0.34, d.boltChamfer);
  }
  return s;
}

/** The hull's parts, each built and creased on its own. Every one has the same attributes. */
export function buildHullParts(lod: HullLod): { name: string; geometry: THREE.BufferGeometry }[] {
  const d = DETAIL[lod];
  const bolts = new Shape();
  const plates = buildPlates(d, bolts);
  const eye = buildEye(d, bolts);
  const parts: [string, Shape][] = [
    ['core', buildCore(d)],
    ['plates', plates],
    ['hoops', buildHoops(d)],
    ['collar', buildCollar(d)],
    ['sockets', buildSockets(d)],
    ['fins', buildFins(d)],
    ['eye', eye],
    ['bolts', bolts],
  ];
  return parts.map(([name, shape]) => ({ name, geometry: shape.geometry(false) }));
}

/** The hull and eye as one geometry: one draw call. */
export function buildHull(lod: HullLod): THREE.BufferGeometry {
  const parts = buildHullParts(lod);
  const merged = mergeGeometries(parts.map((p) => p.geometry)) as THREE.BufferGeometry | null;
  for (const p of parts) p.geometry.dispose();
  if (!merged) throw new Error(`The Sentinel's ${lod} hull parts do not share their attributes`);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// -- Instanced parts -----------------------------------------------------------------

/**
 * One rigid tentacle segment, along +y over [0, 1] with radius 1: the instance
 * matrix scales y by its length and x, z by its radius. Octagonal (or
 * hexagonal) facets; from the root: a socket rim, a collar, the light groove
 * (aEmit 1), a faceted taper, a neck and a knuckle that sits in the next
 * segment's socket. Two polished rods run along opposite facets.
 */
export function buildVertebra(sides: 6 | 8): THREE.BufferGeometry {
  const s = new Shape();
  const f: Frame = { o: [0, 0, 0], y: [0, 1, 0], z: [0, 0, 1], x: [1, 0, 0] };
  lathe(
    s,
    f,
    [
      { r: 0, y: 0.05, ao: 0.35 },
      { r: 0.78, y: 0, ao: 0.5, edge: 1 },
      { r: 0.95, y: 0.045, edge: 1 },
      { r: 0.95, y: 0.11, edge: 0.7 },
      { r: 0.85, y: 0.13, emit: 1, ao: 0.8 },
      { r: 0.85, y: 0.2, emit: 1, ao: 0.8 },
      { r: 0.93, y: 0.225, edge: 1 },
      { r: 0.86, y: 0.56 },
      { r: 0.57, y: 0.7, ao: 0.75 },
      { r: 0.54, y: 0.82, ao: 0.55 },
      { r: 0.63, y: 0.88, edge: 0.8 },
      { r: 0.6, y: 0.955 },
      { r: 0.32, y: 0.99, ao: 0.6 },
      { r: 0, y: 1, ao: 0.5 },
    ],
    { segments: sides, part: PART.vertebra, uvScale: 0.16 },
  );
  // The rods sit on two opposite facets, square in section.
  const facet = Math.PI / sides;
  for (const phi of [facet, facet + Math.PI]) {
    const axis = place(f, 1, phi, 0);
    const rod = frame([axis[0] * 0.9, 0, axis[2] * 0.9], [0, 1, 0], axis);
    lathe(
      s,
      rod,
      [
        { r: 0.07, y: 0.12, ao: 0.8 },
        { r: 0.07, y: 0.92, edge: 0.5 },
        { r: 0, y: 0.93 },
      ],
      {
        segments: 4,
        part: PART.rod,
        from: Math.PI / 4,
        to: Math.PI / 4 + Math.PI * 2,
        uvScale: 0.16,
      },
    );
    // A bracket ties the rod's free end to the neck.
    const bracket = frame([axis[0] * 0.72, 0.885, axis[2] * 0.72], axis, [0, 1, 0]);
    lathe(
      s,
      bracket,
      [
        { r: 0.04, y: -0.18, ao: 0.6 },
        { r: 0.04, y: 0.12 },
      ],
      { segments: 4, part: PART.rod, uvScale: 0.16 },
    );
  }
  return s.geometry(true);
}

/**
 * One talon of a claw, along +y over [0, 1] from its hinge, 1 radius thick at
 * the root: the instance matrix scales y by its length and x, z by its
 * thickness. It hooks toward −x, so x should point away from the tentacle's
 * axis for the talons to close on what they grip. Its tip glows (aEmit).
 */
export function buildClawFinger(): THREE.BufferGeometry {
  const s = new Shape();
  // A blade-like section: a sharp ridge on the inside (−x), a rounded back.
  const section: [number, number][] = [
    [-1, 0],
    [-0.35, 0.85],
    [0.55, 0.7],
    [1, 0],
    [0.55, -0.7],
    [-0.35, -0.85],
  ];
  const stations = [0, 0.2, 0.4, 0.6, 0.78, 0.92];
  const ring = (t: number): Vert[] => {
    const hx = 0.75 * (1 - 0.85 * t);
    const hz = 0.55 * (1 - 0.8 * t);
    const cx = -0.2 * t - 1.8 * t * t * t;
    const emit = Math.max(0, Math.min(1, (t - 0.6) / 0.3));
    return section.map(([x, z], k) =>
      vert(
        [cx + x * hx, t, z * hz],
        k / section.length,
        t * 0.5,
        PART.claw,
        0.6 + 0.4 * Math.min(1, t / 0.4),
        k === 0 ? 1 : 0.15,
        emit,
      ),
    );
  };
  const rings = stations.map(ring);
  const tip = vert([-0.2 - 1.8, 1, 0], 0.5, 0.5, PART.claw, 1, 1, 1);
  const base = vert([0, 0, 0], 0.5, 0, PART.claw, 0.5, 0, 0);
  const m = section.length;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < m; k++) {
      const a = rings[r]![k]!;
      const b = rings[r]![(k + 1) % m]!;
      const c = rings[r + 1]![(k + 1) % m]!;
      const dd = rings[r + 1]![k]!;
      s.quad(a, b, c, dd);
    }
  }
  const last = rings[rings.length - 1]!;
  const lastT = stations[stations.length - 1]!;
  const axis: Vec3 = [-0.2 * lastT - 1.8 * lastT ** 3, lastT, 0];
  for (let k = 0; k < m; k++) {
    const a = last[k]!;
    const b = last[(k + 1) % m]!;
    const mid: Vec3 = [0, 1, 2].map((i) => (a.p[i]! + b.p[i]! + tip.p[i]!) / 3) as Vec3;
    s.triFacing(a, b, tip, sub(mid, axis));
  }
  for (let k = 0; k < m; k++) {
    s.triFacing(base, rings[0]![(k + 1) % m]!, rings[0]![k]!, [0, -1, 0]);
  }
  return s.geometry(true);
}

/**
 * One blade of the iris, in its own frame: its inner edge on the y axis, the
 * blade running out along +x to 1 and curving round toward +y, its face
 * toward +z (out of the eye). Eight of them, turned about the eye's axis and
 * slid in and out, close the aperture into an octagon.
 */
export function buildIrisBlade(): THREE.BufferGeometry {
  const s = new Shape();
  const steps = 4;
  const thick = 0.06;
  const edge = (x: number, side: -1 | 1, z: number): Vert => {
    const w = 0.5 + 0.55 * x;
    const y = 0.35 * x * x + side * w;
    return vert([x, y, z], x * 0.3, (y + 1) * 0.3, PART.core, 0.75, x === 0 ? 1 : 0.2);
  };
  for (let i = 0; i < steps; i++) {
    const x0 = i / steps;
    const x1 = (i + 1) / steps;
    // Face.
    s.quad(edge(x0, -1, thick), edge(x1, -1, thick), edge(x1, 1, thick), edge(x0, 1, thick));
    // Long sides.
    s.triFacing(edge(x0, -1, 0), edge(x1, -1, 0), edge(x1, -1, thick), [0, -1, 0]);
    s.triFacing(edge(x0, -1, 0), edge(x1, -1, thick), edge(x0, -1, thick), [0, -1, 0]);
    s.triFacing(edge(x0, 1, 0), edge(x1, 1, 0), edge(x1, 1, thick), [0, 1, 0]);
    s.triFacing(edge(x0, 1, 0), edge(x1, 1, thick), edge(x0, 1, thick), [0, 1, 0]);
  }
  for (const [x, out] of [
    [0, -1],
    [1, 1],
  ] as const) {
    s.triFacing(edge(x, -1, 0), edge(x, 1, 0), edge(x, 1, thick), [out, 0, 0]);
    s.triFacing(edge(x, -1, 0), edge(x, 1, thick), edge(x, -1, thick), [out, 0, 0]);
  }
  return s.geometry(true);
}

// -- Placing the iris -----------------------------------------------------------------

/** a × b for column-major 4×4 matrices, into `out` at `offset`. */
function multiply(a: Float32Array, b: ArrayLike<number>, out: Float32Array, offset: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[offset + c * 4 + r] =
        a[r]! * b[c * 4]! +
        a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! +
        a[12 + r]! * b[c * 4 + 3]!;
    }
  }
}

const blade = new Float32Array(16);

/**
 * The iris blades' instance matrices, creature space, for an aperture from 0
 * (closed) to 1 (open): each blade slides out to the aperture's radius and
 * turns a little as it opens, as a real iris's blades do.
 */
export function writeIrisMatrices(hull: Float32Array, aperture: number, out: Float32Array): void {
  const open = Math.max(0, Math.min(1, aperture));
  const radius = IRIS.closed + (IRIS.open - IRIS.closed) * open;
  const turn = (1 - open) * 0.35;
  const L = IRIS.length;
  for (let k = 0; k < IRIS.blades; k++) {
    const a = (k * Math.PI * 2) / IRIS.blades + turn;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Columns: out from the axis, round it, and along the eye's axis; all scaled by the blade's length.
    blade.set([
      c * L,
      sn * L,
      0,
      0,
      -sn * L,
      c * L,
      0,
      0,
      0,
      0,
      L,
      0,
      EYE.position[0] + c * radius,
      EYE.position[1] + sn * radius,
      EYE.position[2] + IRIS.y + k * IRIS.step,
      1,
    ]);
    multiply(hull, blade, out, k * 16);
  }
}

/** Where the eye's light sits, in the body frame: just in front of the lens. */
export const LENS_POINT: Vec3 = [EYE.position[0], EYE.position[1], EYE.position[2] + 0.02];
