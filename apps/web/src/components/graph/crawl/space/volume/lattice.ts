// The sites notes stand on inside the cluster: a face-centred cubic lattice
// (fcc.ts) cut to the form. FCC because every site has twelve neighbours, all
// exactly one spacing away, and it is the densest packing: regions grow round
// over its adjacency instead of along rows, and the only pairs that could come
// closer than three quarters of a spacing once notes are jittered off their
// sites are first-shell pairs, which the jitter checks.
//
// Built for every layout, so the hot loops follow one style: inline
// arithmetic, typed-array grids instead of sets, no tuple per candidate. Each
// part of the form is scanned over its own ball of lattice points, and each
// point is probed once whichever parts' balls it falls in.

import type { Vec3 } from '../../vec';

import { PARTS, SITE_INSET, probe, type Cluster, type Probe } from './cluster';
import { LATTICE_TURN, fccStep } from './fcc';

export interface VolumeLattice {
  count: number;
  /** World positions, xyz per site, canonical order (by lattice key). */
  points: Float64Array;
  /** Per site, its part number (cluster.ts). */
  part: Int8Array;
  /** Neighbours of site v: adj[offsets[v]] up to adj[offsets[v + 1]], ascending, each `spacing` away. */
  offsets: Uint32Array;
  adj: Uint32Array;
  spacing: number;
  /** Sites per part number, length PARTS. */
  counts: Int32Array;
}

/** The twelve neighbours in lattice coordinates: the permutations of (±1, ±1, 0). */
const SHELL: readonly (readonly [number, number, number])[] = [-1, 1].flatMap((p) =>
  [-1, 1].flatMap((q) => [[p, q, 0] as const, [p, 0, q] as const, [0, p, q] as const]),
);

