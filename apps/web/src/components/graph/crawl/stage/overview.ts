// The whole of a space in one shot: where the camera sits to see everything a
// space draws, from a given angle. The lab frames each space with it, and the
// prompt scene places its perch on its axis, so the camera backs straight out
// from the box to it. Pure, over graph-camera's maths.

import { TAN_HALF_FOV, type Bounds, type Camera, type Viewport } from '@/lib/graph-camera';

import type { Vec3 } from '../vec';

/** Half the diagonal of `b`: the sphere the overview fits. */
export function boundingRadius(b: Bounds): number {
  return Math.hypot(b.w, b.h, b.d) / 2;
}

/**
 * The whole of `b` in view from `yaw` and `pitch`: its bounding sphere inside
 * the narrower field of view, so a phone held upright sees it all too.
 */
export function overviewCamera(b: Bounds, vp: Viewport, yaw: number, pitch: number): Camera {
  const tan = TAN_HALF_FOV * Math.min(1, vp.width / vp.height);
  return {
    tx: b.cx,
    ty: b.cy,
    tz: b.cz,
    yaw,
    pitch,
    dist: boundingRadius(b) / Math.sin(Math.atan(tan)),
  };
}

/**
 * How far the notes reach from `about`, world units, plus `pad`: the room a
 * space's notes take round the point the overview looks at. The bounds' half
 * diagonal is no measure of it — a box's corner lies well outside a cluster
 * that is round — and the prompt's perch keeps its distance from the notes,
 * not from the box. 0 plus `pad` for no notes.
 */
export function notesReach(positions: Iterable<Vec3>, about: Vec3, pad = 0): number {
  let far = 0;
  for (const p of positions) {
    const d = Math.hypot(p[0] - about[0], p[1] - about[1], p[2] - about[2]);
    if (d > far) far = d;
  }
  return far + pad;
}
