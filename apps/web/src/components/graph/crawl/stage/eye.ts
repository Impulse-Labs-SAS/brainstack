// The eye a dormant space is told about each frame, in world space: what it
// looks at is what it reveals. The Sentinel's own, from its pose; or, with the
// creature off or not ready, a stand-in eye riding just above the walk, so a
// dormant space is still revealed where the crawl goes. The stage hands one to
// its space every frame, and so does the lab; written into a reused object,
// so a frame allocates nothing.

import type { ReplayView } from '../replay-view';
import { LENS_POINT } from '../sentinel/geometry';
import type { SentinelPose } from '../sentinel/pose';
import type { SpaceFrame } from '../space/space';
import { legPoint } from '../threads';
import { cross, dot, finite, len, mul, sub, type Vec3 } from '../vec';

/** The eye a space is told about each frame (SpaceFrame.eye), world space. */
export type SpaceEye = NonNullable<SpaceFrame['eye']>;

/** An eye to write into every frame, so drawing one allocates nothing. */
export function blankEye(): SpaceEye {
  return { position: [0, 0, 0], dir: [0, 0, 1], intensity: 0 };
}

/**
 * The Sentinel's eye in world space, written into `out`: the lens — where its
 * spotlight sits, `anchor + unit · (hull · LENS_POINT)`, exactly as the view
 * places it — the way it looks, and how bright it burns. Creature space is the
 * world moved and scaled, never turned, so the direction carries over as is.
 */
export function sentinelEye(pose: SentinelPose, out: SpaceEye): SpaceEye {
  const h = pose.hull;
  const { anchor, unit } = pose;
  const [lx, ly, lz] = LENS_POINT;
  for (let i = 0; i < 3; i++) {
    const lens = h[i]! * lx + h[4 + i]! * ly + h[8 + i]! * lz + h[12 + i]!;
    out.position[i] = anchor[i]! + unit * lens;
    out.dir[i] = pose.eye.dir[i]!;
  }
  out.intensity = pose.eye.intensity;
  return out;
}

/** How high over the walk the stand-in eye rides, creature units: about where the lens is. */
const STAND_IN_HEIGHT = 0.6;
/**
 * How far below the walk's horizon it looks, radians: its cone (0.55 either
 * side) then spans from level to a steep look down, and lights the stretch
 * just ahead, where the creature's own eye mostly rests.
 */
const STAND_IN_DIP = 0.45;
const upAt: Vec3 = [0, 1, 0];

/**
 * An eye for when the Sentinel is off or not ready: at the walk's cursor —
 * the point the replay has reached along the leg, or the note it stands on —
 * raised along the local up, looking ahead and down, at `intensity` (the
 * eye's resting one). Written into `out`; null when the walk has no place.
 *
 * A crossing of the void is walked as the replay walks it over a space of
 * its own: straight, with no sag.
 */
export function standInEye(view: ReplayView, intensity: number, out: SpaceEye): SpaceEye | null {
  const { field, walk } = view;
  const at = out.position;
  const placed =
    walk && walk.segments.length > 0
      ? legPoint(walk.segments, walk.travelled, field, 0, at)
      : !!view.hereId && field.node(view.hereId, at);
  if (!placed || !finite(at)) return null;
  field.up(at, upAt);
  const up = unitOr(upAt, [0, 1, 0]);
  const ahead = unitOr(sub(view.dir, mul(up, dot(view.dir, up))), anyPerpendicular(up));
  const c = Math.cos(STAND_IN_DIP);
  const s = Math.sin(STAND_IN_DIP);
  const lift = view.unit * STAND_IN_HEIGHT;
  for (let i = 0; i < 3; i++) {
    at[i] = at[i]! + up[i]! * lift;
    out.dir[i] = ahead[i]! * c - up[i]! * s;
  }
  out.intensity = intensity;
  return out;
}

function unitOr(v: Vec3, fallback: Vec3): Vec3 {
  const l = len(v);
  return l > 1e-9 && Number.isFinite(l) ? mul(v, 1 / l) : fallback;
}

function anyPerpendicular(v: Vec3): Vec3 {
  const other: Vec3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return unitOr(cross(other, v), [0, 0, 1]);
}
