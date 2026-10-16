// The Territories camera: an orthographic view of the map, turned about the
// vertical axis (`az`) and tilted above the ground (`el`), zoomed by pixels per
// world unit (`ppu`) since an orthographic view has no distance to zoom by. The
// 2D overlay projects with `isoProject` and three.js is pointed to match it
// (`render/ortho.ts`), so a label sits on its block to the pixel.
//
// The ground is the world XY plane, z up. Looking straight down at azimuth 0
// the screen shows x right and y up, as the flat views' `projector()` does in
// lib/graph-camera.ts. Keep it that way: the map reads as the flat views do, not
// mirrored, and the layout's front corner (max x, min y) is the one nearest the
// viewer at the default turn.
//
// Pure: no DOM, no three.

import type { Viewport } from '@/lib/graph-camera';

import type { Rect } from '../../labels/placer';

export interface IsoCam {
  /** The target: the world point in the middle of the screen. */
  tx: number;
  ty: number;
  tz: number;
  /** Turn about the vertical axis, in radians. */
  az: number;
  /** Tilt above the ground: π/2 looks straight down. Above 0, or the ground has no height. */
  el: number;
  /** Screen pixels per world unit, the same at every depth. */
  ppu: number;
}

export interface Box3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** 2:1 dimetric, as approved in the prototype: a cell turned 45° is twice as wide as tall. */
export const ISO_EL = Math.PI / 6;
export const PLAN_EL = Math.PI / 2;

const FIT_MAX_PPU = 56;
const FIT_MIN_PPU = 1;
const FIT_MARGIN = 0.1;

interface Trig {
  ca: number;
  sa: number;
  se: number;
  ce: number;
}

