import { describe, expect, it } from 'vitest';

import { basis, boundsOf, type Viewport } from '@/lib/graph-camera';

import { sampleVault } from '../sample-vault';
import { HOVER } from '../sentinel/anatomy';
import { DEFAULT_GRIP, planPerchGrips } from '../sentinel/grips';
import { polylineThreadField } from '../space/polyline-field';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
import { threadEnds, type ThreadField, type ThreadKey } from '../threads';
import { dist, dot, len, type Vec3 } from '../vec';

import {
  PERCH_CORNERS,
  PERCH_ID,
  PERCH_RAILS,
  PERCH_RAIL_SET,
  UP_FAR,
  UP_NEAR,
  frameField,
  isPerchId,
  replayPerch,
  withPerch,
} from './perch-field';
import { DEFAULT_PERCH, perchShot, type PerchKnobs } from './perch-geometry';

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
const VP: Viewport = { width: 1280, height: 800 };
const RECT = { left: 360, top: 372, width: 560, height: 56, radius: 16 };

function shotAt(knobs: Partial<PerchKnobs> = {}, pitch = 0.3, vp = VP, rect = RECT) {
  const overview = overviewCamera(bounds, vp, 0.5, pitch);
  const radius = notesReach(
    layout.positions.values(),
    [overview.tx, overview.ty, overview.tz],
    unit,
  );
  return perchShot({ overview, vp, rect, unit, radius, knobs: { ...DEFAULT_PERCH, ...knobs } })!;
}

const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** A field that only says what it holds: no lengths of its own, nothing nearby. */
function bare(field: ThreadField): ThreadField {
  return {
    has: (k) => field.has(k),
    point: (k, u, out) => field.point(k, u, out),
    closest: (k, q, uMin, uMax) => field.closest(k, q, uMin, uMax),
    node: (id, out) => field.node(id, out),
    around: (ids, hops, max) => field.around(ids, hops, max),
    up: (p, out) => field.up(p, out),
  };
}

const keys = [...layout.routes.keys()];
const noteIds = [...layout.positions.keys()];

describe('the frame as threads', () => {
  it('names its node, corners and rails apart from any note', () => {
    expect(PERCH_CORNERS).toHaveLength(4);
    for (const id of [PERCH_ID, ...PERCH_CORNERS]) expect(isPerchId(id)).toBe(true);
    for (const id of noteIds) expect(isPerchId(id)).toBe(false);
    expect(PERCH_RAIL_SET.size).toBe(4);
    for (const key of PERCH_RAILS) expect(layout.routes.has(key)).toBe(false);
  });

  it('draws the four rails corner to corner, each from its key’s first id', () => {
    const shot = shotAt();
    const frame = frameField(shot);
    const p: Vec3 = [0, 0, 0];
    const q: Vec3 = [0, 0, 0];
    PERCH_RAILS.forEach((key, i) => {
      const [first, second] = threadEnds(key);
      // Top, right, bottom, left: between corner i and the next.
      expect([first, second].sort()).toEqual(
        [PERCH_CORNERS[i]!, PERCH_CORNERS[(i + 1) % 4]!].sort(),
      );
      expect(frame.has(key)).toBe(true);
      for (const [u, id] of [
        [0, first],
        [1, second],
      ] as const) {
        expect(frame.point(key, u, p)).toBe(true);
        expect(frame.node(id, q)).toBe(true);
        // Float32 lines, Float64 corners.
        expect(dist(p, q)).toBeLessThan(1e-4 * unit);
      }
    });
    // The left rail runs BL→TL as a rail, but from TL as a thread.
    expect(threadEnds(PERCH_RAILS[3]!)[0]).toBe(PERCH_CORNERS[0]);
    // The node beside all four; each corner beside its two.
    expect(frame.around([PERCH_ID], 1, 10).sort()).toEqual([...PERCH_RAILS].sort());
    expect(frame.around([PERCH_CORNERS[0]], 1, 10).sort()).toEqual(
      [PERCH_RAILS[0]!, PERCH_RAILS[3]!].sort(),
    );
  });
});

