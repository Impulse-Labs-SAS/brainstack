import { describe, expect, it } from 'vitest';

import { boundsOf, type Viewport } from '@/lib/graph-camera';
import { seededRandom } from '@/lib/graph-brain';

import { sampleVault } from '../sample-vault';
import { BODY_SCALE } from '../sentinel/anatomy';
import { SENTINEL_SEED, makeRig } from '../sentinel/rig';
import { polylineThreadField } from '../space/polyline-field';
import { volumeLayout } from '../space/volume/layout';
import { bezelGeometry } from '../stage/bezel';
import { notesReach, overviewCamera } from '../stage/overview';
import type { ThreadSolid } from '../threads';
import type { Vec3 } from '../vec';

import { bezelBevel, bezelSolid } from './bezel-solid';
import { PERCH_RAILS, frameField, withPerch } from './perch-field';
import { DEFAULT_PERCH, perchShot, type BezelShape, type PerchKnobs } from './perch-geometry';

const vault = sampleVault();
const layout = volumeLayout(vault.model);
const unit = layout.unit;
const space = polylineThreadField({
  nodes: layout.positions,
  routes: layout.routes,
  adjacency: layout.adjacency,
  cell: unit,
});
const bounds = boundsOf([...layout.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
const LAPTOP: Viewport = { width: 1280, height: 800 };

function shotAt(knobs: Partial<PerchKnobs> = {}, vp: Viewport = LAPTOP) {
  const width = Math.min(560, 0.8 * vp.width);
  const rect = {
    left: (vp.width - width) / 2,
    top: (vp.height - 56) / 2,
    width,
    height: 56,
    radius: 16,
  };
  const overview = overviewCamera(bounds, vp, 0.5, 0.3);
  const radius = notesReach(
    layout.positions.values(),
    [overview.tx, overview.ty, overview.tz],
    unit,
  );
  return perchShot({ overview, vp, rect, unit, radius, knobs: { ...DEFAULT_PERCH, ...knobs } })!;
}

/** A point given in the bezel's own frame: right, up and toward the viewer from its middle. */
function placed(b: BezelShape, x: number, y: number, z: number): Vec3 {
  return [0, 1, 2].map(
    (k) => b.centre[k]! + b.right[k]! * x + b.up[k]! * y + b.normal[k]! * z,
  ) as Vec3;
}

const distanceOf = (solid: ThreadSolid, p: Vec3, n: Vec3 = [0, 0, 0]) =>
  solid.distance(p[0], p[1], p[2], n);

/** A thick bar with a wide band: the bevel at its largest against the defaults. */
const THICK: Partial<PerchKnobs> = { band: 0.2, thickness: 0.15, margin: 0.25 };

describe('bezelSolid', () => {
  it('is zero on every vertex of the bar as it is drawn', () => {
    for (const knobs of [{}, THICK]) {
      const shape = shotAt(knobs).bezel;
      const solid = bezelSolid(shape);
      const position = bezelGeometry(shape).getAttribute('position');
      let worst = 0;
      for (let v = 0; v < position.count; v++) {
        const p = placed(shape, position.getX(v), position.getY(v), position.getZ(v));
        worst = Math.max(worst, Math.abs(distanceOf(solid, p)));
      }
      expect(position.count).toBeGreaterThan(100);
      // The arcs' and the bevel's vertices lie on the curves the solid follows exactly.
      expect(worst / unit).toBeLessThan(2e-4);
    }
  });

  it('rounds its edges by the bevel the drawn bar has', () => {
    expect(bezelBevel(0.09, 0.07)).toBeCloseTo(0.0175, 12);
    const shape = shotAt(THICK).bezel;
    const solid = bezelSolid(shape);
    // Out from the top bar's back outer edge along its diagonal: the bevel's
    // arc, not the box's corner, so as far as the bevel rounds it off.
    const bev = bezelBevel(shape.band, shape.thickness);
    const corner = placed(shape, 0, shape.height / 2 + shape.band / 2, -shape.thickness / 2);
    expect(distanceOf(solid, corner) / unit).toBeCloseTo(((Math.SQRT2 - 1) * bev) / unit, 9);
  });

  it('holds every rail inside the bar, as far behind its front face as the rail is', () => {
    for (const vp of [LAPTOP, { width: 375, height: 812 }]) {
      const shot = shotAt({}, vp);
      const solid = bezelSolid(shot.bezel);
      const th = shot.bezel.thickness / 2;
      const want = -(th - DEFAULT_PERCH.railForward * th);
      for (const rail of shot.rails) {
        for (const p of rail) expect(distanceOf(solid, p) - want).toBeCloseTo(0, 9);
      }
    }
  });

  it('has a unit normal that is its gradient, is 1-Lipschitz, and no section wider than `across`', () => {
    const shot = shotAt();
    const solid = bezelSolid(shot.bezel);
    const rails = frameField(shot);
    const random = seededRandom(11);
    /** A point near the bar: on a rail, then up to `reach` units off it every way. */
    const near = (reach: number): Vec3 => {
      const c: Vec3 = [0, 0, 0];
      rails.point(PERCH_RAILS[Math.floor(random() * 4)]!, random(), c);
      return c.map((v) => v + (random() * 2 - 1) * reach * unit) as Vec3;
    };
    const h = 1e-4 * unit;
    const gradient = (p: Vec3, step: number): Vec3 =>
      [0, 1, 2].map((k) => {
        const a = [...p] as Vec3;
        const b = [...p] as Vec3;
        a[k]! += step;
        b[k]! -= step;
        return (distanceOf(solid, a) - distanceOf(solid, b)) / (2 * step);
      }) as Vec3;
    let checked = 0;
    for (let s = 0; s < 2000; s++) {
      const p = near(0.12);
      const n: Vec3 = [0, 0, 0];
      distanceOf(solid, p, n);
      expect(Math.hypot(...n)).toBeCloseTo(1, 9);
      // Two stencils that disagree straddle a crease of the field: its medial lines.
      const g = gradient(p, h);
      const g2 = gradient(p, 2 * h);
      if (Math.hypot(g[0] - g2[0], g[1] - g2[1], g[2] - g2[2]) > 1e-5) continue;
      checked++;
      expect(Math.hypot(g[0] - n[0], g[1] - n[1], g[2] - n[2])).toBeLessThan(1e-3);
    }
    expect(checked).toBeGreaterThan(1600);

    for (let s = 0; s < 2000; s++) {
      const p = near(0.15);
      const q = p.map((v) => v + (random() * 2 - 1) * 0.3 * unit) as Vec3;
      const apart = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      expect(Math.abs(distanceOf(solid, p) - distanceOf(solid, q))).toBeLessThanOrEqual(
        apart + 1e-9 * unit,
      );
    }

    // The surface round each rail's middle, found along rays across the
    // section from the rail: no two points of it further apart than `across`.
    const b = shot.bezel;
    const outward: Vec3[] = [
      b.up,
      b.right,
      b.up.map((v) => -v) as Vec3,
      b.right.map((v) => -v) as Vec3,
    ];
    PERCH_RAILS.forEach((key, i) => {
      const c: Vec3 = [0, 0, 0];
      rails.point(key, 0.5, c);
      const rim: Vec3[] = [];
      for (let a = 0; a < 64; a++) {
        const t = (2 * Math.PI * a) / 64;
        const dir = [0, 1, 2].map(
          (k) => outward[i]![k]! * Math.cos(t) + b.normal[k]! * Math.sin(t),
        ) as Vec3;
        let lo = 0;
        let hi = solid.across;
        for (let n = 0; n < 50; n++) {
          const mid = (lo + hi) / 2;
          if (distanceOf(solid, c.map((v, k) => v + dir[k]! * mid) as Vec3) < 0) lo = mid;
          else hi = mid;
        }
        rim.push(c.map((v, k) => v + dir[k]! * lo) as Vec3);
      }
      let widest = 0;
      for (const p of rim) {
        for (const q of rim)
          widest = Math.max(widest, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
      // The section's diagonal, less what the bevels round off its corners.
      expect(widest).toBeGreaterThan(0.8 * solid.across);
      expect(widest).toBeLessThanOrEqual(solid.across);
    });
  });
});

describe('withPerch’s solid', () => {
  it('is the bar wherever the ball asked about reaches it, the same object each time, and null elsewhere', () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    const bar = bezelSolid(shot.bezel);
    const on = shot.rails[0]![4]!;
    const solid = field.solid!(on, 0);
    expect(solid).not.toBeNull();
    expect(field.solid!(shot.rails[2]![3]!, 0)).toBe(solid);
    // The body clings behind the box, clear of the bar: only a ball as wide as its distance reaches it.
    const d = distanceOf(bar, shot.perch.body);
    expect(d).toBeGreaterThan(0);
    expect(field.solid!(shot.perch.body, d * 0.999)).toBeNull();
    expect(field.solid!(shot.perch.body, d * 1.001)).toBe(solid);
    // What it answers is the bar itself.
    const n: Vec3 = [0, 0, 0];
    const m: Vec3 = [0, 0, 0];
    expect(distanceOf(solid!, shot.perch.body, n)).toBe(distanceOf(bar, shot.perch.body, m));
    expect(n).toEqual(m);
  });

  it('is null with the frame taken away', () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    field.setFrame(null);
    expect(field.solid!(shot.rails[0]![4]!, 1e9)).toBeNull();
    field.setFrame(shot);
    expect(field.solid!(shot.rails[0]![4]!, 0)).not.toBeNull();
  });

  it('is null at every note, as far as any arm reaches: the walk among them never meets the frame', () => {
    const rig = makeRig(3, unit, SENTINEL_SEED, BODY_SCALE);
    let reach = 0;
    for (let i = 0; i < rig.tentacles; i++) {
      const k = i * 3;
      const socket = Math.hypot(rig.socket[k]!, rig.socket[k + 1]!, rig.socket[k + 2]!) * unit;
      const tube = rig.segRadius[rig.segStart[i]!]!;
      reach = Math.max(reach, socket + rig.length[i]! * Math.max(1, rig.maxStretch[i]!) + tube);
    }
    for (const vp of [LAPTOP, { width: 375, height: 812 }, { width: 2560, height: 1440 }]) {
      const field = withPerch(space, shotAt({}, vp));
      for (const p of layout.positions.values()) expect(field.solid!(p, reach)).toBeNull();
    }
  });

  it('answers with the space’s own bodies away from the frame', () => {
    const own: ThreadSolid = { across: 1, distance: () => -1 };
    const shot = shotAt();
    const field = withPerch({ ...space, solid: () => own }, shot);
    const note = layout.positions.values().next().value!;
    expect(field.solid!(note, 0)).toBe(own);
    expect(field.solid!(shot.rails[0]![4]!, 0)).not.toBe(own);
  });
});
