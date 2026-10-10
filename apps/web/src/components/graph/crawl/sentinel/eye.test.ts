import { describe, expect, it } from 'vitest';

import type { ReplayEvent } from '../replay-view';
import { dot, norm, type Vec3 } from '../vec';

import {
  LOCK_LEAD,
  createEye,
  hum,
  scanFixations,
  stepEye,
  type EyeCue,
  type EyeParams,
} from './eye';

const PARAMS: EyeParams = { eyeBase: 0.55, eyePulse: 0.07, eyeFlare: 1, eyeStill: 0.7 };
const SEED = 11;
const DEG = 180 / Math.PI;

const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * DEG;

/** A pause of `duration` seconds before a walk 30° to the right, the eye reading a note below and ahead. */
function pause(duration: number) {
  const next = norm([Math.sin(30 / DEG), 0, Math.cos(30 / DEG)]);
  const look = norm([0, -0.6, 0.8]);
  const cue = (t: number): EyeCue => ({
    s: [1, 0, 0],
    u: [0, 1, 0],
    f: [0, 0, 1],
    look,
    next,
    untilBegin: duration - t,
    window: Math.min(0.6, 0.45 * duration),
    stepIndex: 3,
    touch: false,
  });
  return { next, look, cue };
}

describe('the Sentinel’s eye', () => {
  it('scans before the walk and is locked on the heading when it starts', () => {
    const duration = 1.6;
    const { next, look, cue } = pause(duration);
    const e = createEye();
    const dt = 1 / 60;
    let glanced = 0;
    let scanned = false;
    let atLock = Infinity;
    let atBegin = Infinity;
    for (let n = 0; n * dt <= duration + 1e-9; n++) {
      const t = n * dt;
      stepEye(e, cue(t), [], PARAMS, SEED, t, dt, false);
      if (Math.abs(t - 0.95) < dt / 2) expect(angle(e.dir, look)).toBeLessThan(3);
      if (t > duration - 0.6 && t < duration - 0.25)
        glanced = Math.max(glanced, angle(e.dir, next));
      scanned ||= e.scanning;
      if (Math.abs(t - (duration - LOCK_LEAD)) < dt / 2) atLock = angle(e.dir, next);
      if (Math.abs(t - duration) < dt / 2) atBegin = angle(e.dir, next);
    }
    expect(scanned).toBe(true);
    expect(glanced).toBeGreaterThan(10);
    expect(atLock).toBeLessThan(3);
    expect(atBegin).toBeLessThan(1.5);
  });

  it('flares when it finds a note and calms within a second', () => {
    const { cue } = pause(5);
    const e = createEye();
    const dt = 1 / 60;
    let t = 0;
    for (; t < 0.5; t += dt) stepEye(e, cue(t), [], PARAMS, SEED, t, dt, false);
    const found: ReplayEvent[] = [
      { kind: 'found', clock: t, nodeId: 'me/a.md', reachKind: 'linked' },
    ];
    stepEye(e, cue(t), found, PARAMS, SEED, t, dt, false);
    expect(e.intensity).toBeGreaterThan(PARAMS.eyeBase - PARAMS.eyePulse + 0.9);
    const end = t + 1;
    for (t += dt; t < end; t += dt) stepEye(e, cue(t), [], PARAMS, SEED, t, dt, false);
    expect(e.intensity).toBeLessThan(PARAMS.eyeBase + PARAMS.eyePulse + 0.05);
  });

  it('holds still under reduced motion', () => {
    const duration = 1.6;
    const { look, cue } = pause(duration);
    const e = createEye();
    const dt = 1 / 60;
    const found: ReplayEvent[] = [
      { kind: 'found', clock: 0, nodeId: 'me/a.md', reachKind: 'named' },
    ];
    for (let t = 0; t <= duration; t += dt) {
      stepEye(e, cue(t), found, PARAMS, SEED, t, dt, true);
      expect(angle(e.dir, look)).toBeLessThan(1e-4);
      expect(e.intensity).toBe(PARAMS.eyeStill);
      expect(e.aperture).toBe(1);
      expect(e.scanning).toBe(false);
    }
  });

  it('glances left, right and left again, the same way each time a step is replayed', () => {
    const a = scanFixations(SEED, 4);
    expect(a).toEqual(scanFixations(SEED, 4));
    expect(a).not.toEqual(scanFixations(SEED, 5));
    expect(a.map((f) => Math.sign(f.yaw))).toEqual([-1, 1, -1]);
    for (const f of a) {
      expect(Math.abs(f.pitch) * DEG).toBeLessThanOrEqual(8);
      expect(f.hold).toBeGreaterThanOrEqual(0.12);
      expect(f.hold).toBeLessThanOrEqual(0.16);
    }
  });

  it('hums within its amplitude, each seed in its own voice', () => {
    let most = 0;
    let apart = 0;
    for (let t = 0; t < 2; t += 1 / 240) {
      most = Math.max(most, Math.abs(hum(t, 1)));
      apart = Math.max(apart, Math.abs(hum(t, 1) - hum(t, 2)));
    }
    expect(most).toBeLessThanOrEqual(1);
    expect(most).toBeGreaterThan(0.5);
    expect(apart).toBeGreaterThan(0.3);
  });
});
