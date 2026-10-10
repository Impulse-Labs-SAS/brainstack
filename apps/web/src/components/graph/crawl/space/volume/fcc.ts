// The frame of the face-centred cubic lattice notes stand on: its fixed turn,
// and the site nearest a point. Apart from lattice.ts, which enumerates the
// sites inside a form, so the form (cluster.ts) can put its bulbs' centres on
// sites without the two modules importing each other.
//
// In lattice coordinates a site is an integer (i, j, k) whose sum is even, one
// step `spacing / √2` apart: its twelve neighbours are the permutations of
// (±1, ±1, 0), every one exactly `spacing` away. The world point is that,
// turned by LATTICE_TURN — a fixed, odd rotation, so the lattice's rows line up
// with no world axis and no yaw the orbit camera opens on, and the layout does
// not read as a grid from any view a person is likely to take.

import type { Vec3 } from '../../vec';

/** A rotation by `angle` radians about `axis`, row-major 3 × 3. */
function rotation(axis: Vec3, angle: number): number[] {
  const l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  const x = axis[0] / l;
  const y = axis[1] / l;
  const z = axis[2] / l;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/** The lattice's fixed turn, row-major 3 × 3: 0.61 rad about (0.2, 1, 0.7). */
export const LATTICE_TURN: readonly number[] = rotation([0.2, 1, 0.7], 0.61);

/** World units between lattice coordinates one apart: neighbours are two such steps, √2 of them. */
export const fccStep = (spacing: number): number => spacing * Math.SQRT1_2;

/**
 * The FCC site nearest `p`, world units: where a bulb's centre is put, so its
 * first shell of sites is whole — a small sphere centred between sites loses
 * a share of them to the rounding. Conway and Sloane's nearest point of D₃:
 * round every coordinate, and if the sum comes out odd, move the one that
 * rounded furthest to its other neighbour.
 */
export function nearestSite(p: Vec3, spacing: number): Vec3 {
  const m = LATTICE_TURN;
  const s = fccStep(spacing);
  const q = [
    (m[0]! * p[0] + m[3]! * p[1] + m[6]! * p[2]) / s,
    (m[1]! * p[0] + m[4]! * p[1] + m[7]! * p[2]) / s,
    (m[2]! * p[0] + m[5]! * p[1] + m[8]! * p[2]) / s,
  ];
  const r = [Math.round(q[0]!), Math.round(q[1]!), Math.round(q[2]!)];
  if ((r[0]! + r[1]! + r[2]!) & 1) {
    let k = 0;
    let worst = -1;
    for (let i = 0; i < 3; i++) {
      const off = Math.abs(q[i]! - r[i]!);
      if (off > worst) {
        worst = off;
        k = i;
      }
    }
    r[k] = r[k]! + (q[k]! > r[k]! ? 1 : -1);
  }
  return [
    (m[0]! * r[0]! + m[1]! * r[1]! + m[2]! * r[2]!) * s,
    (m[3]! * r[0]! + m[4]! * r[1]! + m[5]! * r[2]!) * s,
    (m[6]! * r[0]! + m[7]! * r[1]! + m[8]! * r[2]!) * s,
  ];
}
