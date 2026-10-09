// Where the prompt box is in the world, and where the Sentinel clings to it.
//
// The box the question is typed into is a DOM element over the stage; the
// bezel round it is drawn in the stage. This module puts the box in the world:
// on a plane facing the camera, at the depth where the box is `size` creature
// units tall. The box's CSS height is fixed, so the creature is the same size
// on screen against it on any viewport, a phone's or a wide screen's. The
// plane is seen by the perch shot: the overview's own angle from closer in,
// on its axis, so going to the crawl the camera backs straight out to the
// overview with the creature centred, and coming back it closes in again.
//
// Pure maths over graph-camera's `basis` and `TAN_HALF_FOV`, the projection
// three renders with, so the frame lands on the DOM box to a fraction of a
// pixel.
//
// The perch is placed in the same world as the space it sets out across: a
// fixed `gap` in front of the notes along that axis, whatever the viewport,
// so the crossing to the cluster is as long on a phone as on a wide screen.
// Placed against the camera instead, it grew with the overview's distance —
// 30 units of crossing at a laptop's width, 230 on a phone held upright. The
// camera's pull-back is then whatever is left between the perch shot and the
// overview, and on a small cluster it closes in instead.
//
// The creature clings to the back of the frame. Up at the perch points away
// from the viewer: the grip slots' natural spots lie below the body, so for
// its claws to reach a frame between it and the viewer its belly must face
// the viewer. `tilt` leans it over the top edge — 0 flat on the back of the
// box, 90 upright behind it facing the viewer — turning up and heading
// together about the screen's right, which stays the creature's right.

import { TAN_HALF_FOV, basis, type Camera, type Viewport } from '@/lib/graph-camera';

import { PERCH_BACK, PERCH_UP } from '../sentinel/grips';
import type { Vec3 } from '../vec';

import { UP_FAR } from './perch-field';

/** The prompt box as the DOM lays it out: CSS pixels from the stage's top-left, and its corners' radius. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

/** Everything about the frame and the creature on it the lab tunes. Lengths in creature units. */
export interface PerchKnobs {
  /** The box's height: how big the Sentinel is against it. */
  size: number;
  /** The rails beyond the box's edge — the bezel's middle. Never less than band / 2 + CLAW_ROOM. */
  margin: number;
  /** The bezel's band across, and its thickness. */
  band: number;
  thickness: number;
  /** The rails toward the viewer from the bezel's middle, as a share of its half-thickness: 1 is its front face. */
  railForward: number;
  /**
   * From the perch's node to the notes' reach, along the overview's axis.
   * Never under GAP_MIN, so the frame's up has given way to the space's
   * before the crossing comes near a note.
   */
  gap: number;
  /** The body against the box's middle: right and up as the viewer sees them, and behind the box. */
  bodyX: number;
  bodyY: number;
  bodyBehind: number;
  /** Degrees it leans over the top edge: 0 flat on the back of the box, 90 upright behind it facing the viewer. */
  tilt: number;
}

/** The least `gap`, creature units: a unit past UP_FAR, where the frame's up has wholly given way. */
export const GAP_MIN = UP_FAR + 1;

/**
 * Chosen in the lab. Leaning 75° over the top, the creature faces the viewer
 * rather than showing its underside: the lens, lit, clears the bezel's top
 * bar and the crown spreads above the box, while all six claws still take
 * the frame. A smaller box (0.25 creature units tall) makes the creature big
 * beside it, in the foreground; 0.3 units behind keeps the claws within reach
 * of the rails. The gap is its floor, the value every shot was laid out with.
 */
export const DEFAULT_PERCH: Readonly<PerchKnobs> = {
  size: 0.25,
  margin: 0.16,
  band: 0.09,
  thickness: 0.07,
  railForward: 0.6,
  gap: GAP_MIN,
  bodyX: 0,
  bodyY: 0.35,
  bodyBehind: 0.3,
  tilt: 75,
};

/** Room a claw needs between the bezel's inner edge and the box, creature units: no claw over the text. */
export const CLAW_ROOM = 0.06;

/** Creature units the hull and the crown take behind the body: the room kept behind the box's plane. */
const CROWN_BEHIND = 2;
/** Segments to each half of a rounded corner along a rail. */
const ARC_STEPS = 4;

/** A plane facing the viewer: its middle, right and up as the viewer sees them, and the normal toward the viewer. */
export interface PlaneFrame {
  centre: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
}

