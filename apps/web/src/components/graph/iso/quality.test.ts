import { describe, expect, it } from 'vitest';

import { DPR_STEPS, FAST_MS, QualityGovernor, SLOW_MS, type QualityLevel } from './quality';

/** The step past the last ratio, where the dot grid and the hidden cables go. */
const BARE = DPR_STEPS.length;

/** A small LCG, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const times = (n: number, ms: number) => Array.from({ length: n }, () => ms);

/** Every change a run of intervals makes: on which frame (1 being the first) and to which step. */
function run(gov: QualityGovernor, intervals: readonly number[]) {
  const changes: { frame: number; step: number; level: QualityLevel }[] = [];
  intervals.forEach((ms, i) => {
    const level = gov.moving(ms);
    if (level) changes.push({ frame: i + 1, step: gov.step, level });
  });
  return changes;
}

const steps = (changes: readonly { step: number }[]) => changes.map((c) => c.step);

/** Frames of `ms` until the step changes: how many it took and the step it moved to; null if it never does. */
function until(gov: QualityGovernor, ms: number, limit = 10_000) {
  for (let frames = 1; frames <= limit; frames++)
    if (gov.moving(ms)) return { frames, step: gov.step };
  return null;
}

/** How many times the direction of the changes turns: down then up, or up then down. */
function turns(changes: readonly { step: number }[], from: number): number {
  let last = 0;
  let count = 0;
  let at = from;
  for (const { step } of changes) {
    const dir = Math.sign(step - at);
    if (last && dir !== last) count++;
    last = dir;
    at = step;
  }
  return count;
}