/** The lattice's sites inside `c`, each at least SITE_INSET spacings in from its surface. */
export function fccLattice(c: Cluster): VolumeLattice {
  const a = c.spacing;
  const s = fccStep(a);
  const m = LATTICE_TURN;
  const m0 = m[0]!;
  const m1 = m[1]!;
  const m2 = m[2]!;
  const m3 = m[3]!;
  const m4 = m[4]!;
  const m5 = m[5]!;
  const m6 = m[6]!;
  const m7 = m[7]!;
  const m8 = m[8]!;
  // Every site lies inside some part, so within the form's radius of the
  // centre: |i|, |j|, |k| < N, and a site's neighbours are always in the grid.
  const n = Math.ceil((c.radius + c.blend) / s);
  const w = 2 * n + 1;
  const ww = w * w;
  // Per lattice point: 0 not yet probed, 1 probed and outside, 2 + its part when kept.
  const seen = new Uint8Array(ww * w);
  const kept: number[] = [];
  const out: Probe = { d: 0, part: 0 };
  const inside = -SITE_INSET * a;

  /**
   * Probes every unseen point of even parity in the ball of radius `r` round
   * world point (x, y, z) — and, for a neck, only the points within `thick`
   * of its axis, `axis` (xyz, world, from the hub's centre): its ball is
   * mostly empty space round a thin capsule.
   */
  const scan = (x: number, y: number, z: number, r: number, axis?: Vec3, thick = 0) => {
    const ax = axis ? axis[0] : 0;
    const ay = axis ? axis[1] : 0;
    const az = axis ? axis[2] : 0;
    const aa = ax * ax + ay * ay + az * az;
    const reach = (thick + c.blend / 4) ** 2;
    // Lattice coordinates of the centre: the turn's transpose, over the step.
    const qi = (m0 * x + m3 * y + m6 * z) / s;
    const qj = (m1 * x + m4 * y + m7 * z) / s;
    const qk = (m2 * x + m5 * y + m8 * z) / s;
    const h = (r + c.blend / 4) / s;
    const hh = h * h;
    const i0 = Math.max(-n, Math.ceil(qi - h));
    const i1 = Math.min(n, Math.floor(qi + h));
    for (let i = i0; i <= i1; i++) {
      const di = i - qi;
      const j0 = Math.max(-n, Math.ceil(qj - h));
      const j1 = Math.min(n, Math.floor(qj + h));
      for (let j = j0; j <= j1; j++) {
        const dj = j - qj;
        const rest = hh - di * di - dj * dj;
        if (rest < 0) continue;
        const span = Math.sqrt(rest);
        let k = Math.max(-n, Math.ceil(qk - span));
        const k1 = Math.min(n, Math.floor(qk + span));
        if ((i + j + k) & 1) k++;
        for (; k <= k1; k += 2) {
          const key = (i + n) * ww + (j + n) * w + (k + n);
          if (seen[key] !== 0) continue;
          const px = (m0 * i + m1 * j + m2 * k) * s;
          const py = (m3 * i + m4 * j + m5 * k) * s;
          const pz = (m6 * i + m7 * j + m8 * k) * s;
          if (aa > 0) {
            let t = (px * ax + py * ay + pz * az) / aa;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = px - ax * t;
            const dy = py - ay * t;
            const dz = pz - az * t;
            if (dx * dx + dy * dy + dz * dz > reach) continue;
          }
          probe(c, px, py, pz, out);
          if (out.d <= inside) {
            seen[key] = 2 + out.part;
            kept.push(key);
          } else seen[key] = 1;
        }
      }
    }
  };

  scan(0, 0, 0, c.hub.radius);
  for (const l of c.lobes) scan(l.centre[0], l.centre[1], l.centre[2], l.radius);
  c.necks.forEach((neck, i) => {
    // The capsule runs from the hub's centre to its lobe's (cluster.ts), but
    // only its stretch between the two balls just scanned is new ground:
    // nearer the hub than R − rn along its axis it lies inside the hub's ball,
    // and likewise at the lobe's end.
    const rn = neck.radius;
    const [tx, ty, tz] = neck.to;
    const span = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const from = Math.max(0, c.hub.radius - rn);
    const to = Math.min(span, span - c.lobes[i]!.radius + rn);
    if (to <= from) return;
    const mid = (from + to) / 2 / span;
    scan(tx * mid, ty * mid, tz * mid, (to - from) / 2 + rn, neck.to, rn);
  });
  if (c.satellite) {
    const { centre, radius } = c.satellite;
    scan(centre[0], centre[1], centre[2], radius);
  }

  // Numbered by key, whatever order the parts were scanned in.
  const keys = Int32Array.from(kept).sort();
  const count = keys.length;
  const site = new Int32Array(ww * w).fill(-1);
  const points = new Float64Array(count * 3);
  const part = new Int8Array(count);
  const counts = new Int32Array(PARTS);
  for (let v = 0; v < count; v++) {
    const key = keys[v]!;
    site[key] = v;
    const i = Math.floor(key / ww) - n;
    const j = Math.floor((key % ww) / w) - n;
    const k = (key % w) - n;
    points[v * 3] = (m0 * i + m1 * j + m2 * k) * s;
    points[v * 3 + 1] = (m3 * i + m4 * j + m5 * k) * s;
    points[v * 3 + 2] = (m6 * i + m7 * j + m8 * k) * s;
    const p = seen[key]! - 2;
    part[v] = p;
    counts[p]!++;
  }

  // Neighbours through the grid. Sites are numbered in key order, so with the
  // steps ascending the neighbours come out ascending too.
  const step = SHELL.map(([di, dj, dk]) => di * ww + dj * w + dk).sort((x, y) => x - y);
  const offsets = new Uint32Array(count + 1);
  const adj = new Uint32Array(count * 12);
  let filled = 0;
  for (let v = 0; v < count; v++) {
    const key = keys[v]!;
    for (const d of step) {
      const u = site[key + d]!;
      if (u >= 0) adj[filled++] = u;
    }
    offsets[v + 1] = filled;
  }

  return {
    count,
    points,
    part,
    offsets,
    adj: adj.slice(0, filled),
    spacing: a,
    counts,
  };
}
