import { describe, expect, it } from 'vitest';

import {
  QualityGovernor,
  classifyRenderer,
  recallStable,
  rememberStable,
  startTier,
  type Caps,
  type Decision,
  type GovernorOptions,
} from './quality';
import type { Tier } from './tiers';

const HZ60 = 1000 / 60;
const IRIS_XE =
  'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const RTX =
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11)';

describe('classifyRenderer', () => {
  it('knows a software rasteriser, however it is wrapped', () => {
    for (const name of [
      'Google SwiftShader',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ]) {
      expect(classifyRenderer(name)).toBe('software');
    }
  });

  it('reads the GPU out of an ANGLE string', () => {
    expect(classifyRenderer(IRIS_XE)).toBe('integrated');
    expect(classifyRenderer(RTX)).toBe('discrete');
    expect(
      classifyRenderer(
        'ANGLE (Apple, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)',
      ),
    ).toBe('discrete');
  });

  it('calls Safari’s masked name and mobile GPUs integrated', () => {
    expect(classifyRenderer('Apple GPU')).toBe('integrated');
    expect(classifyRenderer('Mali-G78')).toBe('integrated');
    expect(classifyRenderer('Adreno (TM) 740')).toBe('integrated');
  });

  it('tells a vendor’s integrated chips from its cards', () => {
    expect(
      classifyRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('integrated');
    expect(classifyRenderer('AMD Radeon RX 6700 XT')).toBe('discrete');
    expect(classifyRenderer('Intel(R) Arc(TM) A770 Graphics')).toBe('discrete');
    expect(classifyRenderer('Intel(R) Arc(TM) Graphics')).toBe('integrated');
  });

  it('knows nothing about a missing or masked name', () => {
    expect(classifyRenderer(null)).toBe('unknown');
    expect(classifyRenderer('')).toBe('unknown');
    expect(classifyRenderer('WebKit WebGL')).toBe('unknown');
  });
});

describe('startTier', () => {
  const caps = (over: Partial<Caps>): Caps => ({
    renderer: IRIS_XE,
    floatColor: true,
    maxSamples: 4,
    timer: false,
    dpr: 1,
    pixels: 1920 * 1080,
    ...over,
  });

  it('starts by the kind of GPU', () => {
    expect(startTier(caps({ renderer: 'Google SwiftShader' }), null)).toBe('trail');
    expect(startTier(caps({}), null)).toBe(2);
    expect(startTier(caps({ renderer: null }), null)).toBe(2);
    expect(startTier(caps({ renderer: RTX }), null)).toBe(3);
  });

  it('starts at the lightest tier without half-float targets', () => {
    expect(startTier(caps({ renderer: RTX, floatColor: false }), null)).toBe(0);
  });

  it('keeps a very large drawing buffer below the top tier', () => {
    expect(startTier(caps({ renderer: RTX, dpr: 2, pixels: 3840 * 2160 }), null)).toBe(2);
  });

  it('never starts above where the last crawl settled, nor raises a start by it', () => {
    expect(startTier(caps({ renderer: RTX }), 1)).toBe(1);
    expect(startTier(caps({}), 3)).toBe(2);
    expect(startTier(caps({ renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' }), 3)).toBe('trail');
  });
});

describe('the last stable tier', () => {
  it('remembers where a crawl ended, and a trail as the lightest tier', () => {
    rememberStable(1);
    expect(recallStable()).toBe(1);
    rememberStable('trail');
    expect(recallStable()).toBe(0);
  });
});

/** One frame of a load: its time since the last, and what the Sentinel cost in it. */
interface Load {
  dt: (i: number) => number;
  cpu?: (tier: Tier | 'trail') => number;
  gpu?: (tier: Tier | 'trail') => number | null;
  settled?: (i: number) => boolean;
}

type Change = Decision & { at: number };

/** Time, and a frame count that carries across calls so a load's pattern does too. */
interface Clock {
  now: number;
  frame: number;
}
const clockAt = (now: number): Clock => ({ now, frame: 0 });

/**
 * Plays `ms` of frames into a governor — or fewer, up to its first change, with
 * `untilChange` — and returns the changes it made, with their times.
 */
function play(
  g: QualityGovernor,
  clock: Clock,
  ms: number,
  load: Load,
  untilChange = false,
): Change[] {
  const changes: Change[] = [];
  const end = clock.now + ms;
  while (clock.now < end && !(untilChange && changes.length > 0)) {
    const i = clock.frame++;
    clock.now += load.dt(i);
    const tier = g.tier;
    const d = g.sample({
      now: clock.now,
      settled: load.settled?.(i) ?? true,
      cpuMs: load.cpu?.(tier) ?? 0.3,
      gpuMs: load.gpu?.(tier) ?? null,
    });
    if (d.changed) changes.push({ ...d, at: clock.now });
  }
  return changes;
}

const steady = (dt: number) => () => dt;
const governor = (start: Tier, timer: boolean, opts?: Partial<GovernorOptions>) =>
  new QualityGovernor(start, timer, opts);

describe('QualityGovernor', () => {
  it('ignores frames that are not at rest, follow one that was not, or span a hidden tab', () => {
    const g = governor(2, false);
    const clock = clockAt(1000);
    // The layout is settling: slow frames, none at rest.
    expect(play(g, clock, 20_000, { dt: steady(50), settled: () => false })).toEqual([]);
    // Every other frame ticks the layout; the slow frame after each one is the tick's.
    const ticking: Load = { dt: (i) => (i % 2 ? 50 : HZ60), settled: (i) => i % 2 === 1 };
    expect(play(g, clock, 20_000, ticking)).toEqual([]);
    // One frame in four comes back from a hidden tab.
    expect(play(g, clock, 20_000, { dt: (i) => (i % 4 ? HZ60 : 400) })).toEqual([]);
    expect(g.tier).toBe(2);
    // The same slow frames, at rest, are the Sentinel's to answer for.
    expect(play(g, clock, 10_000, { dt: (i) => (i % 4 ? HZ60 : 50) })).not.toEqual([]);
  });

  it('ignores frames during the grace after a hold', () => {
    const g = governor(2, false, { graceMs: 3000 });
    const clock = clockAt(1000);
    play(g, clock, 5000, { dt: steady(HZ60) });
    g.hold(clock.now);
    // Two and a half seconds of stutter, which would be over 40% of a window.
    expect(play(g, clock, 2500, { dt: steady(50) })).toEqual([]);
    expect(play(g, clock, 10_000, { dt: steady(HZ60) })).toEqual([]);
    expect(g.tier).toBe(2);
  });

  it('estimates vsync at 60, 120 and 144 Hz from quantised frame times', () => {
    for (const hz of [60, 120, 144]) {
      const period = 1000 / hz;
      const g = governor(2, false);
      // Mostly on vsync with a little jitter, one frame in seven a vsync late.
      const jitter = (i: number) => (((i * 37) % 11) - 5) * 0.04;
      play(g, clockAt(1000), 4000, { dt: (i) => period * (i % 7 ? 1 : 2) + jitter(i) });
      expect(g.vsyncMs).toBeGreaterThan(period - 0.3);
      expect(g.vsyncMs).toBeLessThan(period + 0.3);
    }
  });

  it('steps down one tier, once, when a quarter of a window misses its frame', () => {
    const g = governor(2, false);
    const clock = clockAt(1000);
    const start = clock.now;
    // One frame in four takes three vsyncs; any 120 in a row hold exactly 30.
    const quarter: Load = { dt: (i) => (i % 4 ? HZ60 : 3 * HZ60) };
    const [first] = play(g, clock, 10_000, quarter).slice(0, 1);
    expect(first).toMatchObject({ tier: 1, reason: 'missed' });
    // Not before the grace and a full window of 120 frames.
    expect(first!.at - start).toBeGreaterThan(1200 + 120 * HZ60);
    // Steady frames afterwards change nothing, and without a timer it never climbs back.
    const g2 = governor(2, false);
    const clock2 = clockAt(1000);
    expect(play(g2, clock2, 10_000, quarter, true)).toHaveLength(1);
    expect(play(g2, clock2, 30_000, { dt: steady(HZ60) })).toEqual([]);
    expect(g2.tier).toBe(1);
  });

  it('leaves the tier alone when fewer than a quarter miss', () => {
    const g = governor(2, false);
    expect(play(g, clockAt(1000), 30_000, { dt: (i) => (i % 5 ? HZ60 : 3 * HZ60) })).toEqual([]);
  });

  it('waits out the cooldown between steps', () => {
    // At 144 Hz a window fills in under a second, so only the cooldown spaces the steps.
    const g = governor(3, false, { cooldownMs: 5000, graceMs: 0 });
    const changes = play(g, clockAt(1000), 30_000, { dt: steady(1000 / 144), cpu: () => 3 });
    expect(changes.map((c) => c.tier)).toEqual([2, 1, 0]);
    expect(changes.every((c) => c.reason === 'cpu')).toBe(true);
    for (let k = 1; k < changes.length; k++) {
      const gap = changes[k]!.at - changes[k - 1]!.at;
      expect(gap).toBeGreaterThanOrEqual(5000);
      expect(gap).toBeLessThan(5000 + 20);
    }
  });

  it('never steps up without the GPU timer', () => {
    const g = governor(1, false);
    const light: Load = { dt: steady(HZ60), cpu: () => 0.1, gpu: () => 0.2 };
    expect(play(g, clockAt(1000), 120_000, light)).toEqual([]);
    expect(g.tier).toBe(1);
  });

  it('steps up only after three clean windows', () => {
    const g = governor(1, true);
    const clock = clockAt(1000);
    const start = clock.now;
    const light: Load = { dt: steady(HZ60), cpu: () => 0.1, gpu: () => 0.5 };
    const [up] = play(g, clock, 20_000, light);
    expect(up).toMatchObject({ tier: 2, reason: 'headroom' });
    const window = 120 * HZ60;
    expect(up!.at - start).toBeGreaterThan(1200 + 3 * window - HZ60);
    expect(up!.at - start).toBeLessThan(1200 + 4 * window);
  });

  it('starts counting clean windows again after one that is not', () => {
    const g = governor(1, true);
    const clock = clockAt(1000);
    const window = 120 * HZ60;
    const light: Load = { dt: steady(HZ60), cpu: () => 0.1, gpu: () => 0.5 };
    // One frame in ten a vsync late: far from a step down, too many to be clean.
    const late: Load = { ...light, dt: (i) => (i % 10 ? HZ60 : 3 * HZ60) };
    // Chunks end mid-window, so no decision sits on a boundary.
    expect(play(g, clock, 1200 + 2.5 * window, light)).toEqual([]); // two clean windows
    expect(play(g, clock, 120 * 20, late)).toEqual([]); // the third is not clean
    expect(play(g, clock, 3 * window, light)).toEqual([]); // nor the fourth; then two clean
    expect(play(g, clock, window, light)).toMatchObject([{ tier: 2, reason: 'headroom' }]);
  });

  it('keeps alternating load from swinging the tier: one retry, then the lower tier sticks', () => {
    // Tier 3 is too heavy for this GPU and tier 2 leaves room to spare: without a
    // ceiling the governor would climb back every few windows and fall again.
    const g = governor(3, true);
    const load: Load = {
      // At tier 3 one frame in ten slips a vsync: the GPU time is real.
      dt: (i) => (g.tier === 3 && i % 10 === 0 ? 2 * HZ60 : HZ60),
      cpu: () => 0.1,
      gpu: (tier) => (tier === 3 ? 6 : 0.5),
    };
    const changes = play(g, clockAt(1000), 300_000, load);
    expect(changes.map((c) => [c.tier, c.reason])).toEqual([
      [2, 'gpu'],
      [3, 'headroom'],
      [2, 'gpu'],
    ]);
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(30_000);
    expect(g.tier).toBe(2);
    expect(g.log.some((line) => line.includes('T3 is out of reach for the session'))).toBe(true);
  });

  it('trusts a long GPU time only when frames are being missed', () => {
    // The timer also counts the compositor and other apps on a shared GPU: a
    // long time while every frame makes vsync is not the Sentinel's to shed.
    const g = governor(3, true);
    const busy: Load = { dt: steady(HZ60), cpu: () => 0.1, gpu: () => 6.6 };
    expect(play(g, clockAt(1000), 60_000, busy)).toEqual([]);
    expect(g.tier).toBe(3);
  });

  it('steps down a machine below 16 fps, which a capped frame time would hide', () => {
    const g = governor(2, false);
    const changes = play(g, clockAt(1000), 30_000, { dt: steady(70) });
    expect(changes.map((c) => [c.tier, c.reason])).toEqual([
      [1, 'missed'],
      [0, 'missed'],
    ]);
  });

  it('steps down a steady 30 or 20 fps without a timer, which a slow display would excuse', () => {
    for (const dt of [1000 / 30, 50]) {
      const g = governor(2, false);
      const changes = play(g, clockAt(1000), 30_000, { dt: steady(dt) });
      expect(changes.map((c) => [c.tier, c.reason])).toEqual([
        [1, 'missed'],
        [0, 'missed'],
      ]);
    }
  });

  it('turns to the trail only on GPU-timed overload at the lowest tier', () => {
    // Without the timer, nothing proves the cost is the Sentinel's.
    const blind = governor(0, false);
    expect(play(blind, clockAt(1000), 60_000, { dt: steady(70), cpu: () => 5 })).toEqual([]);
    expect(blind.tier).toBe(0);

    // Over the GPU budget, but not twice over it: the lowest tier stays.
    const heavy = governor(0, true);
    expect(play(heavy, clockAt(1000), 60_000, { dt: steady(HZ60), gpu: () => 6 })).toEqual([]);

    // Overloaded from tier 1, and costing frames: first the lowest tier, then the
    // trail once it has overloaded for 5 s.
    const g = governor(1, true);
    const clock = clockAt(1000);
    const slipping = (i: number) => (i % 10 === 0 ? 2 * HZ60 : HZ60);
    const changes = play(g, clock, 30_000, { dt: slipping, gpu: () => 12 });
    expect(changes.map((c) => [c.tier, c.reason])).toEqual([
      [0, 'gpu'],
      ['trail', 'overload'],
    ]);
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(play(g, clock, 10_000, { dt: steady(HZ60) })).toEqual([]);
    expect(g.tier).toBe('trail');
  });

  it('holds a forced tier until auto is handed back', () => {
    const g = governor(2, true);
    const clock = clockAt(1000);
    g.force(0);
    expect(g.tier).toBe(0);
    const light: Load = { dt: steady(HZ60), cpu: () => 0.1, gpu: () => 0.5 };
    expect(play(g, clock, 30_000, light)).toEqual([]);
    expect(g.tier).toBe(0);
    g.force(null);
    expect(g.tier).toBe(2);
    expect(play(g, clock, 30_000, light)[0]).toMatchObject({ tier: 3, reason: 'headroom' });
  });
});
