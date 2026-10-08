// One frame of the Sentinel, as the renderer receives it: matrices and a few
// scalars, nothing else. The motion modules fill it; the view draws it.
//
// Everything is in creature space — world space moved to `anchor` and divided
// by `unit` — so the renderer's lights, distances and noise are tuned once and
// hold for any vault.

import type { Vec3 } from '../vec';

import { CLAW_FINGERS, TENTACLES } from './anatomy';
import { MAX_SEGMENTS } from './tiers';

export interface SentinelPose {
  /** World point creature space is centred on: the body. */
  anchor: Vec3;
  /** World units per creature unit. */
  unit: number;
  /** The hull: rotation into the body frame, plus breathing and hum, creature space. 16 floats, column-major. */
  hull: Float32Array;
  /**
   * One matrix per rigid segment, 16 floats, column-major, creature space. The
   * segment geometry is authored along +y over [0, 1] with radius 1: the matrix
   * carries its length and radius as scale.
   */
  segmentMatrices: Float32Array;
  /** Per segment: glow 0–1, wear seed 0–1, position along its tentacle 0 (root) – 1 (tip), tentacle index. */
  segmentAttrs: Float32Array;
  segments: number;
  /** One matrix per claw finger, same conventions, authored along +y. */
  clawMatrices: Float32Array;
  /** Per finger: glow, wear seed, closure 0 (open) – 1 (biting), tentacle index. */
  clawAttrs: Float32Array;
  claws: number;
  eye: {
    /** Where it looks, creature space, unit length. */
    dir: Vec3;
    /** 0 dark – 1 resting – above 1 when it finds something. */
    intensity: number;
    /** 0 closed – 1 open. */
    aperture: number;
  };
  /** Creature-space bounding sphere of everything drawn: x, y, z, radius. */
  bounds: Float32Array;
}

export function createPose(): SentinelPose {
  return {
    anchor: [0, 0, 0],
    unit: 1,
    hull: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    segmentMatrices: new Float32Array(MAX_SEGMENTS * 16),
    segmentAttrs: new Float32Array(MAX_SEGMENTS * 4),
    segments: 0,
    clawMatrices: new Float32Array(TENTACLES * CLAW_FINGERS * 16),
    clawAttrs: new Float32Array(TENTACLES * CLAW_FINGERS * 4),
    claws: 0,
    eye: { dir: [0, 0, 1], intensity: 1, aperture: 1 },
    bounds: new Float32Array([0, 0, 0, 3]),
  };
}
