// The frame round the prompt as a body: the bar stage/bezel.ts draws, as a
// signed distance, so a claw rests on its surface and an arm is kept out of it
// (sentinel/landing.ts, sentinel/chain.ts). Pure maths, no three.
//
// The bar is a rounded-rectangle ring: its centreline is the rails' rectangle
// (`BezelShape`), and its cross-section a box `band` across in the frame's
// plane and `thickness` deep along its normal, the edges rounded by the bevel.
// So its distance is the section's, taken at the in-plane distance from that
// centreline: a rounded box's distance inside a rounded rectangle's. Both in
// closed form, a few dozen flops, and exact wherever the nearest point of the
// centreline is unique — everywhere but its medial axis, deep inside the box,
// far from the bar. The drawn bevel has two segments, so the drawn bar lies
// within bevel · (1 − cos 22.5°) of this; its arcs have eight, which is less.
//
// A capsule round each rail would cost as much and be wrong where it matters:
// the rails run `railForward` toward the viewer from the bar's middle, so a
// capsule round them puts the front face a third of the bar's depth off, and
// one round the middle still misses the faces and corners by more than a
// tentacle's tip is thick. This section follows the band, thickness and
// railForward knobs for free.

import type { ThreadSolid } from '../threads';
import type { Vec3 } from '../vec';

import type { BezelShape } from './perch-geometry';

/** The bar's bevel, world units: what bezelGeometry rounds its edges by, and what the solid rounds them by. */
export function bezelBevel(band: number, thickness: number): number {
  return Math.min(band, thickness) / 4;
}

/**
 * The bar of `b` as a solid, exactly as bezelGeometry builds it. The solid
 * keeps the shape's numbers, not the shape: a frame moved is a new solid.
 * `distance` allocates nothing.
 */
export function bezelSolid(b: BezelShape): ThreadSolid {
  const [cx, cy, cz] = b.centre;
  const [rx, ry, rz] = b.right;
  const [ux, uy, uz] = b.up;
  const [nx, ny, nz] = b.normal;
  const hw = b.width / 2;
  const hh = b.height / 2;
  const rc = Math.max(0, Math.min(b.radius, hw, hh));
  const bev = bezelBevel(b.band, b.thickness);
  // The section's flat faces, short of its half extents by the bevel.
  const fs = b.band / 2 - bev;
  const fz = b.thickness / 2 - bev;
  return {
    across: Math.hypot(b.band, b.thickness),
    distance(x, y, z, n: Vec3) {
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const lx = dx * rx + dy * ry + dz * rz;
      const ly = dx * ux + dy * uy + dz * uz;
      const lz = dx * nx + dy * ny + dz * nz;
      // In the frame's plane: signed distance `s` from the centreline (out of
      // the box positive), and its gradient (gx, gy) along right and up.
      // sign(0) is +1 throughout, so a point on an axis still has a way out.
      const sx = lx < 0 ? -1 : 1;
      const sy = ly < 0 ? -1 : 1;
      const qx = Math.abs(lx) - (hw - rc);
      const qy = Math.abs(ly) - (hh - rc);
      let s: number;
      let gx: number;
      let gy: number;
      if (qx > 0 && qy > 0) {
        // Off a corner: about its arc's centre.
        const l = Math.sqrt(qx * qx + qy * qy);
        s = l - rc;
        gx = (sx * qx) / l;
        gy = (sy * qy) / l;
      } else if (qx > qy) {
        s = qx - rc;
        gx = sx;
        gy = 0;
      } else {
        s = qy - rc;
        gx = 0;
        gy = sy;
      }
      // Across the section: a box `band` × `thickness`, its edges rounded by the bevel.
      const ss = s < 0 ? -1 : 1;
      const sz = lz < 0 ? -1 : 1;
      const bs = Math.abs(s) - fs;
      const bz = Math.abs(lz) - fz;
      let d: number;
      let gs: number;
      let gz: number;
      if (bs > 0 && bz > 0) {
        const l = Math.sqrt(bs * bs + bz * bz);
        d = l - bev;
        gs = (ss * bs) / l;
        gz = (sz * bz) / l;
      } else if (bs > bz) {
        d = bs - bev;
        gs = ss;
        gz = 0;
      } else {
        d = bz - bev;
        gs = 0;
        gz = sz;
      }
      // Both gradients are unit, and the in-plane one square to the normal: so is their sum.
      n[0] = gs * (gx * rx + gy * ux) + gz * nx;
      n[1] = gs * (gx * ry + gy * uy) + gz * ny;
      n[2] = gs * (gx * rz + gy * uz) + gz * nz;
      return d;
    },
  };
}
