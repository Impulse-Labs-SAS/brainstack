// The Sentinel's tentacles as numbers: per tentacle, the seeded character that
// keeps any two from moving alike, and per segment, the length and radius the
// chains are solved and drawn with.
//
// Everything is flat typed arrays, indexed the way the chains index them:
// tentacle i owns segments segStart[i] … segStart[i] + segments[i] − 1 and
// joints jointStart[i] … jointStart[i] + segments[i], joint 0 being the root at
// its socket. A tier changes how many segments a tentacle is cut into, never
// its length, its character or how many tentacles there are.
//
// Lengths and radii are in world units (creature units × `unit`), because the
// chains are solved in world space. The socket frame and the rest shape are in
// the body frame, creature units, because they ride on the hull.

import { seededRandom } from '@/lib/graph-brain';

import { TENTACLES, TENTACLE_SPECS, type TentacleRole } from './anatomy';
import { TIERS, type Tier } from './tiers';

/** The seed every Sentinel grows from, so the creature in the lab is the one in Crawl. */
export const SENTINEL_SEED = 0x5e17;

/** What makes one tentacle move unlike its neighbours. Drawn once per tentacle, the same at every tier. */
export interface TentacleCharacter {
  /** Of its travelling wave, radians. */
  phase: number;
  /** Of its travelling wave, Hz. */
  frequency: number;
  /** Of its travelling wave at the tip, creature units. */
  amplitude: number;
  /** Of its travelling wave, in tentacle lengths. */
  wavelength: number;
  /** How much its rest shape curls beyond its role's, radians over its length. */
  curl: number;
  /** How firmly it returns to its rest shape. */
  stiffness: number;
  /** Seconds for its swing to die down: the lag behind the body comes from here. */
  drag: number;
  /** Against its anatomy length. */
  lengthScale: number;
  /** How far each segment turns about the arm from the one before, radians. */
  twist: number;
}

const DEG = Math.PI / 180;

export function tentacleCharacter(i: number, seed = SENTINEL_SEED): TentacleCharacter {
  const r = seededRandom(seed + 7919 * i);
  return {
    phase: r() * Math.PI * 2,
    frequency: 0.35 + 0.3 * r(),
    amplitude: 0.04 + 0.05 * r(),
    wavelength: 0.6 + 0.5 * r(),
    curl: (r() * 2 - 1) * 0.3,
    stiffness: 0.8 + 0.4 * r(),
    drag: 0.28 + 0.17 * r(),
    lengthScale: 0.9 + 0.2 * r(),
    twist: (4 + 5 * r()) * DEG,
  };
}

/**
 * How each role curls at rest, radians over its length, bending about the
 * axis tangent to the collar: negative sweeps the crown back from the eye,
 * positive lifts the explorers' tips like antennae.
 */
const ROLE_CURL: Record<TentacleRole, number> = { gripper: -0.2, crown: -0.35, explorer: 0.3 };

export interface Rig {
  tier: Tier;
  /** World units per creature unit. */
  unit: number;
  seed: number;
  tentacles: number;
  /** Per tentacle: rigid segments, first segment, root joint. */
  segments: Int32Array;
  segStart: Int32Array;
  jointStart: Int32Array;
  totalSegments: number;
  joints: number;
  /** Per tentacle, world units: rest length, before telescoping. */
  length: Float32Array;
  /** Per tentacle: how far its segments may slide out (TentacleSpec.maxStretch). */
  maxStretch: Float32Array;
  /** Per tentacle, the seeded character (amplitude in world units). */
  phase: Float32Array;
  frequency: Float32Array;
  amplitude: Float32Array;
  wavelength: Float32Array;
  stiffness: Float32Array;
  drag: Float32Array;
  twist: Float32Array;
  /** How much bigger than the anatomy as written the hull and its collar are drawn; the sockets move with them. */
  bodyScale: number;
  /** Per tentacle, body frame, creature units: socket, the way it leaves it, and a normal across it. */
  socket: Float32Array;
  axis: Float32Array;
  normal: Float32Array;
  /** Per joint, body frame, creature units: where it rests, from its socket, untelescoped. */
  rest: Float32Array;
  /** Per joint, body frame: the rest shape's binormal there (normal × tangent), for the helical sway. */
  restBinormal: Float32Array;
  /** Per segment, world units. */
  segLength: Float32Array;
  segRadius: Float32Array;
  /** Per segment, 0–1: where its wear texture is sampled from. */
  wear: Float32Array;
  /** Per tentacle, world units: one claw finger. */
  clawLength: Float32Array;
  clawRadius: Float32Array;
}

/** Segments a tentacle is cut into at a tier. */
export function segmentsOf(i: number, tier: Tier): number {
  const t = TIERS[tier];
  return TENTACLE_SPECS[i]!.role === 'explorer' ? t.explorerSegments : t.crownSegments;
}

