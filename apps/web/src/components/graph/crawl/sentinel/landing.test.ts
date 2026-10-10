import { describe, expect, it } from 'vitest';

import { boundsOf, type Viewport } from '@/lib/graph-camera';

import { bezelSolid } from '../prompt/bezel-solid';
import { PERCH_RAILS, withPerch } from '../prompt/perch-field';
import {
  DEFAULT_PERCH,
  perchShot,
  type BezelShape,
  type PerchKnobs,
} from '../prompt/perch-geometry';
import { sampleVault } from '../sample-vault';
import { polylineThreadField } from '../space/polyline-field';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
import type { Vec3 } from '../vec';

import { DEFAULT_GRIP } from './grips';
import { landOnSolid } from './landing';

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

const VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
];

/** A claw's clearance, about the creature's: its tip's radius and a fifth of a finger. */
const CLEARANCE = 0.04 * unit;

function framed(vp: Viewport, knobs: Partial<PerchKnobs> = {}) {
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
  const shot = perchShot({
    overview,
    vp,
    rect,
    unit,
    radius,
    knobs: { ...DEFAULT_PERCH, ...knobs },
  })!;
  return { shot, field: withPerch(space, shot), solid: bezelSolid(shot.bezel) };
}

/**
 * A point in the bar's own terms: in the frame's plane `x`, `y` from its
 * middle and `s` out from the rails' rounded rectangle, and `z` toward the
 * viewer; `straight` when it lies by a straight run of the rails, not a corner.
 */
function section(b: BezelShape, p: Vec3) {
  const d = [p[0] - b.centre[0], p[1] - b.centre[1], p[2] - b.centre[2]];
  const along = (v: Vec3) => d[0]! * v[0] + d[1]! * v[1] + d[2]! * v[2];
  const x = along(b.right);
  const y = along(b.up);
  const z = along(b.normal);
  const qx = Math.abs(x) - (b.width / 2 - b.radius);
  const qy = Math.abs(y) - (b.height / 2 - b.radius);
  const s = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.radius;
  return { x, y, z, s, straight: qx <= 0 || qy <= 0 };
}

const gap = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The landing for `rail` at `u`, the claw's socket at the perched body. */
function land(f: ReturnType<typeof framed>, rail: number, u: number): { at: Vec3; on: Vec3 } {
  const on: Vec3 = [0, 0, 0];
  expect(f.field.point(PERCH_RAILS[rail]!, u, on)).toBe(true);
  const at: Vec3 = [...on];
  const socket = f.shot.perch.body;
  expect(landOnSolid(f.field, f.solid, PERCH_RAILS[rail]!, u, socket, CLEARANCE, at)).toBe(true);
  return { at, on };
}

const STEPS = Math.round((DEFAULT_GRIP.uMax - DEFAULT_GRIP.uMin) / 0.01);
const uAt = (k: number) => DEFAULT_GRIP.uMin + k * 0.01;

