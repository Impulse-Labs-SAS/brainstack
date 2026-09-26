// The brain in the Brain view: a signed distance field made of ellipsoids, a
// surface mesh sampled from it, and the force that keeps notes inside it.
// Generated, not loaded: there is no 3D model file to license or ship.
//
// Coordinates are normalised — the brain is about two units long — and scaled
// by the layout at draw time. y points up, x runs front (-) to back (+), z
// runs across the hemispheres, so the default camera sees the left side.

import { hash01 } from './graph-model';

interface Part {
  cx: number;
  cy: number;
  cz: number;
  rx: number;
  ry: number;
  rz: number;
  cos: number;
  sin: number;
  min: number;
}

// cx, cy, cz, rx, ry, rz, roll (rotation in the x-y plane), mirrored across z
const SPEC: ReadonlyArray<readonly [number, number, number, number, number, number, number, boolean]> = [
  [0.0, 0.08, 0.22, 0.98, 0.6, 0.56, 0, true], // hemisphere
  [-0.52, 0.0, 0.2, 0.5, 0.52, 0.5, -0.2, true], // frontal lobe
  [0.62, 0.05, 0.18, 0.42, 0.46, 0.46, 0.2, true], // occipital lobe
  [-0.06, -0.3, 0.4, 0.6, 0.28, 0.34, 0.12, true], // temporal lobe
  [0.56, -0.48, 0.2, 0.32, 0.21, 0.3, -0.12, true], // cerebellum
  [0.26, -0.7, 0, 0.11, 0.3, 0.12, -0.35, false], // brainstem
];

const PARTS: Part[] = SPEC.flatMap(([cx, cy, cz, rx, ry, rz, roll, mirror]) => {
  const part = { cx, cy, rx, ry, rz, cos: Math.cos(roll), sin: Math.sin(roll), min: Math.min(rx, ry, rz) };
  return mirror ? [{ ...part, cz }, { ...part, cz: -cz }] : [{ ...part, cz }];
});

function ellipsoid(x: number, y: number, z: number, p: Part): number {
  const dx = x - p.cx;
  const dy = y - p.cy;
  const u = (dx * p.cos + dy * p.sin) / p.rx;
  const v = (-dx * p.sin + dy * p.cos) / p.ry;
  const w = (z - p.cz) / p.rz;
  return (Math.sqrt(u * u + v * v + w * w) - 1) * p.min;
}

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Negative inside, positive outside, roughly in normalised units. */
export function brainSDF(x: number, y: number, z: number): number {
  let d = ellipsoid(x, y, z, PARTS[0]!);
  for (let i = 1; i < PARTS.length; i++) d = smoothMin(d, ellipsoid(x, y, z, PARTS[i]!), 0.12);
  // A shallow groove between the hemispheres, along the top only.
  const groove = 0.02 - Math.abs(z) - Math.max(0, 0.25 - y) * 1.2;
  return Math.max(d, groove);
}

/** The surface the mesh sits on: folded cortex, finer folia on the cerebellum. */
function foldedSDF(x: number, y: number, z: number): number {
  const d = brainSDF(x, y, z);
  if (d > 0.08 || d < -0.08) return d;
  if (x > 0.28 && y < -0.32) return d + 0.008 * Math.sin(y * 70 + x * 18);
  const g =
    Math.sin(10.5 * x + 2.3 * Math.sin(7.7 * y + 1.3)) *
    Math.sin(10.5 * y + 2.3 * Math.sin(7.7 * z + 0.7)) *
    Math.sin(10.5 * z + 2.3 * Math.sin(7.7 * x + 2.1));
  return d + 0.024 * g;
}

export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BrainMesh {
  /** xyz per point, normalised. */
  points: Float32Array;
  /** Two xyz points per segment. */
  segments: Float32Array;
}

/**
 * Points on the folded surface, each joined to its three nearest neighbours.
 * Seeded, so the mesh is the same on every visit.
 */