const trigOf = (cam: IsoCam): Trig => ({
  ca: Math.cos(cam.az),
  sa: Math.sin(cam.az),
  se: Math.sin(cam.el),
  ce: Math.cos(cam.el),
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The azimuth for a quarter turn index: π/4 + k·π/2 in iso, k·π/2 in plan (axis-aligned).
 * In iso the view looks along a diagonal, so both axes recede alike; in plan it lines up
 * with them. Not wrapped: k keeps counting, so easing from one turn to the next is always
 * a quarter turn, whichever way.
 */
export function snapAz(turns: number, plan: boolean): number {
  return (plan ? 0 : Math.PI / 4) + (turns * Math.PI) / 2;
}

/** A projector for one frame. `depth` is in world units from the target's plane, larger farther. */
export function isoProject(
  cam: IsoCam,
  vp: Viewport,
): (x: number, y: number, z: number) => { x: number; y: number; depth: number } {
  const { ca, sa, se, ce } = trigOf(cam);
  const { tx, ty, tz, ppu } = cam;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  return (x, y, z) => {
    const dx = x - tx;
    const dy = y - ty;
    const dz = z - tz;
    // u runs to the right of the screen, w along the ground away from the viewer.
    const u = ca * dx + sa * dy;
    const w = -sa * dx + ca * dy;
    return { x: cx + ppu * u, y: cy - ppu * (w * se + dz * ce), depth: w * ce - dz * se };
  };
}

/** How far across the ground from the target is the point `dz` above it that shows at (sx, sy). */
function groundOffset(
  t: Trig,
  vp: Viewport,
  ppu: number,
  sx: number,
  sy: number,
  dz: number,
): { dx: number; dy: number } {
  const u = (sx - vp.width / 2) / ppu;
  const w = ((vp.height / 2 - sy) / ppu - dz * t.ce) / t.se;
  return { dx: t.ca * u - t.sa * w, dy: t.sa * u + t.ca * w };
}

/** The world point at height `z` that shows at (sx, sy). */
export function isoUnproject(
  cam: IsoCam,
  vp: Viewport,
  sx: number,
  sy: number,
  z: number,
): { x: number; y: number } {
  const o = groundOffset(trigOf(cam), vp, cam.ppu, sx, sy, z - cam.tz);
  return { x: cam.tx + o.dx, y: cam.ty + o.dy };
}

/**
 * The target (tx, ty; tz kept) that puts world point p at screen point s with cam's az, el
 * and ppu.
 */
export function targetFor(
  cam: IsoCam,
  vp: Viewport,
  p: { x: number; y: number; z: number },
  s: { x: number; y: number },
): { tx: number; ty: number } {
  const o = groundOffset(trigOf(cam), vp, cam.ppu, s.x, s.y, p.z - cam.tz);
  return { tx: p.x - o.dx, ty: p.y - o.dy };
}

/**
 * Zoom by factor about screen point (sx, sy), the world point there (at height z) staying
 * under it; ppu clamped to limits.
 */
export function isoZoomAt(
  cam: IsoCam,
  vp: Viewport,
  sx: number,
  sy: number,
  factor: number,
  z: number,
  limits: readonly [number, number],
): IsoCam {
  const p = { ...isoUnproject(cam, vp, sx, sy, z), z };
  const next = { ...cam, ppu: clamp(cam.ppu * factor, limits[0], limits[1]) };
  return { ...next, ...targetFor(next, vp, p, { x: sx, y: sy }) };
}

/**
 * The camera that fits these boxes into `free` (CSS px rect of the stage), keeping cam's az
 * and el; ppu ≤ maxPpu. The boxes are measured as they project, corner by corner, so a tall
 * box or a turned view fits as tightly as a flat one. No boxes: the camera as it is.
 */
export function isoFit(
  cam: IsoCam,
  vp: Viewport,
  boxes: readonly Box3[],
  free: Rect,
  opts: { maxPpu?: number; minPpu?: number; margin?: number } = {},
): IsoCam {
  if (!boxes.length) return { ...cam };
  const { maxPpu = FIT_MAX_PPU, minPpu = FIT_MIN_PPU, margin = FIT_MARGIN } = opts;
  const t = trigOf(cam);

  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    z0 = Math.min(z0, b.z0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
    z1 = Math.max(z1, b.z1);
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const mz = (z0 + z1) / 2;

  // The screen rectangle of every corner at ppu 1 round the centre, v up.
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const b of boxes) {
    for (const x of [b.x0, b.x1]) {
      for (const y of [b.y0, b.y1]) {
        for (const z of [b.z0, b.z1]) {
          const u = t.ca * (x - mx) + t.sa * (y - my);
          const v = (-t.sa * (x - mx) + t.ca * (y - my)) * t.se + (z - mz) * t.ce;
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
          v0 = Math.min(v0, v);
          v1 = Math.max(v1, v);
        }
      }
    }
  }
  // An axis the boxes have no extent along never limits the zoom.
  const across = u1 > u0 ? (free.w * (1 - margin)) / (u1 - u0) : Infinity;
  const down = v1 > v0 ? (free.h * (1 - margin)) / (v1 - v0) : Infinity;
  const next = { ...cam, ppu: clamp(Math.min(across, down), minPpu, maxPpu) };

  // The point in the middle of that rectangle, at the centre's height, goes to free's middle.
  const uc = (u0 + u1) / 2;
  const wc = (v0 + v1) / 2 / t.se;
  const middle = { x: mx + t.ca * uc - t.sa * wc, y: my + t.sa * uc + t.ca * wc, z: mz };
  const at = { x: free.x + free.w / 2, y: free.y + free.h / 2 };
  return { ...next, ...targetFor(next, vp, middle, at) };
}

/** Unit vector from the target toward the camera. */
export function viewDir(cam: IsoCam): [number, number, number] {
  const { ca, sa, se, ce } = trigOf(cam);
  return [sa * ce, -ca * ce, se];
}

/** Screen-up as a world vector (perpendicular to viewDir). */
export function viewUp(cam: IsoCam): [number, number, number] {
  const { ca, sa, se, ce } = trigOf(cam);
  return [-sa * se, ca * se, ce];
}

/** Exact at both ends, which `a + (b − a)·t` is not at t = 1. */
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/**
 * a → b at t in [0, 1], not eased: tx, ty, tz, az, el linear, ppu geometric, so a zoom feels
 * even. The caller eases t.
 * The azimuth goes the way a and b say, not the short way round: `snapAz` keeps counting
 * turns, so the caller already has the way it means.
 */
export function interpolateIso(a: IsoCam, b: IsoCam, t: number): IsoCam {
  return {
    tx: lerp(a.tx, b.tx, t),
    ty: lerp(a.ty, b.ty, t),
    tz: lerp(a.tz, b.tz, t),
    az: lerp(a.az, b.az, t),
    el: lerp(a.el, b.el, t),
    ppu: a.ppu ** (1 - t) * b.ppu ** t,
  };
}