/** The p95 by nearest rank, as the frame probe measures it. */
function p95(gaps: readonly number[]): number {
  const sorted = Float64Array.from(gaps).sort();
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

/**
 * The rules, the slow and obvious way: every window kept whole and sorted on every frame. Gives,
 * per interval, the step it moves to, or null.
 */
function reference(deviceDpr: number, start: number | undefined, intervals: readonly number[]) {
  const device = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  // The least step not under the screen's ratio; the first over it.
  let top = 0;
  DPR_STEPS.forEach((d, i) => {
    if (d >= device - 0.01) top = i;
  });
  let step =
    start !== undefined && Number.isInteger(start) ? Math.min(BARE, Math.max(top, start)) : top;
  let since: number[] = [];
  const falls = new Map<number, number>();
  return intervals.map((ms) => {
    if (!(ms > 0 && ms < Infinity)) return null;
    since.push(ms);
    if (step < BARE && since.length >= 40 && p95(since.slice(-40)) > 20) {
      falls.set(step, (falls.get(step) ?? 0) + 1);
      if (falls.get(step) === 2) top = step + 1;
      step++;
      since = [];
      return step;
    }
    if (step > top && since.length >= 120 && p95(since.slice(-120)) < FAST_MS) {
      step--;
      since = [];
      return step;
    }
    return null;
  });
}

describe('QualityGovernor', () => {
  it('steps through 2, 1.5, 1.25 and 1', () => {
    expect(DPR_STEPS).toEqual([2, 1.5, 1.25, 1]);
  });

  it("starts at the screen's own ratio, on the least step not under it", () => {
    for (const [device, step, dpr] of [
      [3, 0, 2],
      [2, 0, 2],
      // Between two steps: the screen's own, never changed while frames keep up.
      [1.75, 0, 1.75],
      [1.5, 1, 1.5],
      [1.4999, 1, 1.4999],
      [1.25, 2, 1.25],
      [1.1, 2, 1.1],
      [1, 3, 1],
      // Zoomed out on a 1× screen: never more pixels than the screen shows.
      [0.8, 3, 0.8],
      // No ratio worth the name: a 1× screen.
      [0, 3, 1],
      [Number.NaN, 3, 1],
      [-2, 3, 1],
    ] as const) {
      const gov = new QualityGovernor(device);
      expect(gov.step, `device ${device}`).toBe(step);
      expect(gov.level, `device ${device}`).toEqual({ dpr, grid: true, hidden: true });
    }
  });

  it('starts at a remembered step, never above the screen allows nor past the last', () => {
    expect(new QualityGovernor(2, 2).level).toEqual({ dpr: 1.25, grid: true, hidden: true });
    expect(new QualityGovernor(2, BARE).level).toEqual({ dpr: 1, grid: false, hidden: false });
    // Remembered on a sharper screen than this one.
    expect(new QualityGovernor(1.5, 0).step).toBe(1);
    expect(new QualityGovernor(1, 0).step).toBe(3);
    // What a visit remembers is only a step it fell to: one that kept up says nothing, and a
    // sharper screen after it starts at its own sharpest.
    expect(new QualityGovernor(1).remembered).toBeUndefined();
    expect(new QualityGovernor(2, new QualityGovernor(1).remembered).step).toBe(0);
    const fell = new QualityGovernor(2);
    expect(until(fell, 30)).toEqual({ frames: 40, step: 1 });
    expect(fell.remembered).toBe(1);
    expect(new QualityGovernor(2, fell.remembered).step).toBe(1);
    // On a screen between two steps, the next step down is the next ratio down.
    expect(new QualityGovernor(1.75, 1).level.dpr).toBe(1.5);
    expect(new QualityGovernor(1.1, 3).level.dpr).toBe(1);
    expect(new QualityGovernor(2, 9).step).toBe(BARE);
    // Whatever storage gave back that is not a step is no step at all.
    for (const junk of [-1, 1.5, Number.NaN, Infinity])
      expect(new QualityGovernor(2, junk).step, `${junk}`).toBe(0);
  });

  it('steps down on slow frames, waiting a full window at each step, and stops at the last', () => {
    const gov = new QualityGovernor(2);
    const changes = run(gov, times(1_000, 25));
    expect(changes.map((c) => c.frame)).toEqual([40, 80, 120, 160]);
    expect(changes.map((c) => c.level)).toEqual([
      { dpr: 1.5, grid: true, hidden: true },
      { dpr: 1.25, grid: true, hidden: true },
      { dpr: 1, grid: true, hidden: true },
      { dpr: 1, grid: false, hidden: false },
    ]);
    expect(gov.step).toBe(BARE);
    expect(gov.level).toEqual({ dpr: 1, grid: false, hidden: false });
  });

  it('steps up on fast frames, waiting a full window at each step, and stops at the start', () => {
    const gov = new QualityGovernor(2, BARE);
    const changes = run(gov, times(2_000, 8));
    expect(changes.map((c) => c.frame)).toEqual([120, 240, 360, 480]);
    expect(steps(changes)).toEqual([3, 2, 1, 0]);
    expect(changes[0]!.level).toEqual({ dpr: 1, grid: true, hidden: true });
    expect(gov.level).toEqual({ dpr: 2, grid: true, hidden: true });

    // On a 1.5 screen it climbs no higher than 1.5.
    const lower = new QualityGovernor(1.5, BARE);
    expect(steps(run(lower, times(2_000, 8)))).toEqual([3, 2, 1]);
    expect(lower.level.dpr).toBe(1.5);
  });

  it('decides on a full window only: nothing before the 40th frame, or the 120th', () => {
    const down = new QualityGovernor(2);
    const slow = [...times(3, 50), ...times(37, 16)];
    expect(run(down, slow.slice(0, 39))).toEqual([]);
    expect(steps(run(down, slow.slice(39)))).toEqual([1]);

    const up = new QualityGovernor(2, 1);
    expect(run(up, times(119, 8))).toEqual([]);
    expect(steps(run(up, [8]))).toEqual([0]);
  });

  it('takes the p95 by nearest rank: two late frames in 40 pass, three do not', () => {
    // Two late frames in every forty, spread out: the p95 is the 38th fastest, an early one.
    const two = Array.from({ length: 4_000 }, (_, i) => (i % 20 === 7 ? 40 : 16.7));
    expect(run(new QualityGovernor(2), two)).toEqual([]);
    const three = Array.from({ length: 40 }, (_, i) => (i % 13 === 5 ? 40 : 16.7));
    expect(three.filter((ms) => ms > 20)).toHaveLength(3);
    expect(steps(run(new QualityGovernor(2), three))).toEqual([1]);

    // Six frames of 120 at FAST_MS or more pass for fast; seven do not.
    const six = Array.from({ length: 120 }, (_, i) => (i % 20 === 3 ? FAST_MS + 1 : 8));
    expect(steps(run(new QualityGovernor(2, 1), six))).toEqual([0]);
    const seven = Array.from({ length: 120 }, (_, i) => (i % 17 === 3 ? FAST_MS + 1 : 8));
    expect(seven.filter((ms) => ms >= FAST_MS)).toHaveLength(7);
    expect(run(new QualityGovernor(2, 1), seven)).toEqual([]);
  });

  it('is strict at the bounds: SLOW_MS is not slow, FAST_MS is not fast', () => {
    const gov = new QualityGovernor(2, 2);
    expect(run(gov, times(5_000, SLOW_MS))).toEqual([]);
    expect(run(gov, times(5_000, FAST_MS))).toEqual([]);
    expect(until(new QualityGovernor(2, 2), SLOW_MS + 0.001)).toEqual({ frames: 40, step: 3 });
    expect(until(new QualityGovernor(2, 2), FAST_MS - 0.001)).toEqual({ frames: 120, step: 1 });
  });

  it('counts afresh after a change: frames at the old step say nothing of the new', () => {
    const gov = new QualityGovernor(2);
    expect(until(gov, 30)).toEqual({ frames: 40, step: 1 });
    // The late frames before do not hold back the climb: 120 early ones, as from the start.
    expect(until(gov, 8)).toEqual({ frames: 120, step: 0 });
    // Nor do the early ones soften the next fall: 40 late ones, not three.
    expect(until(gov, 30)).toEqual({ frames: 40, step: 1 });
  });

  it('on a 60 Hz screen, steps down when frames are missed and climbs back once they are made', () => {
    // A frame either makes vsync, 16.7 ms, or misses one, 33.3.
    const r = rng(3);
    const gov = new QualityGovernor(2);
    const missing = Array.from({ length: 400 }, () => (r() < 0.3 ? 33.3 : 16.7));
    expect(steps(run(gov, missing))).toEqual([1, 2, 3, BARE]);
    expect(steps(run(gov, times(10_000, 16.7)))).toEqual([3, 2, 1, 0]);
    expect(gov.step).toBe(0);
  });

  describe('does not flap', () => {
    it('on frames that alternate around a bound: it moves one way, if at all', () => {
      // Whether it stays put: half the frames late is late, half of them early is not early.
      for (const [a, b, still] of [
        [19, 21, false],
        [19.9, 20.1, false],
        [11, 21, false],
        [17, 19, true],
        [FAST_MS - 0.1, FAST_MS + 0.1, true],
        [FAST_MS, SLOW_MS, true],
        [18.5, 19.5, true],
      ] as const) {
        for (const start of [0, 2, BARE]) {
          const gov = new QualityGovernor(2, start);
          const alternating = Array.from({ length: 6_000 }, (_, i) => (i % 2 ? a : b));
          const changes = run(gov, alternating);
          const at = `${a}/${b} from ${start}`;
          expect(turns(changes, start), at).toBe(0);
          if (still) expect(changes, at).toEqual([]);
          else expect(gov.step, at).toBe(BARE);
        }
      }
    });

    it('on a load that is slow at one step and fast at the next: one retry, then it stays', () => {
      // The cost of a frame grows with the pixels drawn: 20.5 ms at 2, 11.5 ms at 1.5. Counting
      // afresh after each change alone would climb back to 2 every 160 frames and fall again.
      const gov = new QualityGovernor(2);
      const changes: number[] = [];
      for (let i = 0; i < 20_000; i++) {
        const level = gov.moving(20.5 * (gov.level.dpr / 2) ** 2);
        if (level) changes.push(gov.step);
      }
      expect(changes).toEqual([1, 0, 1]);
      expect(gov.level.dpr).toBe(1.5);
    });

    it('on bursts of late frames between stretches of early ones: it settles low', () => {
      // A burst of 40 late frames after every 120 early ones: a quarter of the frames are late.
      const burst = (cycles: number) =>
        Array.from({ length: cycles * 160 }, (_, i) => (i % 160 < 120 ? 8 : 30));
      const gov = new QualityGovernor(2);
      const changes = run(gov, burst(200));
      expect(gov.step).toBe(BARE);
      // Each step is retried at most once, and after the last change nothing moves.
      expect(changes.length).toBeLessThanOrEqual(2 * BARE);
      expect(run(gov, burst(50))).toEqual([]);
    });

    it('on bursts late only at the sharper step, however far apart: one retry', () => {
      // A few heavy frames now and then among early ones, each costing with the pixels drawn:
      // the bursts are late at 2 and only middling at 1.5. Bursts further apart than a climb
      // takes would otherwise drop it and lift it back on every one of them.
      for (const period of [200, 300, 600, 2_000]) {
        const gov = new QualityGovernor(2);
        const changes: number[] = [];
        for (let i = 0; i < 40_000; i++) {
          const level = gov.moving((i % period < 3 ? 25 : 8) * (gov.level.dpr / 2) ** 2);
          if (level) changes.push(gov.step);
        }
        expect(changes, `every ${period} frames`).toEqual([1, 0, 1]);
      }
    });

    it('gives each step one retry on a visit, however long the climb held', () => {
      const gov = new QualityGovernor(2);
      expect(until(gov, 30)).toEqual({ frames: 40, step: 1 });
      expect(until(gov, 8)).toEqual({ frames: 120, step: 0 });
      // Held long after it was earned: its window is full of early frames, so three late ones
      // are enough to fall, and the second fall from 2 keeps it out of reach.
      expect(run(gov, times(2_000, 8))).toEqual([]);
      expect(until(gov, 30)).toEqual({ frames: 3, step: 1 });
      expect(until(gov, 8)).toBeNull();
      expect(gov.step).toBe(1);
      // Falls are counted per step: 1.5 still has its own retry.
      expect(until(gov, 30)).toEqual({ frames: 3, step: 2 });
      expect(until(gov, 8)).toEqual({ frames: 120, step: 1 });
      expect(until(gov, 30)).toEqual({ frames: 40, step: 2 });
      expect(until(gov, 8)).toBeNull();
      // A fresh visit, from the step remembered, may try again.
      expect(until(new QualityGovernor(2, gov.step), 8)).toEqual({ frames: 120, step: 1 });
    });
  });

  it('takes a browser that draws less often for what it is, not for a slow machine', () => {
    // A 30 fps power saver: every frame 33 ms apart, moving or not.
    const capped = new QualityGovernor(2);
    for (let i = 0; i < 40; i++) capped.idle(33.3);
    expect(run(capped, times(5_000, 33.3))).toEqual([]);
    // Late for it is late: two of its frames in one. Its window is full, so three are enough.
    expect(until(capped, 66.7)).toEqual({ frames: 3, step: 1 });
    // And from a low step it climbs back at its own cadence.
    const low = new QualityGovernor(2, BARE);
    for (let i = 0; i < 40; i++) low.idle(33.3);
    expect(steps(run(low, times(1_000, 33.3)))).toEqual([3, 2, 1, 0]);
    // A 50 Hz panel, its frames 20 ms apart give or take: neither late nor stuck.
    const fifty = new QualityGovernor(2, 2);
    for (let i = 0; i < 40; i++) fifty.idle(i % 2 ? 19.7 : 20.3);
    const jitter = Array.from({ length: 5_000 }, (_, i) => (i % 2 ? 19.7 : 20.3));
    expect(steps(run(fifty, jitter))).toEqual([1, 0]);
  });

  it('keeps the 60 Hz bounds on a 60 Hz screen, or a faster one, and until it has measured', () => {
    for (const rest of [16.7, 16.6, 8.3, 6.9]) {
      const gov = new QualityGovernor(2);
      for (let i = 0; i < 40; i++) gov.idle(rest);
      expect(until(gov, SLOW_MS + 0.001), `${rest}`).toEqual({ frames: 40, step: 1 });
    }
    // Too few frames at rest to tell, however long: the bounds stand.
    const unsure = new QualityGovernor(2);
    for (let i = 0; i < 9; i++) unsure.idle(33.3);
    expect(until(unsure, 33.3)).toEqual({ frames: 40, step: 1 });
    // What is not an interval is not measured.
    const junk = new QualityGovernor(2);
    for (let i = 0; i < 40; i++) junk.idle([Number.NaN, 0, -5, Infinity][i % 4]!);
    expect(until(junk, 33.3)).toEqual({ frames: 40, step: 1 });
    // The middle of the frames at rest, not their worst: a hitch or two changes nothing.
    const hitch = new QualityGovernor(2);
    for (let i = 0; i < 31; i++) hitch.idle(i % 10 === 0 ? 120 : 16.7);
    expect(until(hitch, 25)).toEqual({ frames: 40, step: 1 });
  });

  it('turns the grid and the hidden cables back on when it climbs off the last step', () => {
    const gov = new QualityGovernor(1);
    expect(run(gov, times(40, 30)).map((c) => c.level)).toEqual([
      { dpr: 1, grid: false, hidden: false },
    ]);
    expect(run(gov, times(1_000, 30))).toEqual([]);
    expect(run(gov, times(120, 8)).map((c) => c.level)).toEqual([
      { dpr: 1, grid: true, hidden: true },
    ]);
    // Zoomed out under 1×: the last step keeps the screen's own ratio.
    const small = new QualityGovernor(0.8);
    expect(run(small, times(40, 30)).map((c) => c.level)).toEqual([
      { dpr: 0.8, grid: false, hidden: false },
    ]);
  });

  it('ignores what is not a frame interval', () => {
    const gov = new QualityGovernor(2);
    const junk = [Number.NaN, 0, -16, Infinity, -Infinity];
    const mixed = times(39, 30).flatMap((ms, i) => [ms, junk[i % junk.length]!]);
    expect(run(gov, mixed)).toEqual([]);
    expect(steps(run(gov, [30]))).toEqual([1]);
  });

  it('reports the level it returns, and null while nothing changes', () => {
    const gov = new QualityGovernor(2);
    for (let i = 0; i < 39; i++) expect(gov.moving(30)).toBeNull();
    const level = gov.moving(30);
    expect(level).toEqual({ dpr: 1.5, grid: true, hidden: true });
    expect(gov.level).toEqual(level);
    expect(gov.step).toBe(1);
  });

  it('agrees with the rules applied the slow way, on thousands of random frames', () => {
    const r = rng(17);
    const devices = [3, 2, 1.75, 1.5, 1.25, 1, 0.75, Number.NaN];
    let changes = 0;
    let ups = 0;
    for (let c = 0; c < 60; c++) {
      const device = devices[c % devices.length]!;
      const start = c % 3 === 0 ? undefined : Math.floor(r() * (BARE + 2)) - 1;
      // Stretches of fast, middling and slow frames, with spikes and the odd value at a bound.
      const intervals: number[] = [];
      while (intervals.length < 3_000) {
        const regime = Math.floor(r() * 4);
        const length = 10 + Math.floor(r() * 300);
        for (let i = 0; i < length; i++) {
          const base = [6 + r() * 5.9, 12 + r() * 8, 20 + r() * 20, 6 + r() * 30][regime]!;
          const spike = r() < 0.04 ? 25 + r() * 40 : 0;
          const edge = r() < 0.02 ? [FAST_MS, SLOW_MS][Math.floor(r() * 2)]! : 0;
          const junk = r() < 0.005 ? Number.NaN : 0;
          intervals.push(junk || edge || base + spike);
        }
      }
      const want = reference(device, start, intervals);
      const gov = new QualityGovernor(device, start);
      const got = intervals.map((ms) => {
        const before = gov.step;
        if (!gov.moving(ms)) return null;
        changes++;
        if (gov.step < before) ups++;
        return gov.step;
      });
      const firstWrong = got.findIndex((s, i) => s !== want[i]);
      expect(firstWrong, `case ${c}, device ${device}, start ${start}`).toBe(-1);
    }
    // Both ways came up, many times.
    expect(changes).toBeGreaterThan(200);
    expect(ups).toBeGreaterThan(50);
  });
});
