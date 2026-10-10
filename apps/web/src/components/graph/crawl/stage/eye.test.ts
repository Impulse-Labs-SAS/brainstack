import { describe, expect, it } from 'vitest';

import { CrawlReplay } from '../crawl-replay';
import { sampleVault } from '../sample-vault';
import { LENS_POINT } from '../sentinel/geometry';
import { createPose } from '../sentinel/pose';
import { legPoint } from '../threads';
import { add, dot, len, mul, norm, type Vec3 } from '../vec';

import { blankEye, sentinelEye, standInEye } from './eye';

const UNIT = 10;

const close = (got: Vec3, want: Vec3, digits = 9) =>
  got.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, digits));

describe("the Sentinel's eye, world space", () => {
  it('sits at the lens, as the view places it, and looks the way the pose does', () => {
    const pose = createPose();
    pose.anchor = [5, -3, 8];
    pose.unit = UNIT;
    // Turned a quarter about y, and moved: creature space is never turned, only the hull.
    pose.hull.set([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.2, 0.1, -0.3, 1]);
    pose.eye.dir = norm([0.3, -0.4, 0.8]);
    pose.eye.intensity = 1.7;
    const eye = sentinelEye(pose, blankEye());
    const [lx, ly, lz] = LENS_POINT;
    const lens: Vec3 = [lz + 0.2, ly + 0.1, -lx - 0.3];
    close(eye.position, add(pose.anchor, mul(lens, UNIT)), 5);
    close(eye.dir, pose.eye.dir);
    expect(eye.intensity).toBe(1.7);
  });

  it('stands in above the walk, looking ahead and down, when the creature is off', () => {
    const { model, crawls } = sampleVault();
    const replay = new CrawlReplay(() => {});
    replay.load(crawls.walk, model);
    let guard = 0;
    while (!(replay.view.walk && replay.view.walk.travelled > 0) && guard++ < 10_000) {
      replay.update(1 / 60);
    }
    const view = replay.view;
    const walk = view.walk!;
    const at: Vec3 = [0, 0, 0];
    expect(legPoint(walk.segments, walk.travelled, view.field, 0, at)).toBe(true);
    const up: Vec3 = [0, 0, 0];
    view.field.up(at, up);
    const eye = standInEye(view, 0.9, blankEye())!;
    close(eye.position, add(at, mul(up, 0.6 * view.unit)), 6);
    expect(len(eye.dir)).toBeCloseTo(1, 9);
    // Below the horizon by its dip, and ahead along the walk.
    expect(dot(eye.dir, up)).toBeCloseTo(-Math.sin(0.45), 9);
    expect(dot(eye.dir, view.dir)).toBeGreaterThan(0);
    expect(eye.intensity).toBe(0.9);
  });

  it('stands in nowhere when the walk has no place', () => {
    const { model, crawls } = sampleVault();
    const replay = new CrawlReplay(() => {});
    replay.load(crawls.walk, model);
    const nowhere = { ...replay.view, walk: null, hereId: null };
    expect(standInEye(nowhere, 1, blankEye())).toBeNull();
  });
});
