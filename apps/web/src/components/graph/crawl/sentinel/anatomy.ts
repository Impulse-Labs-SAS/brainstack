// The Sentinel's body plan, in creature units: one unit is the vault's typical
// link (`typicalLink`), so the creature is the same size against its threads
// in a vault of ten notes or ten thousand.
//
// Creature space is world space moved to the body and divided by the unit — no
// rotation. The body's own frame has x to its right, y up and z forward; the
// sockets below are written in it.
//
// Pure data and a little arithmetic: the motion modules read it to know where
// each tentacle is born, the geometry reads it to build the collar around
// those same points.

import { norm, type Vec3 } from '../vec';

/** The hull, an armoured ovoid: length along z, width along x, height along y. */
export const HULL = { length: 0.8, width: 0.55, height: 0.5 } as const;

/** How far above its threads the body floats, along their up: low, so the crown hangs onto them. */
export const HOVER = 0.2;

/**
 * How big the hull and its collar are drawn against the dimensions below; the
 * sockets move with them, the tentacles keep their size. Tuned in the lab: a
 * lighter body under a wide crown. The grip planner and the motion both read
 * it, so a planned grip is one the drawn arm can reach.
 */
export const BODY_SCALE = 0.8;

/** The single eye: a cold lens at the front of the hull, looking along +z. */
export const EYE = { position: [0, 0.03, 0.37] as Vec3, radius: 0.07 } as const;

/** The armoured collar the crown grows from: around the hull, behind its middle. */
export const COLLAR = { z: -0.12, radius: 0.27, squash: 0.85 } as const;

export type TentacleRole = 'gripper' | 'crown' | 'explorer';

export interface TentacleSpec {
  role: TentacleRole;
  /** Where it is born, in the body frame. */
  socket: Vec3;
  /** The way it leaves the socket at rest, unit length, in the body frame. */
  axis: Vec3;
  /** Length at rest, before telescoping. */
  length: number;
  /** Radius at the root and at the tip. */
  rootRadius: number;
  tipRadius: number;
  /** How far its segments may slide out: a little, so it reads as reaching without looking elastic. */
  maxStretch: number;
  /** For a gripper, the grip slot it serves. */
  slot: number | null;
}

/** Twelve tentacles in the crown — six of them grippers — and two explorers under the eye. */
export const CROWN = 12;
export const EXPLORERS = 2;
export const TENTACLES = CROWN + EXPLORERS;

export interface GripSlot {
  side: -1 | 1;
  place: 'front' | 'mid' | 'rear';
  /** Where a grip lands when no thread is near, in the body frame: below and around. */
  natural: Vec3;
}

/** Six grip slots, three a side: the replay plans grips per slot, whatever the tentacle count. */
export const GRIP_SLOTS: readonly GripSlot[] = ([-1, 1] as const).flatMap((side) => [
  { side, place: 'front' as const, natural: [side * 0.6, -0.5, 0.9] as Vec3 },
  { side, place: 'mid' as const, natural: [side * 0.9, -0.55, 0] as Vec3 },
  { side, place: 'rear' as const, natural: [side * 0.7, -0.5, -0.7] as Vec3 },
]);

/**
 * The crown sits on the collar at angles 15° + 30°·i around the forward axis,
 * 0° pointing right and 90° up. The three lowest a side are the grippers; the
 * rest rise around the hull and reach for what the Sentinel reads.
 */
function crown(): TentacleSpec[] {
  const gripperAt = new Map<number, number>([
    // Right side, from front to rear: lower-right sockets.
    [345, 3],
    [315, 4],
    [285, 5],
    // Left side, mirrored.
    [195, 0],
    [225, 1],
    [255, 2],
  ]);
  const specs: TentacleSpec[] = [];
  for (let i = 0; i < CROWN; i++) {
    const deg = 15 + 30 * i;
    const a = (deg * Math.PI) / 180;
    const radial: Vec3 = [Math.cos(a), Math.sin(a) * COLLAR.squash, 0];
    const slot = gripperAt.get(deg) ?? null;
    specs.push({
      role: slot === null ? 'crown' : 'gripper',
      socket: [radial[0] * COLLAR.radius, radial[1] * COLLAR.radius, COLLAR.z],
      // Out from the collar and back along the body, like a crown swept by speed.
      axis: norm([radial[0], radial[1], -0.55]),
      length: 1.25,
      rootRadius: 0.06,
      tipRadius: 0.02,
      // Tuned in the lab: past this the segments read as stretching, not sliding.
      maxStretch: 1.08,
      slot,
    });
  }
  return specs;
}

function explorers(): TentacleSpec[] {
  return ([-1, 1] as const).map((side) => ({
    role: 'explorer' as const,
    socket: [side * 0.1, -0.14, 0.3] as Vec3,
    axis: norm([side * 0.25, -0.35, 1]),
    length: 1.7,
    rootRadius: 0.035,
    tipRadius: 0.012,
    // 1.7 × 1.28 ≈ 2.2 units: far enough to feel across a gap before the body follows.
    maxStretch: 1.28,
    slot: null,
  }));
}

/** Every tentacle, crown first (index 0–11), then the two explorers (12, 13). */
export const TENTACLE_SPECS: readonly TentacleSpec[] = [...crown(), ...explorers()];

/** The tentacle serving each grip slot. */
export const SLOT_TENTACLE: readonly number[] = GRIP_SLOTS.map((_, s) =>
  TENTACLE_SPECS.findIndex((t) => t.slot === s),
);

/** Claw fingers per tentacle tip. */
export const CLAW_FINGERS = 3;