describe('landOnSolid on the frame round the prompt', () => {
  it('rests a claw on the face it reaches from above: the top rail’s top, the bottom rail’s upper edge, behind the sides', () => {
    for (const vp of VIEWPORTS) {
      const f = framed(vp);
      const b = f.shot.bezel;
      for (let rail = 0; rail < 4; rail++) {
        let last: Vec3 | null = null;
        for (let k = 0; k <= STEPS; k++) {
          const { at } = land(f, rail, uAt(k));
          const d = f.solid.distance(at[0], at[1], at[2], [0, 0, 0]);
          expect(Math.abs(d - CLEARANCE)).toBeLessThan(1e-3 * unit);
          const sec = section(b, at);
          if (rail === 0) expect(sec.s).toBeGreaterThan(b.band / 2);
          if (rail === 2) expect(sec.s).toBeLessThan(-b.band / 2);
          if ((rail === 1 || rail === 3) && sec.straight) {
            expect(sec.z).toBeLessThan(-b.thickness / 2);
          }
          // Along the rail, corners included, it moves on without a jump.
          if (last) expect(gap(at, last) / unit).toBeLessThan(0.05);
          last = at;
        }
      }
    }
  });

  it('moves on continuously as the creature leans upright, the side claws turning to their socket', () => {
    for (const vp of [VIEWPORTS[0]!, VIEWPORTS[1]!]) {
      let before: Vec3[] | null = null;
      for (let tilt = 75; tilt <= 90; tilt++) {
        const f = framed(vp, { tilt });
        const now: Vec3[] = [];
        for (const rail of [1, 3]) {
          for (let k = 0; k <= STEPS; k += 4) {
            const { at, on } = land(f, rail, uAt(k));
            expect(at.every(Number.isFinite)).toBe(true);
            now.push(at);
            if (tilt !== 90 || !section(f.shot.bezel, on).straight) continue;
            // Upright, up runs along a side rail: the claw lands toward its socket, across the rail.
            const t = f.shot.bezel.up;
            const across = (v: Vec3): Vec3 => {
              const d = v.map((x, c) => x - on[c]!) as Vec3;
              const along = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
              const w = d.map((x, c) => x - t[c]! * along) as Vec3;
              const l = Math.hypot(...w);
              return w.map((x) => x / l) as Vec3;
            };
            const a = across(at);
            const s = across(f.shot.perch.body);
            expect(a[0] * s[0] + a[1] * s[1] + a[2] * s[2]).toBeGreaterThan(0.7);
          }
        }
        if (before) now.forEach((p, n) => expect(gap(p, before![n]!) / unit).toBeLessThan(0.05));
        before = now;
      }
    }
  });

  it('lands the rails on the bar’s very face — railForward at either end — as it lands any other', () => {
    // There the rails lie on the bar's face, at a distance of nought give or
    // take rounding: landed only from strictly inside, half the claws would
    // stay on the bare rail, a clearance from where their neighbours rest.
    for (const vp of VIEWPORTS) {
      for (const railForward of [-1, 1]) {
        const f = framed(vp, { railForward });
        for (let rail = 0; rail < 4; rail++) {
          for (let k = 0; k <= STEPS; k += 2) {
            const { at, on } = land(f, rail, uAt(k));
            expect(Math.abs(f.solid.distance(on[0], on[1], on[2], [0, 0, 0]))).toBeLessThan(
              1e-6 * unit,
            );
            const d = f.solid.distance(at[0], at[1], at[2], [0, 0, 0]);
            expect(Math.abs(d - CLEARANCE)).toBeLessThan(1e-3 * unit);
          }
        }
      }
    }
  });

  it('lands a point within its clearance of the body, and leaves one further out as it was', () => {
    const f = framed(VIEWPORTS[1]!);
    const b = f.shot.bezel;
    // Just off the bar's front face, by half a clearance: the claw rests on the bar.
    const near: Vec3 = [0, 0, 0];
    expect(f.field.point(PERCH_RAILS[0]!, 0.5, near)).toBe(true);
    const front = (b.thickness / 2) * (1 - DEFAULT_PERCH.railForward) + CLEARANCE / 2;
    for (let k = 0; k < 3; k++) near[k] = near[k]! + b.normal[k]! * front;
    expect(f.solid.distance(near[0], near[1], near[2], [0, 0, 0])).toBeGreaterThan(0);
    expect(
      landOnSolid(f.field, f.solid, PERCH_RAILS[0]!, 0.5, f.shot.perch.body, CLEARANCE, near),
    ).toBe(true);
    const d = f.solid.distance(near[0], near[1], near[2], [0, 0, 0]);
    expect(Math.abs(d - CLEARANCE)).toBeLessThan(1e-3 * unit);
    // A unit off the box's middle, toward the viewer: no body there.
    const out: Vec3 = b.centre.map((v, k) => v + b.normal[k]! * unit) as Vec3;
    const kept: Vec3 = [...out];
    expect(
      landOnSolid(f.field, f.solid, PERCH_RAILS[0]!, 0.5, f.shot.perch.body, CLEARANCE, out),
    ).toBe(false);
    expect(out).toEqual(kept);
    const lost: Vec3 = [Number.NaN, 0, 0];
    expect(
      landOnSolid(f.field, f.solid, PERCH_RAILS[0]!, 0.5, f.shot.perch.body, CLEARANCE, lost),
    ).toBe(false);
    expect(Number.isNaN(lost[0])).toBe(true);
  });
});