/**
 * The bezel to draw, world units: the rails' rectangle (between centrelines),
 * its corners' radius, the band across and the thickness. Centred on the
 * box's plane.
 */
export interface BezelShape extends PlaneFrame {
  width: number;
  height: number;
  radius: number;
  band: number;
  thickness: number;
}

/**
 * Where the Sentinel perches: the node body.ts and the grip planner perch
 * over, the body they put there, and the frame they hold it in.
 */
export interface PerchPose {
  node: Vec3;
  body: Vec3;
  up: Vec3;
  heading: Vec3;
}

export interface PerchShot {
  /** The perch shot: the overview's angle, from closer in, the box's plane `depth` ahead. */
  cam: Camera;
  depth: number;
  /** World units per creature unit. */
  unit: number;
  /** Screen pixels per world unit on the box's plane: the creature's scale on screen. */
  pixels: number;
  /**
   * World units from the overview camera to the box's plane along its axis,
   * and how far the camera backs off from the perch shot to the overview
   * (negative: it closes in).
   */
  along: number;
  pulled: number;
  /** The box's middle on its plane, and where the viewer is: what the eye may watch. */
  box: Vec3;
  viewer: Vec3;
  bezel: BezelShape;
  /**
   * CSS pixels from the box's bottom edge down to the lowest the bar is drawn on
   * screen: its outer edge at the nearer face or the further, projected as three
   * projects it. What the page keeps clear under the box.
   */
  below: number;
  /**
   * The rails: the bezel's centreline, `railForward` toward the viewer, as
   * four polylines from corner node to corner node — top (TL→TR), right
   * (TR→BR), bottom (BR→BL), left (BL→TL).
   */
  rails: readonly (readonly Vec3[])[];
  /** The corner nodes, the middles of the corner arcs: TL, TR, BR, BL. */
  corners: readonly [Vec3, Vec3, Vec3, Vec3];
  perch: PerchPose;
}

export interface PerchInput {
  /** The space's overview: its angle is the perch shot's, its axis the one the camera backs along. */
  overview: Camera;
  vp: Viewport;
  rect: ScreenRect;
  /** World units per creature unit: the space's. */
  unit: number;
  /** How far the notes reach from the overview's target, world units. */
  radius: number;
  knobs: PerchKnobs;
}

const DEG = Math.PI / 180;

const finiteAll = (...vs: readonly (readonly number[])[]) =>
  vs.every((v) => v.every((x) => Number.isFinite(x)));

/**
 * The box placed in the world, the frame round it and the creature on it.
 * Null when the box, the viewport or the unit has no size, or anything comes
 * out non-finite.
 */
