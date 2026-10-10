// The whole of a space in one shot: where the camera sits to see everything a
// space draws, from a given angle. The lab and the Sentinel view frame a space
// with it (Fit goes there), and the prompt scene places its perch on its axis,
// so the camera backs straight out from the box to it. Also how near and how
// far the wheel may take the camera over a space. Pure, over graph-camera's
// maths.

import { TAN_HALF_FOV, type Bounds, type Camera, type Viewport } from '@/lib/graph-camera';

import type { SpaceBuild } from '../space/space';
import type { Vec3 } from '../vec';

/**
 * The angle a space is seen from, at first and after every rebuild: one
 * view, so the lab's spaces compare by it and the Sentinel view opens on the
 * one the lab approved.
 */
export const OVERVIEW_YAW = 0.5;

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

/** The nearest the wheel goes, creature units: close enough to read one note, never inside it. */
const ZOOM_NEAREST = 1.5;
/** The farthest it goes, creature units, unless the whole space needs more. */
const ZOOM_FARTHEST = 150;
/** Past the overview, so the whole space can be seen with room round it. */
const ZOOM_PAST_OVERVIEW = 1.5;

/**
 * The camera distances the wheel and + / − keep between over `build`, world
 * units: in to a unit and a half, out far enough to see the whole of it with
 * room to spare (the overview's distance, which the aspect sets, half again).
 */
export function stageZoomRange(
  build: Pick<SpaceBuild, 'unit' | 'bounds' | 'camera'>,
  vp: Viewport,
): { min: number; max: number } {
  const whole = overviewCamera(build.bounds, vp, OVERVIEW_YAW, build.camera.pitch).dist;
  return {
    min: build.unit * ZOOM_NEAREST,
    max: Math.max(build.unit * ZOOM_FARTHEST, whole * ZOOM_PAST_OVERVIEW),
  };
}
