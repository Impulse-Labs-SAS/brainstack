// Camera maths for the graph, shared by the WebGL scene, the 2D overlay drawn
// on top of it and the pointer handling. Pure, so the overlay's projection is
// provably the same one three.js renders with.
//
// The camera orbits a target: `yaw` turns around the vertical axis, `pitch`
// tilts, `dist` is how far back it sits. The flat views keep yaw and pitch at
// zero and look straight down the z axis.

export interface Camera {
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
  dist: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export type Vec3 = [number, number, number];

export const FOV_DEG = 38;
export const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

export const ANGLES = {
  side: { yaw: 0, pitch: 0.06 },
  top: { yaw: 0, pitch: 1.38 },
  front: { yaw: -Math.PI / 2, pitch: 0.06 },
  threeQuarter: { yaw: 0.5, pitch: 0.16 },
} as const;
export type AnglePreset = keyof typeof ANGLES;

export function basis(cam: Camera): { right: Vec3; up: Vec3; forward: Vec3; position: Vec3 } {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const right: Vec3 = [cy, 0, -sy];
  const forward: Vec3 = [-sy * cp, -sp, -cy * cp];
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const position: Vec3 = [cam.tx - forward[0] * cam.dist, cam.ty - forward[1] * cam.dist, cam.tz - forward[2] * cam.dist];
  return { right, up, forward, position };
}

/** Screen pixels per world unit at the target's depth. */
export function pixelsPerUnit(cam: Camera, vp: Viewport): number {
  return vp.height / 2 / (TAN_HALF_FOV * cam.dist);
}

export function nearPlane(cam: Camera): number {
  return Math.max(1, cam.dist * 0.02);
}

export interface Projected {
  x: number;
  y: number;
  depth: number;
  /** Screen pixels per world unit at this depth. */
  scale: number;
}

/** A projector for one frame: same maths as three's PerspectiveCamera. */
export function projector(cam: Camera, vp: Viewport): (x: number, y: number, z: number) => Projected | null {
  const { right, up, forward, position } = basis(cam);
  const near = nearPlane(cam);
  const f = 1 / TAN_HALF_FOV;
  const aspect = vp.width / vp.height;
  return (x, y, z) => {
    const dx = x - position[0];
    const dy = y - position[1];
    const dz = z - position[2];
    const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
    if (depth < near) return null;
    const vx = dx * right[0] + dy * right[1] + dz * right[2];
    const vy = dx * up[0] + dy * up[1] + dz * up[2];
    return {
      x: (1 + (f / aspect) * (vx / depth)) * (vp.width / 2),
      y: (1 - f * (vy / depth)) * (vp.height / 2),
      depth,
      scale: vp.height / 2 / (TAN_HALF_FOV * depth),
    };
  };
}

/**
 * Which way is out for a point, as the camera sees it: away from `center`
 * across the screen, and part of the way towards the viewer. Straight out
 * from the centre would push a note at the back of the brain further back,
 * where it is hardest to see. `axes` is the camera's `basis`, computed once
 * per frame by the caller. A unit vector.
 */
export function outward(point: Vec3, center: Vec3, axes: Pick<ReturnType<typeof basis>, 'right' | 'up' | 'forward'>, towardViewer = 0.5): Vec3 {
  const { right, up, forward } = axes;
  const d = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  let sx = d[0]! * right[0] + d[1]! * right[1] + d[2]! * right[2];
  let sy = d[0]! * up[0] + d[1]! * up[1] + d[2]! * up[2];
  const len = Math.hypot(sx, sy);
  // Dead centre on screen: up is as good a way out as any.
  if (len < 1e-6) {
    sx = 0;
    sy = 1;
  } else {
    sx /= len;
    sy /= len;
  }
  const v: Vec3 = [0, 1, 2].map((i) => right[i]! * sx + up[i]! * sy - forward[i]! * towardViewer) as Vec3;
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

export interface Bounds {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
}

export function boundsOf(points: Iterable<{ x: number; y: number; z: number; radius?: number }>): Bounds | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const r = p.radius ?? 0;
    const z = Number.isFinite(p.z) ? p.z : 0;
    x0 = Math.min(x0, p.x - r);
    x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r);
    y1 = Math.max(y1, p.y + r);
    z0 = Math.min(z0, z - r);
    z1 = Math.max(z1, z + r);
  }
  if (x0 === Infinity) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), d: Math.max(1, z1 - z0) };
}

