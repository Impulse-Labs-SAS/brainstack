import { describe, expect, it } from 'vitest';

import {
  pixelsPerUnit,
  projector,
  TAN_HALF_FOV,
  type Camera,
  type Viewport,
} from '@/lib/graph-camera';

import type { Rect } from '../../labels/placer';

import {
  ISO_EL,
  PLAN_EL,
  interpolateIso,
  isoFit,
  isoProject,
  isoUnproject,
  isoZoomAt,
  snapAz,
  targetFor,
  viewDir,
  viewUp,
  type Box3,
  type IsoCam,
} from './camera';

const VP: Viewport = { width: 1280, height: 720 };
const ISO: IsoCam = { tx: 0, ty: 0, tz: 0, az: Math.PI / 4, el: ISO_EL, ppu: 24 };

/** A small LCG, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Cameras at any turn and tilt between flat-ish and straight down, aimed anywhere. */
function randomCams(seed: number, count: number): IsoCam[] {
  const r = rng(seed);
  const cams: IsoCam[] = [ISO, { ...ISO, el: PLAN_EL, az: 0 }];
  while (cams.length < count) {
    cams.push({
      tx: (r() - 0.5) * 400,
      ty: (r() - 0.5) * 400,
      tz: (r() - 0.5) * 4,
      az: (r() - 0.5) * 4 * Math.PI,
      el: 0.15 + r() * (PLAN_EL - 0.15),
      ppu: 0.5 + r() * 80,
    });
  }
  return cams;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

describe('isoProject', () => {
  it('looking straight down at azimuth 0, is the flat views’ projector on the ground', () => {
    const r = rng(1);
    for (let i = 0; i < 40; i++) {
      const vp = { width: 300 + r() * 1600, height: 300 + r() * 900 };
      const ppu = 0.5 + r() * 60;
      const tx = (r() - 0.5) * 500;
      const ty = (r() - 0.5) * 500;
      const flat: Camera = {
        tx,
        ty,
        tz: 0,
        yaw: 0,
        pitch: 0,
        dist: vp.height / 2 / (TAN_HALF_FOV * ppu),
      };
      expect(pixelsPerUnit(flat, vp)).toBeCloseTo(ppu, 9);
      const classic = projector(flat, vp);
      const iso = isoProject({ tx, ty, tz: 0, az: 0, el: PLAN_EL, ppu }, vp);
      for (let k = 0; k < 20; k++) {
        const x = tx + (r() - 0.5) * 2 * (vp.width / ppu);
        const y = ty + (r() - 0.5) * 2 * (vp.height / ppu);
        const a = classic(x, y, 0)!;
        const b = iso(x, y, 0);
        expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
        expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('puts the target in the middle and draws a turned cell twice as wide as tall', () => {
    const project = isoProject(ISO, VP);
    expect(project(0, 0, 0)).toMatchObject({ x: 640, y: 360, depth: 0 });
    const corners = [project(0, 0, 0), project(1, 0, 0), project(0, 1, 0), project(1, 1, 0)];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const wide = Math.max(...xs) - Math.min(...xs);
    const tall = Math.max(...ys) - Math.min(...ys);
    expect(wide / tall).toBeCloseTo(2, 9);
  });

  it('shows the front corner (max x, min y) nearest and lowest at the default turn', () => {
    const project = isoProject({ ...ISO, az: snapAz(0, false) }, VP);
    const front = project(10, -10, 0);
    for (const [x, y] of [
      [-10, -10],
      [10, 10],
      [-10, 10],
    ] as const) {
      const other = project(x, y, 0);
      expect(front.depth).toBeLessThan(other.depth);
      expect(front.y).toBeGreaterThan(other.y);
    }
  });

  it('draws higher things higher on screen, short of looking straight down', () => {
    for (const cam of randomCams(2, 20).filter((c) => c.el < PLAN_EL - 0.01)) {
      const project = isoProject(cam, VP);
      expect(project(cam.tx, cam.ty, cam.tz + 1).y).toBeLessThan(project(cam.tx, cam.ty, cam.tz).y);
    }
  });
});

describe('isoUnproject and targetFor', () => {
  it('undo isoProject at the height asked', () => {
    const r = rng(3);
    for (const cam of randomCams(4, 40)) {
      const project = isoProject(cam, VP);
      for (let k = 0; k < 10; k++) {
        const p = {
          x: cam.tx + (r() - 0.5) * 300,
          y: cam.ty + (r() - 0.5) * 300,
          z: (r() - 0.5) * 6,
        };
        const s = project(p.x, p.y, p.z);
        const back = isoUnproject(cam, VP, s.x, s.y, p.z);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('puts the world point at the screen point, keeping tz', () => {
    const r = rng(5);
    for (const cam of randomCams(6, 40)) {
      const p = { x: (r() - 0.5) * 300, y: (r() - 0.5) * 300, z: (r() - 0.5) * 6 };
      const s = { x: r() * VP.width, y: r() * VP.height };
      const moved = { ...cam, ...targetFor(cam, VP, p, s) };
      expect(moved.tz).toBe(cam.tz);
      const at = isoProject(moved, VP)(p.x, p.y, p.z);
      expect(Math.abs(at.x - s.x)).toBeLessThan(1e-6);
      expect(Math.abs(at.y - s.y)).toBeLessThan(1e-6);
    }
  });
});

describe('isoZoomAt', () => {
  it('keeps the world point under the cursor where it is', () => {
    const r = rng(7);
    for (const cam of randomCams(8, 30)) {
      const sx = r() * VP.width;
      const sy = r() * VP.height;
      const z = r() * 1.2;
      const world = isoUnproject(cam, VP, sx, sy, z);
      const factor = 0.5 + r() * 1.5;
      const zoomed = isoZoomAt(cam, VP, sx, sy, factor, z, [0.01, 1e4]);
      expect(zoomed.ppu).toBeCloseTo(cam.ppu * factor, 9);
      expect(zoomed).toMatchObject({ az: cam.az, el: cam.el, tz: cam.tz });
      const after = isoProject(zoomed, VP)(world.x, world.y, z);
      expect(Math.abs(after.x - sx)).toBeLessThan(1e-6);
      expect(Math.abs(after.y - sy)).toBeLessThan(1e-6);
    }
  });

  it('stops at the limits, still holding the point', () => {
    const world = isoUnproject(ISO, VP, 200, 500, 0.6);
    const limits = [4, 40] as const;
    const inward = isoZoomAt(ISO, VP, 200, 500, 100, 0.6, limits);
    const outward = isoZoomAt(ISO, VP, 200, 500, 0.001, 0.6, limits);
    expect(inward.ppu).toBe(40);
    expect(outward.ppu).toBe(4);
    for (const cam of [inward, outward]) {
      const at = isoProject(cam, VP)(world.x, world.y, 0.6);
      expect(at.x).toBeCloseTo(200, 6);
      expect(at.y).toBeCloseTo(500, 6);
    }
  });
});

describe('snapAz', () => {
  it('is π/4 + kπ/2 in iso and kπ/2 in plan, negative turns too', () => {
    for (let k = -6; k <= 6; k++) {
      expect(snapAz(k, false)).toBeCloseTo(Math.PI / 4 + (k * Math.PI) / 2, 12);
      expect(snapAz(k, true)).toBeCloseTo((k * Math.PI) / 2, 12);
    }
    expect(snapAz(0, true)).toBe(0);
    expect(snapAz(-1, false)).toBeCloseTo(-Math.PI / 4, 12);
  });

  it('looks along a diagonal in iso and along an axis in plan', () => {
    for (let k = -4; k <= 4; k++) {
      const iso = snapAz(k, false);
      expect(Math.abs(Math.cos(iso))).toBeCloseTo(Math.abs(Math.sin(iso)), 12);
      const plan = snapAz(k, true);
      expect(Math.min(Math.abs(Math.cos(plan)), Math.abs(Math.sin(plan)))).toBeCloseTo(0, 12);
    }
  });
});

describe('isoFit', () => {
  const FREE: Rect = { x: 40, y: 90, w: 820, h: 560 };

  const cornersOf = (b: Box3) =>
    [b.x0, b.x1].flatMap((x) =>
      [b.y0, b.y1].flatMap((y) => [b.z0, b.z1].map((z) => ({ x, y, z }))),
    );

  /** The screen rectangle the boxes' corners cover. */
  function screenBox(cam: IsoCam, boxes: readonly Box3[]) {
    const project = isoProject(cam, VP);
    const pts = boxes.flatMap(cornersOf).map((p) => project(p.x, p.y, p.z));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  function randomBoxes(r: () => number, scale: number): Box3[] {
    const count = 1 + Math.floor(r() * 6);
    return Array.from({ length: count }, () => {
      const x0 = (r() - 0.5) * scale;
      const y0 = (r() - 0.5) * scale;
      const z0 = r() * 0.9;
      return {
        x0,
        y0,
        z0,
        x1: x0 + 0.5 + r() * scale * 0.4,
        y1: y0 + 0.5 + r() * scale * 0.4,
        z1: z0 + 0.3 + r(),
      };
    });
  }

  it('fits every corner inside the free rect, touching it on the limiting axis', () => {
    const r = rng(9);
    for (const cam of randomCams(10, 40)) {
      const boxes = randomBoxes(r, 10 + r() * 60);
      const free: Rect = { x: r() * 200, y: r() * 150, w: 200 + r() * 900, h: 150 + r() * 500 };
      const fitted = isoFit(cam, VP, boxes, free, { maxPpu: 1e4, minPpu: 1e-4 });
      expect(fitted).toMatchObject({ az: cam.az, el: cam.el, tz: cam.tz });
      const s = screenBox(fitted, boxes);
      const eps = 1e-6;
      expect(s.x0).toBeGreaterThanOrEqual(free.x - eps);
      expect(s.x1).toBeLessThanOrEqual(free.x + free.w + eps);
      expect(s.y0).toBeGreaterThanOrEqual(free.y - eps);
      expect(s.y1).toBeLessThanOrEqual(free.y + free.h + eps);
      // Centred on the free rect, and as large as the margin lets it be on one axis.
      expect((s.x0 + s.x1) / 2).toBeCloseTo(free.x + free.w / 2, 6);
      expect((s.y0 + s.y1) / 2).toBeCloseTo(free.y + free.h / 2, 6);
      const across = (s.x1 - s.x0) / (free.w * 0.9);
      const down = (s.y1 - s.y0) / (free.h * 0.9);
      expect(Math.max(across, down)).toBeCloseTo(1, 9);
    }
  });

  it('caps the zoom at maxPpu and floors it at minPpu, still centred', () => {
    const tiny: Box3[] = [{ x0: 0, y0: 0, z0: 0, x1: 0.62, y1: 0.62, z1: 0.5 }];
    const capped = isoFit(ISO, VP, tiny, FREE);
    expect(capped.ppu).toBe(56);
    expect(isoFit(ISO, VP, tiny, FREE, { maxPpu: 30 }).ppu).toBe(30);
    const huge: Box3[] = [{ x0: -5000, y0: -5000, z0: 0, x1: 5000, y1: 5000, z1: 0.3 }];
    expect(isoFit(ISO, VP, huge, FREE).ppu).toBe(1);
    const s = screenBox(capped, tiny);
    expect((s.x0 + s.x1) / 2).toBeCloseTo(FREE.x + FREE.w / 2, 6);
    expect((s.y0 + s.y1) / 2).toBeCloseTo(FREE.y + FREE.h / 2, 6);
  });

  it('leaves the margin asked for', () => {
    const boxes: Box3[] = [{ x0: -20, y0: -12, z0: 0, x1: 24, y1: 30, z1: 0.6 }];
    const fitted = isoFit(ISO, VP, boxes, FREE, { margin: 0.3 });
    const s = screenBox(fitted, boxes);
    const fill = Math.max((s.x1 - s.x0) / FREE.w, (s.y1 - s.y0) / FREE.h);
    expect(fill).toBeCloseTo(0.7, 9);
  });

  it('fits a box with no size, or none along one screen axis, without NaN', () => {
    const point: Box3[] = [{ x0: 3, y0: -2, z0: 0.6, x1: 3, y1: -2, z1: 0.6 }];
    const atPoint = isoFit(ISO, VP, point, FREE);
    expect(atPoint.ppu).toBe(56);
    const p = isoProject(atPoint, VP)(3, -2, 0.6);
    expect(p.x).toBeCloseTo(FREE.x + FREE.w / 2, 6);
    expect(p.y).toBeCloseTo(FREE.y + FREE.h / 2, 6);
    // Looking straight down at azimuth 0, a line along y has no width: its length decides.
    const plan = { ...ISO, az: 0, el: PLAN_EL };
    const line: Box3[] = [{ x0: 1, y0: -40, z0: 0, x1: 1, y1: 40, z1: 0 }];
    const fitted = isoFit(plan, VP, line, FREE);
    expect(fitted.ppu).toBeCloseTo((FREE.h * 0.9) / 80, 9);
    expect(Object.values(fitted).every(Number.isFinite)).toBe(true);
  });

  it('keeps the camera as it is when there is nothing to fit', () => {
    expect(isoFit(ISO, VP, [], FREE)).toEqual(ISO);
  });
});

describe('viewDir and viewUp', () => {
  it('are unit and perpendicular', () => {
    for (const cam of randomCams(11, 40)) {
      const d = viewDir(cam);
      const u = viewUp(cam);
      expect(dot(d, d)).toBeCloseTo(1, 12);
      expect(dot(u, u)).toBeCloseTo(1, 12);
      expect(dot(d, u)).toBeCloseTo(0, 12);
    }
  });

  it('agree with isoProject: viewDir is the line of sight, viewUp is screen up', () => {
    const r = rng(12);
    for (const cam of randomCams(13, 40)) {
      const project = isoProject(cam, VP);
      const d = viewDir(cam);
      const u = viewUp(cam);
      const p = [cam.tx + (r() - 0.5) * 50, cam.ty + (r() - 0.5) * 50, (r() - 0.5) * 4] as const;
      const at = project(...p);
      const step = 1 + r() * 9;
      // Toward the camera: the same pixel, nearer by exactly the step.
      const nearer = project(p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step);
      expect(nearer.x).toBeCloseTo(at.x, 6);
      expect(nearer.y).toBeCloseTo(at.y, 6);
      expect(at.depth - nearer.depth).toBeCloseTo(step, 9);
      // Away from it: farther by the step.
      const farther = project(p[0] - d[0] * step, p[1] - d[1] * step, p[2] - d[2] * step);
      expect(farther.depth - at.depth).toBeCloseTo(step, 9);
      // Up: straight up the screen by ppu pixels a unit.
      const up = project(p[0] + u[0] * step, p[1] + u[1] * step, p[2] + u[2] * step);
      expect(up.x).toBeCloseTo(at.x, 6);
      expect(at.y - up.y).toBeCloseTo(step * cam.ppu, 6);
    }
  });

  it('looks straight down in plan, with screen up along y at azimuth 0', () => {
    const plan = { ...ISO, az: 0, el: PLAN_EL };
    const close = (v: readonly number[], to: readonly number[]) =>
      v.forEach((c, i) => expect(c).toBeCloseTo(to[i]!, 12));
    close(viewDir(plan), [0, 0, 1]);
    close(viewUp(plan), [0, 1, 0]);
  });
});

describe('interpolateIso', () => {
  const a: IsoCam = { tx: -10, ty: 4, tz: 0, az: snapAz(3, false), el: ISO_EL, ppu: 4 };
  const b: IsoCam = { tx: 30, ty: -8, tz: 0.6, az: snapAz(4, true), el: PLAN_EL, ppu: 64 };

  it('lands exactly on both ends', () => {
    expect(interpolateIso(a, b, 0)).toEqual(a);
    expect(interpolateIso(a, b, 1)).toEqual(b);
    // −7.3 + (1.9 − (−7.3))·1 is not 1.9 in floating point: the end must be b's own value.
    const odd = interpolateIso({ ...a, tx: -7.3 }, { ...b, tx: 1.9 }, 1);
    expect(odd.tx).toBe(1.9);
  });

  it('moves linearly, zooms geometrically and does not ease', () => {
    const quarter = interpolateIso(a, b, 0.25);
    expect(quarter.tx).toBeCloseTo(0, 12);
    expect(quarter.ty).toBeCloseTo(1, 12);
    expect(quarter.tz).toBeCloseTo(0.15, 12);
    expect(quarter.el).toBeCloseTo(ISO_EL + (PLAN_EL - ISO_EL) / 4, 12);
    expect(quarter.ppu).toBeCloseTo(8, 9);
    expect(interpolateIso(a, b, 0.5).ppu).toBeCloseTo(16, 9);
  });

  it('turns the way the azimuths say, not the short way round', () => {
    const from = { ...a, az: snapAz(0, false) };
    const to = { ...a, az: snapAz(3, false) };
    expect(interpolateIso(from, to, 0.5).az).toBeCloseTo(Math.PI / 4 + (3 * Math.PI) / 4, 12);
  });
});
