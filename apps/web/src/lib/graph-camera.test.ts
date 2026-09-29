import { describe, expect, it } from 'vitest';

import { basis, boundsOf, fitBounds, interpolate, outward, pixelsPerUnit, projector, zoomFlatAt, type Camera } from './graph-camera';

const vp = { width: 1000, height: 600 };
const flat: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 1000 };

describe('basis', () => {
  it('is orthonormal at any angle', () => {
    for (const cam of [flat, { ...flat, yaw: 0.7, pitch: -0.4 }, { ...flat, yaw: -2, pitch: 1.3 }]) {
      const { right, up, forward } = basis(cam);
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(right, up)).toBeCloseTo(0, 10);
      expect(dot(right, forward)).toBeCloseTo(0, 10);
      expect(dot(up, forward)).toBeCloseTo(0, 10);
      for (const v of [right, up, forward]) expect(dot(v, v)).toBeCloseTo(1, 10);
    }
  });

  it('looks straight down the z axis in the flat views, with y up', () => {
    const { forward, up, position } = basis(flat);
    expect(forward[0]).toBeCloseTo(0, 10);
    expect(forward[1]).toBeCloseTo(0, 10);
    expect(forward[2]).toBe(-1);
    expect(up[1]).toBeCloseTo(1, 10);
    expect(position[2]).toBe(1000);
  });
});

describe('projector', () => {
  it('puts the target in the middle of the screen, and y up means screen up', () => {
    const project = projector(flat, vp);
    expect(project(0, 0, 0)).toMatchObject({ x: 500, y: 300 });
    expect(project(0, 10, 0)!.y).toBeLessThan(300);
    expect(project(10, 0, 0)!.x).toBeGreaterThan(500);
  });

  it('scales by pixels per unit at the target depth', () => {
    const p = projector(flat, vp)(10, 0, 0)!;
    expect(p.x - 500).toBeCloseTo(10 * pixelsPerUnit(flat, vp), 6);
  });

  it('drops what is behind the camera', () => {
    expect(projector(flat, vp)(0, 0, 2000)).toBeNull();
  });
});

describe('fitBounds', () => {
  it('puts every point on screen', () => {
    const points = [
      { x: -400, y: -100, z: 0 },
      { x: 900, y: 300, z: 0 },
    ];
    const cam = { ...flat, ...fitBounds(boundsOf(points)!, vp) };
    const project = projector(cam, vp);
    for (const p of points) {
      const s = project(p.x, p.y, p.z)!;
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(vp.width);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(vp.height);
    }
  });
});

describe('zoomFlatAt', () => {
  it('keeps the world point under the cursor where it is', () => {
    const before = projector(flat, vp);
    const world = { x: 120, y: -45 };
    const at = before(world.x, world.y, 0)!;
    const zoomed = zoomFlatAt(flat, vp, at.x, at.y, 1.5, [1, 1e6]);
    const after = projector(zoomed, vp)(world.x, world.y, 0)!;
    expect(after.x).toBeCloseTo(at.x, 6);
    expect(after.y).toBeCloseTo(at.y, 6);
    expect(zoomed.dist).toBeCloseTo(flat.dist / 1.5, 6);
  });
});

describe('interpolate', () => {
  it('starts and ends where asked, and turns the short way round', () => {
    const a = { ...flat, yaw: 3 };
    const b = { ...flat, yaw: -3, dist: 100 };
    expect(interpolate(a, b, 0)).toMatchObject({ yaw: 3, dist: 1000 });
    const end = interpolate(a, b, 1);
    expect(end.dist).toBeCloseTo(100, 6);
    // -3 is 2π-3 the short way from 3: a small turn, not most of a circle.
    expect(end.yaw).toBeCloseTo(2 * Math.PI - 3, 6);
  });
});

describe('outward', () => {
  const cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.2, dist: 800 };
  const toScreen = projector(cam, vp);

  it('moves a point away from the centre on screen, and towards the viewer', () => {
    for (const p of [[120, 40, -60], [-80, -30, 90], [10, 100, 0]] as const) {
      const d = outward([...p], [0, 0, 0], basis(cam));
      expect(Math.hypot(...d)).toBeCloseTo(1, 10);
      const before = toScreen(p[0], p[1], p[2])!;
      const after = toScreen(p[0] + d[0] * 30, p[1] + d[1] * 30, p[2] + d[2] * 30)!;
      const centre = toScreen(0, 0, 0)!;
      expect(Math.hypot(after.x - centre.x, after.y - centre.y)).toBeGreaterThan(Math.hypot(before.x - centre.x, before.y - centre.y));
      expect(after.depth).toBeLessThan(before.depth);
    }
  });

  it('goes up from dead centre', () => {
    const d = outward([0, 0, 0], [0, 0, 0], basis(flat));
    expect(d[1]).toBeGreaterThan(0.8);
  });
});
