import { describe, expect, it } from 'vitest';

import { projector, type Bounds, type Viewport } from '@/lib/graph-camera';

import {
  OVERVIEW_YAW,
  boundingRadius,
  notesReach,
  overviewCamera,
  stageZoomRange,
} from './overview';

const WIDE: Viewport = { width: 1280, height: 800 };
const TALL: Viewport = { width: 390, height: 844 };

const box = (size: number): Bounds => ({ cx: 4, cy: -2, cz: 7, w: size, h: size, d: size });
const build = (unit: number, size: number) => ({
  unit,
  bounds: box(size),
  camera: { pitch: 0.2, follow: 6 },
});

describe('overviewCamera', () => {
  it('looks at the middle of the box, from the angle asked', () => {
    const cam = overviewCamera(box(100), WIDE, OVERVIEW_YAW, 0.2);
    expect([cam.tx, cam.ty, cam.tz]).toEqual([4, -2, 7]);
    expect(cam.yaw).toBe(OVERVIEW_YAW);
    expect(cam.pitch).toBe(0.2);
  });

  it('keeps every corner of the box on screen, held upright too', () => {
    for (const vp of [WIDE, TALL]) {
      const b = box(100);
      const P = projector(overviewCamera(b, vp, OVERVIEW_YAW, 0.2), vp);
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const p = P(b.cx + (sx * b.w) / 2, b.cy + (sy * b.h) / 2, b.cz + (sz * b.d) / 2)!;
            // A corner may sit on the cone the sphere touches: on the edge, give or take rounding.
            expect(p.x).toBeGreaterThanOrEqual(-1e-6);
            expect(p.x).toBeLessThanOrEqual(vp.width + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(-1e-6);
            expect(p.y).toBeLessThanOrEqual(vp.height + 1e-6);
          }
    }
  });

  it('stands farther back on a phone held upright', () => {
    expect(overviewCamera(box(100), TALL, OVERVIEW_YAW, 0).dist).toBeGreaterThan(
      overviewCamera(box(100), WIDE, OVERVIEW_YAW, 0).dist,
    );
  });

  it('fits the sphere round the box', () => {
    expect(boundingRadius(box(2))).toBeCloseTo(Math.sqrt(3), 12);
  });
});

describe('notesReach', () => {
  it('is the farthest note from the point, plus the pad', () => {
    const notes: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, -3, 0],
      [0, 0, 2],
    ];
    expect(notesReach(notes, [0, 0, 0], 0.5)).toBeCloseTo(3.5, 12);
    expect(notesReach([], [0, 0, 0], 0.5)).toBe(0.5);
  });
});

describe('stageZoomRange', () => {
  it('goes in to a unit and a half', () => {
    expect(stageZoomRange(build(10, 100), WIDE).min).toBe(15);
  });

  it('goes out 150 units over a small space', () => {
    expect(stageZoomRange(build(10, 100), WIDE).max).toBe(1500);
  });

  it('goes out past the overview over a large one, by half again', () => {
    const b = build(10, 5000);
    const whole = overviewCamera(b.bounds, WIDE, OVERVIEW_YAW, b.camera.pitch).dist;
    expect(whole * 1.5).toBeGreaterThan(1500);
    expect(stageZoomRange(b, WIDE).max).toBeCloseTo(whole * 1.5, 9);
  });

  it('lets the wheel farther out where the overview stands farther back', () => {
    const b = build(10, 5000);
    expect(stageZoomRange(b, TALL).max).toBeGreaterThan(stageZoomRange(b, WIDE).max);
  });

  it('always leaves the whole space within reach', () => {
    for (const size of [10, 100, 1000, 10_000]) {
      const b = build(10, size);
      const whole = overviewCamera(b.bounds, WIDE, OVERVIEW_YAW, b.camera.pitch).dist;
      const r = stageZoomRange(b, WIDE);
      expect(r.min).toBeLessThan(r.max);
      expect(r.max).toBeGreaterThanOrEqual(whole);
    }
  });
});