export function makeRig(tier: Tier, unit: number, seed = SENTINEL_SEED, bodyScale = 1): Rig {
  const segments = new Int32Array(TENTACLES);
  const segStart = new Int32Array(TENTACLES);
  const jointStart = new Int32Array(TENTACLES);
  let totalSegments = 0;
  for (let i = 0; i < TENTACLES; i++) {
    segments[i] = segmentsOf(i, tier);
    segStart[i] = totalSegments;
    jointStart[i] = totalSegments + i;
    totalSegments += segments[i]!;
  }
  const joints = totalSegments + TENTACLES;
  const perTentacle = () => new Float32Array(TENTACLES);
  const rig: Rig = {
    tier,
    unit,
    seed,
    tentacles: TENTACLES,
    segments,
    segStart,
    jointStart,
    totalSegments,
    joints,
    bodyScale,
    length: perTentacle(),
    maxStretch: perTentacle(),
    phase: perTentacle(),
    frequency: perTentacle(),
    amplitude: perTentacle(),
    wavelength: perTentacle(),
    stiffness: perTentacle(),
    drag: perTentacle(),
    twist: perTentacle(),
    socket: new Float32Array(TENTACLES * 3),
    axis: new Float32Array(TENTACLES * 3),
    normal: new Float32Array(TENTACLES * 3),
    rest: new Float32Array(joints * 3),
    restBinormal: new Float32Array(joints * 3),
    segLength: new Float32Array(totalSegments),
    segRadius: new Float32Array(totalSegments),
    wear: new Float32Array(totalSegments),
    clawLength: perTentacle(),
    clawRadius: perTentacle(),
  };

  for (let i = 0; i < TENTACLES; i++) {
    const spec = TENTACLE_SPECS[i]!;
    const ch = tentacleCharacter(i, seed);
    const M = segments[i]!;
    const length = spec.length * ch.lengthScale;
    rig.length[i] = length * unit;
    rig.maxStretch[i] = spec.maxStretch;
    rig.phase[i] = ch.phase;
    rig.frequency[i] = ch.frequency;
    rig.amplitude[i] = ch.amplitude * unit;
    rig.wavelength[i] = ch.wavelength;
    rig.stiffness[i] = ch.stiffness;
    rig.drag[i] = ch.drag;
    rig.twist[i] = ch.twist;
    rig.clawLength[i] = spec.tipRadius * 5.5 * unit;
    rig.clawRadius[i] = spec.tipRadius * 0.7 * unit;

    // The socket frame: the axis it leaves along, and a normal tangent to the
    // collar (across the forward axis), about which its rest shape curls.
    const [ax, ay, az] = spec.axis;
    let nx = ay;
    let ny = -ax;
    let nz = 0;
    if (Math.hypot(nx, ny) < 0.2) {
      nx = -az;
      ny = 0;
      nz = ax;
    }
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // b = n × t: the direction a positive curl bends toward.
    const bx = ny * az - nz * ay;
    const by = nz * ax - nx * az;
    const bz = nx * ay - ny * ax;
    rig.socket.set(
      spec.socket.map((v) => v * bodyScale),
      i * 3,
    );
    rig.axis.set(spec.axis, i * 3);
    rig.normal.set([nx, ny, nz], i * 3);

    // Segment lengths taper toward the tip (l ∝ 1.2 − 0.4·j/M), summing to the length.
    let taper = 0;
    for (let j = 0; j < M; j++) taper += 1.2 - (0.4 * j) / M;
    const wearRandom = seededRandom((seed ^ 0x9e37) + 104729 * i);
    const curl = ROLE_CURL[spec.role] + ch.curl;
    const j0 = jointStart[i]!;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let j = 0; j < M; j++) {
      const s = segStart[i]! + j;
      const l = (length * (1.2 - (0.4 * j) / M)) / taper;
      rig.segLength[s] = l * unit;
      rig.segRadius[s] =
        (spec.rootRadius + ((spec.tipRadius - spec.rootRadius) * j) / Math.max(1, M - 1)) * unit;
      rig.wear[s] = wearRandom();
      // A constant curl: each segment turns a little further about the normal.
      const th = (curl * (j + 0.5)) / M;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const dx = ax * c + bx * sn;
      const dy = ay * c + by * sn;
      const dz = az * c + bz * sn;
      const k = (j0 + j) * 3;
      rig.rest[k] = px;
      rig.rest[k + 1] = py;
      rig.rest[k + 2] = pz;
      rig.restBinormal[k] = ny * dz - nz * dy;
      rig.restBinormal[k + 1] = nz * dx - nx * dz;
      rig.restBinormal[k + 2] = nx * dy - ny * dx;
      px += dx * l;
      py += dy * l;
      pz += dz * l;
      if (j === M - 1) {
        rig.rest[k + 3] = px;
        rig.rest[k + 4] = py;
        rig.rest[k + 5] = pz;
        rig.restBinormal[k + 3] = rig.restBinormal[k]!;
        rig.restBinormal[k + 4] = rig.restBinormal[k + 1]!;
        rig.restBinormal[k + 5] = rig.restBinormal[k + 2]!;
      }
    }
  }
  return rig;
}
