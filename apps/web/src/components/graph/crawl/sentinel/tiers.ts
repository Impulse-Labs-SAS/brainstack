// Quality tiers. A tier changes how much detail the Sentinel carries — never
// what it is: the tentacle count, the materials and the environment are the
// same at every tier, so stepping down never compiles a shader mid-crawl.

import { CROWN, EXPLORERS } from './anatomy';

export type Tier = 0 | 1 | 2 | 3;
export const TIER_ORDER: readonly Tier[] = [0, 1, 2, 3];

export interface TierSettings {
  /** Rigid segments per crown tentacle, and per explorer. */
  crownSegments: number;
  explorerSegments: number;
  /** Which hull mesh: the high one has more plates' detail and bolts. */
  hullLod: 'high' | 'low';
  /**
   * Constraint iterations per physics step: the tier's lever on the chains'
   * cost. The number of steps is not one — they are a fixed 1/120 s, as many
   * as the frame's length needs (chain.ts), at every tier.
   */
  iterations: number;
  /** Tentacles pushed out of the hull. */
  collide: boolean;
  /** Resolution of the glow pass, against the canvas. */
  bloomScale: number;
}

export const TIERS: Readonly<Record<Tier, TierSettings>> = {
  3: {
    crownSegments: 22,
    explorerSegments: 28,
    hullLod: 'high',
    iterations: 4,
    collide: true,
    bloomScale: 0.5,
  },
  2: {
    crownSegments: 18,
    explorerSegments: 22,
    hullLod: 'high',
    iterations: 3,
    collide: true,
    bloomScale: 0.5,
  },
  1: {
    crownSegments: 14,
    explorerSegments: 16,
    hullLod: 'low',
    iterations: 3,
    collide: false,
    bloomScale: 1 / 3,
  },
  0: {
    crownSegments: 10,
    explorerSegments: 12,
    hullLod: 'low',
    iterations: 2,
    collide: false,
    bloomScale: 0.25,
  },
};

/** Segments across every tentacle at a tier. */
export function segmentsAt(tier: Tier): number {
  const t = TIERS[tier];
  return CROWN * t.crownSegments + EXPLORERS * t.explorerSegments;
}

/** Instance buffers are sized once, for the richest tier. */
export const MAX_SEGMENTS = segmentsAt(3);
