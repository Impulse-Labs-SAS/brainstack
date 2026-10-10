import { describe, expect, it } from 'vitest';

import { TENTACLES, TENTACLE_SPECS } from './anatomy';
import { SENTINEL_SEED, makeRig, tentacleCharacter } from './rig';
import { TIER_ORDER, segmentsAt } from './tiers';

const UNIT = 20;

describe('makeRig', () => {
  it('cuts every tier into the segments it promises, the same fourteen tentacles at each', () => {
    for (const tier of TIER_ORDER) {
      const rig = makeRig(tier, UNIT);
      expect(rig.tentacles).toBe(TENTACLES);
      expect(rig.totalSegments).toBe(segmentsAt(tier));
      expect(rig.joints).toBe(segmentsAt(tier) + TENTACLES);
      expect(rig.segStart.at(-1)! + rig.segments.at(-1)!).toBe(rig.totalSegments);
    }
  });

  it('keeps each tentacle its length and character at every tier', () => {
    const rich = makeRig(3, UNIT);
    const lean = makeRig(0, UNIT);
    for (let i = 0; i < TENTACLES; i++) {
      for (const rig of [rich, lean]) {
        let sum = 0;
        for (let j = 0; j < rig.segments[i]!; j++) sum += rig.segLength[rig.segStart[i]! + j]!;
        expect(sum).toBeCloseTo(rig.length[i]!, 3);
      }
      expect(lean.length[i]).toBe(rich.length[i]);
      expect(lean.phase[i]).toBe(rich.phase[i]);
      expect(lean.twist[i]).toBe(rich.twist[i]);
    }
  });

  it('tapers toward the tip, in length and radius', () => {
    const rig = makeRig(3, UNIT);
    for (let i = 0; i < TENTACLES; i++) {
      const first = rig.segStart[i]!;
      const last = first + rig.segments[i]! - 1;
      expect(rig.segLength[last]!).toBeLessThan(rig.segLength[first]!);
      expect(rig.segRadius[first]).toBeCloseTo(TENTACLE_SPECS[i]!.rootRadius * UNIT, 5);
      expect(rig.segRadius[last]).toBeCloseTo(TENTACLE_SPECS[i]!.tipRadius * UNIT, 5);
    }
  });

  it('gives every tentacle its own character, within the ranges the design sets', () => {
    const all = Array.from({ length: TENTACLES }, (_, i) => tentacleCharacter(i));
    for (const c of all) {
      expect(c.frequency).toBeGreaterThanOrEqual(0.35);
      expect(c.frequency).toBeLessThanOrEqual(0.65);
      expect(Math.abs(c.curl)).toBeLessThanOrEqual(0.3);
      expect(c.drag).toBeGreaterThanOrEqual(0.28);
      expect(c.drag).toBeLessThanOrEqual(0.45);
      expect(c.lengthScale).toBeGreaterThanOrEqual(0.9);
      expect(c.lengthScale).toBeLessThanOrEqual(1.1);
      expect((c.twist * 180) / Math.PI).toBeGreaterThanOrEqual(4);
      expect((c.twist * 180) / Math.PI).toBeLessThanOrEqual(9);
    }
    expect(new Set(all.map((c) => c.phase)).size).toBe(TENTACLES);
    expect(tentacleCharacter(3)).toEqual(tentacleCharacter(3, SENTINEL_SEED));
    expect(tentacleCharacter(3, 1)).not.toEqual(tentacleCharacter(3));
  });
});