export function makeBrainMesh(count = 6000, seed = 7331): BrainMesh {
  const random = seededRandom(seed);
  const pts: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [-1.1, 1.1, -1.02, 0.76, -0.86, 0.86];
  for (let tries = 0; pts.length < count * 3 && tries < count * 150; tries++) {
    const x = x0 + random() * (x1 - x0);
    const y = y0 + random() * (y1 - y0);
    const z = z0 + random() * (z1 - z0);
    if (Math.abs(foldedSDF(x, y, z)) < 0.009) pts.push(x, y, z);
  }

  const n = pts.length / 3;
  const cell = 0.085;
  const grid = new Map<string, number[]>();
  const cellOf = (i: number) => [Math.floor(pts[i * 3]! / cell), Math.floor(pts[i * 3 + 1]! / cell), Math.floor(pts[i * 3 + 2]! / cell)] as const;
  for (let i = 0; i < n; i++) {
    const key = cellOf(i).join(',');
    const list = grid.get(key) ?? [];
    list.push(i);
    grid.set(key, list);
  }

  const seen = new Set<number>();
  const segs: number[] = [];
  const maxD2 = 0.09 * 0.09;
  for (let i = 0; i < n; i++) {
    const [gi, gj, gk] = cellOf(i);
    const near: Array<[number, number]> = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          for (const j of grid.get(`${gi + a},${gj + b},${gk + c}`) ?? []) {
            if (j === i) continue;
            const dx = pts[j * 3]! - pts[i * 3]!;
            const dy = pts[j * 3 + 1]! - pts[i * 3 + 1]!;
            const dz = pts[j * 3 + 2]! - pts[i * 3 + 2]!;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < maxD2) near.push([d2, j]);
          }
        }
      }
    }
    near.sort((p, q) => p[0] - q[0]);
    for (const [, j] of near.slice(0, 3)) {
      const key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!, pts[j * 3]!, pts[j * 3 + 1]!, pts[j * 3 + 2]!);
    }
  }
  return { points: new Float32Array(pts), segments: new Float32Array(segs) };
}

/** World size of the brain for `n` notes: volume grows with n, so density holds. */
export function brainScaleFor(n: number): number {
  return 34 * Math.cbrt(Math.max(1, n)) + 60;
}

/** Where each vault settles when several are visible: yours in the frontal lobe. */
export const LOBE_SPOTS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.48, 0.05, 0.12],
  [0.45, 0.12, -0.12],
  [0.0, -0.32, 0.25],
  [0.3, 0.3, 0.3],
  [-0.2, -0.1, -0.35],
  [0.55, -0.1, 0.3],
];

/** Each project gets its own depth, so a cluster stays whole inside the volume. */
export function projectDepth(key: string): number {
  return hash01(key) - 0.5;
}

interface SimNode {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * A d3-force force that keeps every node inside the smooth brain, a little
 * under the surface. Ignores alpha: the container must hold while the rest of
 * the layout cools.
 */
export function forceBrain(scale: () => number) {
  let nodes: SimNode[] = [];
  const margin = 0.07;
  const e = 0.006;
  function force() {
    const s = scale();
    for (const n of nodes) {
      const x = n.x / s;
      const y = n.y / s;
      const z = n.z / s;
      const d = brainSDF(x, y, z);
      if (d <= -margin) continue;
      const gx = brainSDF(x + e, y, z) - brainSDF(x - e, y, z);
      const gy = brainSDF(x, y + e, z) - brainSDF(x, y - e, z);
      const gz = brainSDF(x, y, z + e) - brainSDF(x, y, z - e);
      const len = Math.hypot(gx, gy, gz) || 1;
      const push = Math.min(d + margin, 0.3) * s * 0.24;
      n.vx -= (gx / len) * push;
      n.vy -= (gy / len) * push;
      n.vz -= (gz / len) * push;
    }
  }
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
  };
  return force;
}