export function perchShot(input: PerchInput): PerchShot | null {
  const { overview, vp, rect, unit, radius, knobs: k } = input;
  const sized = (v: number) => Number.isFinite(v) && v > 0;
  if (!sized(vp.width) || !sized(vp.height) || !sized(rect.width) || !sized(rect.height)) {
    return null;
  }
  if (!sized(unit) || !Number.isFinite(rect.left + rect.top + radius)) return null;
  const { right: R, up: U, forward: F, position: Co } = basis(overview);
  const tan = TAN_HALF_FOV;
  const aspect = vp.width / vp.height;

  // The depth at which the box is `size` units tall, and the pixels a world unit spans there.
  const d = (k.size * unit * vp.height) / (2 * tan * rect.height);
  const px = vp.height / (2 * tan * d);
  const m = Math.max(k.margin, k.band / 2 + CLAW_ROOM);
  const gap = Math.max(k.gap, GAP_MIN);
  // The box's plane short of the notes by `gap` units and the room the creature takes behind it.
  const reserve = (k.bodyBehind + CROWN_BEHIND) * unit;
  const s = overview.dist - radius - gap * unit - reserve;

  const at = (o: Vec3, ...terms: Array<[Vec3, number]>): Vec3 => {
    const p: Vec3 = [o[0], o[1], o[2]];
    for (const [v, w] of terms) for (let i = 0; i < 3; i++) p[i]! += v[i]! * w;
    return p;
  };
  const target = at(Co, [F, s]);
  const cam: Camera = {
    tx: target[0],
    ty: target[1],
    tz: target[2],
    yaw: overview.yaw,
    pitch: overview.pitch,
    dist: d,
  };
  const viewer = at(target, [F, -d]);
  // A point of the screen on the plane: graph-camera's `projector`, inverted at depth d.
  const onPlane = (x: number, y: number): Vec3 =>
    at(
      target,
      [R, ((2 * x) / vp.width - 1) * d * tan * aspect],
      [U, (1 - (2 * y) / vp.height) * d * tan],
    );
  const box = onPlane(rect.left + rect.width / 2, rect.top + rect.height / 2);

  const hw = rect.width / (2 * px);
  const hh = rect.height / (2 * px);
  const rw = hw + m * unit;
  const rh = hh + m * unit;
  // Concentric with the box's own rounded corners.
  const rc = Math.min(Math.max(0, rect.radius) / px + m * unit, rw, rh);
  const n: Vec3 = [-F[0], -F[1], -F[2]];
  const zr = (k.railForward * k.thickness * unit) / 2;
  const plane = (x: number, y: number): Vec3 => at(box, [R, x], [U, y], [n, zr]);

  // TL, TR, BR, BL: each corner's arc centre, and the angle of its middle.
  const cx = rw - rc;
  const cy = rh - rc;
  const centres: Array<[number, number]> = [
    [-cx, cy],
    [cx, cy],
    [cx, -cy],
    [-cx, -cy],
  ];
  const arc = (corner: number, from: number, to: number): Vec3[] => {
    const [ox, oy] = centres[corner]!;
    return Array.from({ length: ARC_STEPS + 1 }, (_, i) => {
      const a = (from + ((to - from) * i) / ARC_STEPS) * DEG;
      return plane(ox + rc * Math.cos(a), oy + rc * Math.sin(a));
    });
  };
  // Each rail is half its first corner's arc, the straight edge, and half the next corner's.
  const tiny = 1e-9 * Math.max(rw, rh);
  const rail = (...parts: Vec3[][]): Vec3[] => {
    const out: Vec3[] = [];
    for (const p of parts.flat()) {
      const last = out[out.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) <= tiny) continue;
      out.push(p);
    }
    return out;
  };
  const rails = [
    rail(arc(0, 135, 90), arc(1, 90, 45)),
    rail(arc(1, 45, 0), arc(2, 0, -45)),
    rail(arc(2, -45, -90), arc(3, -90, -135)),
    rail(arc(3, -135, -180), arc(0, 180, 135)),
  ];
  const corners = [rails[0]![0]!, rails[1]![0]!, rails[2]![0]!, rails[3]![0]!] as [
    Vec3,
    Vec3,
    Vec3,
    Vec3,
  ];

  // Up and heading turn together about the screen's right: up × heading = R, the creature's right.
  const tilt = k.tilt * DEG;
  const up = at([0, 0, 0], [F, Math.cos(tilt)], [U, Math.sin(tilt)]);
  const heading = at([0, 0, 0], [U, Math.cos(tilt)], [F, -Math.sin(tilt)]);
  const body = at(box, [R, k.bodyX * unit], [U, k.bodyY * unit], [F, k.bodyBehind * unit]);
  // The inverse of body.ts `perchAt` and grips.ts `setFrame`, which put the
  // body `PERCH_UP` above the node and `PERCH_BACK` behind it along a level
  // heading: the body floats exactly at `body`, and the grips are planned from there.
  const node = at(body, [up, -PERCH_UP * unit], [heading, PERCH_BACK * unit]);

  // How far below the box the bar reaches on screen, for the page to keep
  // clear: its outer bottom edge, `edge` world units above the shot's axis,
  // at its nearer face and its further one. Below the axis the nearer face
  // lies lower on screen, above it the further. In closed form rather than
  // through graph-camera's projector, whose near plane can lie past the box
  // on a space with a small unit.
  const yc = (1 - (2 * (rect.top + rect.height / 2)) / vp.height) * d * tan;
  const edge = yc - (rh + (k.band * unit) / 2);
  const th = (k.thickness * unit) / 2;
  const screenY = (depth: number) => (1 - edge / (depth * tan)) * (vp.height / 2);
  const below =
    Math.max(d - th > 0 ? screenY(d - th) : -Infinity, screenY(d + th)) - (rect.top + rect.height);

  if (!finiteAll(target, [d, px, below], box, node, body, ...rails.flat())) return null;
  return {
    cam,
    depth: d,
    unit,
    pixels: px,
    along: s,
    pulled: s - d,
    box,
    viewer,
    bezel: {
      centre: box,
      right: R,
      up: U,
      normal: n,
      width: 2 * rw,
      height: 2 * rh,
      radius: rc,
      band: k.band * unit,
      thickness: k.thickness * unit,
    },
    below,
    rails,
    corners,
    perch: { node, body, up, heading },
  };
}
