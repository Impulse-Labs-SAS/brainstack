import { describe, expect, it } from 'vitest';

import { frameStats } from './frame-probe';

describe('frameStats', () => {
  it('reads an even 60 fps as such', () => {
    const s = frameStats(Array(120).fill(1000 / 60), []);
    expect(s.frames).toBe(120);
    expect(s.p50).toBeCloseTo(16.667, 3);
    expect(s.p95).toBeCloseTo(16.667, 3);
    expect(s.fps).toBeCloseTo(60, 6);
  });

  it('puts the odd slow frame in p95 and max, not in the median', () => {
    const gaps = [...Array(95).fill(16), ...Array(5).fill(50)];
    const s = frameStats(gaps, [60, 80]);
    expect(s.p50).toBe(16);
    expect(s.p95).toBe(16);
    expect(s.max).toBe(50);
    expect(frameStats([...gaps, 50], []).p95).toBe(50);
    expect(s.longTasks).toBe(2);
    expect(s.longTaskMs).toBe(140);
  });

  it('says nothing about frames it never saw', () => {
    expect(frameStats([], [])).toEqual({
      frames: 0,
      p50: 0,
      p95: 0,
      max: 0,
      fps: 0,
      longTasks: 0,
      longTaskMs: 0,
    });
  });
});