/** Target and distance that fit `b` on screen, with room for the overlays. */
export function fitBounds(b: Bounds, vp: Viewport, opts: { maxScale?: number; depth?: boolean } = {}): Pick<Camera, 'tx' | 'ty' | 'tz' | 'dist'> {
  const padX = vp.width < 700 ? 30 : 80;
  const padY = 70;
  const k = Math.min(opts.maxScale ?? 1.6, Math.max(0.03, Math.min((vp.width - padX * 2) / b.w, (vp.height - padY * 2) / b.h)));
  let dist = vp.height / 2 / (TAN_HALF_FOV * k);
  if (opts.depth) dist += b.d / 2;
  return { tx: b.cx, ty: b.cy, tz: opts.depth ? b.cz : 0, dist };
}

/** The whole brain of world size `scale` in view, a little low: the toolbar and legend sit over it. */
export function fitBrain(scale: number, vp: Viewport): Pick<Camera, 'tx' | 'ty' | 'tz' | 'dist'> {
  const aspect = vp.width / vp.height;
  const dist = (Math.max(0.98 * scale, (1.12 * scale) / aspect) / TAN_HALF_FOV + 0.55 * scale) * 1.14;
  return { tx: 0, ty: -0.24 * scale, tz: 0, dist };
}

/** Zoom a flat view keeping the world point under (px, py) exactly where it is. */
export function zoomFlatAt(cam: Camera, vp: Viewport, px: number, py: number, factor: number, limits: [number, number]): Camera {
  const p0 = pixelsPerUnit(cam, vp);
  const wx = cam.tx + (px - vp.width / 2) / p0;
  const wy = cam.ty - (py - vp.height / 2) / p0;
  const dist = Math.min(limits[1], Math.max(limits[0], cam.dist / factor));
  const next = { ...cam, dist };
  const p1 = pixelsPerUnit(next, vp);
  next.tx = wx - (px - vp.width / 2) / p1;
  next.ty = wy + (py - vp.height / 2) / p1;
  return next;
}

/** Move the target so the scene follows a drag of (dx, dy) screen pixels. */
export function panBy(cam: Camera, vp: Viewport, dx: number, dy: number): Camera {
  const p = pixelsPerUnit(cam, vp);
  const { right, up } = basis(cam);
  return {
    ...cam,
    tx: cam.tx + (-right[0] * dx + up[0] * dy) / p,
    ty: cam.ty + (-right[1] * dx + up[1] * dy) / p,
    tz: cam.tz + (-right[2] * dx + up[2] * dy) / p,
  };
}

export function orbitBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, yaw: cam.yaw - dx * 0.0055, pitch: Math.min(1.4, Math.max(-1.4, cam.pitch + dy * 0.0045)) };
}

/** Eased interpolation; distance moves geometrically so zooming feels even. */
export function interpolate(a: Camera, b: Camera, t: number): Camera {
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  let yaw = b.yaw;
  while (yaw - a.yaw > Math.PI) yaw -= 2 * Math.PI;
  while (yaw - a.yaw < -Math.PI) yaw += 2 * Math.PI;
  return {
    tx: a.tx + (b.tx - a.tx) * e,
    ty: a.ty + (b.ty - a.ty) * e,
    tz: a.tz + (b.tz - a.tz) * e,
    yaw: a.yaw + (yaw - a.yaw) * e,
    pitch: a.pitch + (b.pitch - a.pitch) * e,
    dist: a.dist * Math.pow(b.dist / a.dist, e),
  };
}
