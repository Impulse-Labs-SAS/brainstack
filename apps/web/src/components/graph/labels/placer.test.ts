import { describe, expect, it } from 'vitest';

import { LabelMemory, LabelSpace, shownFirst, type Rect } from './placer';

const VIEW: Rect = { x: 0, y: 0, w: 800, h: 600 };

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** A small LCG, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('LabelSpace', () => {
  it('takes a label that fits, and refuses one that would cover it', () => {
    const space = new LabelSpace(VIEW);
    expect(space.place([{ x: 100, y: 100, w: 80, h: 17 }])).not.toBeNull();
    expect(space.fits({ x: 150, y: 110, w: 80, h: 17 })).toBe(false);
    // Touching edges is not overlapping.
    expect(space.fits({ x: 180, y: 100, w: 40, h: 17 })).toBe(true);
    expect(space.count).toBe(1);
  });

  it('keeps labels inside the bounds', () => {
    const space = new LabelSpace(VIEW);
    expect(space.fits({ x: -1, y: 10, w: 40, h: 17 })).toBe(false);
    expect(space.fits({ x: 770, y: 10, w: 40, h: 17 })).toBe(false);
    expect(space.fits({ x: 10, y: 590, w: 40, h: 17 })).toBe(false);
    expect(space.fits({ x: 760, y: 583, w: 40, h: 17 })).toBe(true);
  });

  it('keeps what is reserved free, even when it reaches past the bounds, and does not count it', () => {
    const space = new LabelSpace(VIEW);
    // A toolbar along the top, part of it off screen; a legend in a corner.
    space.reserve({ x: -20, y: -10, w: 500, h: 50 });
    space.reserve({ x: 0, y: 500, w: 260, h: 100 });
    expect(space.fits({ x: 40, y: 30, w: 60, h: 17 })).toBe(false);
    expect(space.fits({ x: 200, y: 520, w: 80, h: 17 })).toBe(false);
    expect(space.fits({ x: 520, y: 20, w: 80, h: 17 })).toBe(true);
    expect(space.count).toBe(0);
  });

  it('places nothing whose position is not a number', () => {
    const space = new LabelSpace(VIEW);
    expect(space.fits({ x: NaN, y: 10, w: 40, h: 17 })).toBe(false);
    expect(space.fits({ x: 10, y: 10, w: Infinity, h: 17 })).toBe(false);
  });

  it('places the first slot that fits, or none', () => {
    const space = new LabelSpace(VIEW);
    space.reserve({ x: 0, y: 200, w: 800, h: 20 });
    const below = { x: 300, y: 205, w: 60, h: 17 };
    const above = { x: 300, y: 180, w: 60, h: 17 };
    expect(space.place([below, above])).toEqual(above);
    expect(space.place([below, above])).toBeNull();
  });

  it('decides exactly as a check against every placed label would, for any mix of sizes and bounds', () => {
    const rnd = rng(42);
    // The stage less a margin, as the overlay uses it, and bounds that do not start at 0.
    const BOUNDS = [VIEW, { x: 4, y: 4, w: 792, h: 592 }, { x: -50, y: 30, w: 700, h: 500 }];
    for (let round = 0; round < 30; round++) {
      const b = BOUNDS[round % BOUNDS.length]!;
      const space = new LabelSpace(b);
      const taken: Rect[] = [];
      for (let i = 0; i < 400; i++) {
        const r = {
          x: rnd() * 900 - 50,
          y: rnd() * 700 - 50,
          w: 10 + rnd() * (i % 9 === 0 ? 400 : 120),
          h: 12 + rnd() * 30,
        };
        const inside = r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;
        const expected = inside && !taken.some((t) => overlap(r, t));
        expect(space.fits(r)).toBe(expected);
        if (i % 5 === 0) {
          space.reserve(r);
          taken.push(r);
        } else if (expected) {
          space.take(r);
          taken.push(r);
        }
      }
    }
  });

  it('never lets two placed labels overlap', () => {
    const rnd = rng(7);
    const space = new LabelSpace(VIEW);
    const placed: Rect[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = space.place([{ x: rnd() * 760, y: rnd() * 580, w: 20 + rnd() * 140, h: 17 }]);
      if (r) placed.push(r);
    }
    expect(placed.length).toBeGreaterThan(50);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++)
        expect(overlap(placed[i]!, placed[j]!)).toBe(false);
    }
  });
});

describe('LabelMemory', () => {
  it('puts what was shown last frame first, each group in its order', () => {
    const memory = new LabelMemory();
    memory.begin();
    memory.shown('c');
    memory.shown('a');
    memory.begin();
    expect(shownFirst(['a', 'b', 'c', 'd'], (k) => k, memory)).toEqual(['a', 'c', 'b', 'd']);
    // Only the frame just before counts.
    memory.begin();
    expect(shownFirst(['a', 'b', 'c', 'd'], (k) => k, memory)).toEqual(['a', 'b', 'c', 'd']);
  });
});