describe('withPerch', () => {
  it('places the perch node and the corners, and the notes as before', () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    const p: Vec3 = [0, 0, 0];
    expect(field.node(PERCH_ID, p)).toBe(true);
    expect(dist(p, shot.perch.node)).toBe(0);
    PERCH_CORNERS.forEach((id, i) => {
      expect(field.node(id, p)).toBe(true);
      expect(dist(p, shot.corners[i]!)).toBe(0);
    });
    const q: Vec3 = [0, 0, 0];
    for (const id of noteIds) {
      expect(field.node(id, p)).toBe(space.node(id, q));
      expect(p).toEqual(q);
    }
  });

  it("answers exactly as the space's own field for its threads", () => {
    const field = withPerch(space, shotAt());
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    for (const key of keys) {
      expect(field.has(key)).toBe(space.has(key));
      expect(field.length!(key)).toBe(space.length(key));
      for (const u of [0, 0.3, 1]) {
        expect(field.point(key, u, a)).toBe(space.point(key, u, b));
        expect(a).toEqual(b);
      }
    }
    for (const id of noteIds.slice(0, 20)) {
      const q: Vec3 = [0, 0, 0];
      space.node(id, q);
      q[0] += 0.3 * unit;
      for (const key of keys.slice(0, 30))
        expect(field.closest(key, q)).toEqual(space.closest(key, q));
      expect(field.nearby!(q, unit, 12)).toEqual(space.nearby(q, unit, 12));
      expect(field.around([id], 2, 40)).toEqual(space.around([id], 2, 40));
    }
  });

  it('finds the rails round the perch, and only the space’s threads among the notes', () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    const near = field.nearby!(shot.perch.body, 1.5 * unit, 20);
    expect(near.length).toBeGreaterThan(0);
    for (const key of near) expect(PERCH_RAIL_SET.has(key)).toBe(true);
    expect(field.around([PERCH_ID], 1, 10).sort()).toEqual([...PERCH_RAILS].sort());
    const p: Vec3 = [0, 0, 0];
    for (const id of noteIds) {
      field.node(id, p);
      for (const key of field.nearby!(p, unit, 20)) expect(PERCH_RAIL_SET.has(key)).toBe(false);
    }
    // Both asked of at once — a note and the perch — each part answers for its own.
    const mixed = field.around([PERCH_ID, noteIds[0]!], 1, 50);
    expect(mixed.filter((k) => PERCH_RAIL_SET.has(k))).toHaveLength(4);
    expect(mixed.filter((k) => !PERCH_RAIL_SET.has(k))).toEqual(space.around([noteIds[0]!], 1, 46));
  });

  it("is up the frame's at the perch, the space's far from it, and turns between without a jump", () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    const up: Vec3 = [0, 0, 0];
    field.up(shot.perch.node, up);
    expect(dist(up, shot.perch.up)).toBeLessThan(1e-12);
    // Toward a note, out past UP_FAR: a step at a time, never a jump.
    const note: Vec3 = [0, 0, 0];
    space.node(noteIds[0]!, note);
    const from = shot.perch.node;
    const span = dist(from, note);
    expect(span / unit).toBeGreaterThan(UP_FAR);
    let last: Vec3 | null = null;
    let most = 0;
    const steps = 400;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p: Vec3 = [0, 1, 2].map((k) => from[k]! + (note[k]! - from[k]!) * t) as Vec3;
      field.up(p, up);
      expect(len(up)).toBeCloseTo(1, 12);
      const d = dist(p, from) / unit;
      if (d <= UP_NEAR) expect(dist(up, shot.perch.up)).toBeLessThan(1e-12);
      if (d >= UP_FAR) expect(up).toEqual([0, 1, 0]);
      if (last) most = Math.max(most, angle(last, up) / ((span / unit) * (1 / steps)));
      last = [...up];
    }
    // Radians per creature unit: the whole turn over the six units between, eased.
    expect(most).toBeLessThan(0.6);
  });

  it('turns up about the screen’s right, finite and smooth, however it leans and the camera looks down', () => {
    for (let tilt = 0; tilt <= 90; tilt += 15) {
      for (const pitch of [-1.4, -0.7, 0, 0.3, 0.7, 1.4]) {
        const shot = shotAt({ tilt }, pitch);
        const field = withPerch(space, shot);
        const right = basis(shot.cam).right;
        const from = shot.perch.node;
        const toward = basis(shot.cam).forward;
        let last: Vec3 | null = null;
        let most = 0;
        for (let i = 0; i <= 200; i++) {
          const d = (UP_FAR + 1) * unit * (i / 200);
          const p: Vec3 = [0, 1, 2].map((k) => from[k]! + toward[k]! * d) as Vec3;
          const up: Vec3 = [0, 0, 0];
          field.up(p, up);
          expect(up.every(Number.isFinite)).toBe(true);
          expect(len(up)).toBeCloseTo(1, 9);
          // Never off the plane both ups lie in.
          expect(Math.abs(dot(up, right))).toBeLessThan(1e-9);
          if (last) most = Math.max(most, angle(last, up));
          last = up;
        }
        // At most 170° turned over six units, eased: never more than a few degrees a step.
        expect(most).toBeLessThan((6 * Math.PI) / 180);
      }
    }
  });

  it('moves the frame in place, or takes it away', () => {
    const shot = shotAt();
    const field = withPerch(space, shot);
    const p: Vec3 = [0, 0, 0];
    const before: Vec3 = [0, 0, 0];
    expect(field.point(PERCH_RAILS[0]!, 0.5, before)).toBe(true);
    const moved = shotAt({}, 0.3, VP, { ...RECT, top: RECT.top + 100 });
    field.setFrame(moved);
    expect(field.point(PERCH_RAILS[0]!, 0.5, p)).toBe(true);
    expect(dist(p, before)).toBeGreaterThan(0.3 * unit);
    expect(field.node(PERCH_ID, p)).toBe(true);
    expect(dist(p, moved.perch.node)).toBe(0);
    field.setFrame(null);
    expect(field.node(PERCH_ID, p)).toBe(false);
    for (const key of PERCH_RAILS) {
      expect(field.has(key)).toBe(false);
      expect(field.point(key, 0.5, p)).toBe(false);
      expect(field.closest(key, p)).toBeNull();
      expect(field.length!(key)).toBe(0);
    }
    expect(field.nearby!(moved.perch.body, 2 * unit, 10)).toEqual([]);
    expect(field.around([PERCH_ID], 1, 10)).toEqual([]);
    const up: Vec3 = [0, 0, 0];
    field.up(moved.perch.node, up);
    expect(up).toEqual([0, 1, 0]);
  });

  it('has no nearby or lengths over a field without them, and the grips still find the rails round the node', () => {
    const shot = shotAt();
    const field = withPerch(bare(space), shot);
    expect(field.nearby).toBeUndefined();
    expect(field.length).toBeUndefined();
    const perch = replayPerch(shot, { reach: 1 });
    const grips = planPerchGrips({
      hereId: PERCH_ID,
      forward: perch.heading,
      field,
      unit,
      lit: new Set(),
      held: [null, null, null, null, null, null],
      params: perch.grip,
    });
    expect(grips.length).toBeGreaterThanOrEqual(5);
    for (const g of grips) {
      expect(PERCH_RAIL_SET.has(g.key as ThreadKey)).toBe(true);
      expect(g.u).toBeGreaterThanOrEqual(DEFAULT_GRIP.uMin);
      expect(g.u).toBeLessThanOrEqual(DEFAULT_GRIP.uMax);
    }
  });
});

describe('replayPerch', () => {
  it('sets out from where a walk floats the body exactly where it clings', () => {
    const shot = shotAt();
    const perch = replayPerch(shot, { reach: 1.1, crossing: 2.5, release: 0.35 });
    expect(perch.id).toBe(PERCH_ID);
    expect(perch.keys).toBe(PERCH_RAIL_SET);
    expect(perch.grip).toEqual({ reach: 1.1 });
    expect(perch.crossing).toBe(2.5);
    expect(perch.release).toBe(0.35);
    expect(dist(perch.heading, shot.perch.heading)).toBe(0);
    // Hover above it, along the frame's up: the body, to the last digit a walk can see.
    const field = withPerch(space, shot);
    const up: Vec3 = [0, 0, 0];
    field.up(perch.at!, up);
    const floated = [0, 1, 2].map((k) => perch.at![k]! + up[k]! * HOVER * unit) as Vec3;
    expect(dist(floated, shot.perch.body)).toBeLessThan(1e-9 * unit);
    expect(replayPerch(shot).grip).toBeUndefined();
  });
});
