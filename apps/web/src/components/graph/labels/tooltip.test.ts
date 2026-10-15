import { describe, expect, it } from 'vitest';

import type { Rect } from './placer';
import { tooltipSlot, type TooltipAsk } from './tooltip';

const VP = { width: 800, height: 600 };
const SIZE = { w: 280, h: 90 };

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

/** A note at (x, y) with its 12px label under it, pointed at; nothing else on the stage. */
function pointedAt(x: number, y: number, more: Partial<TooltipAsk> = {}): TooltipAsk {
  const dot = { x: x - 10, y: y - 10, w: 20, h: 20 };
  const label = { x: x - 45, y: y + 10, w: 90, h: 17 };
  return {
    size: SIZE,
    anchor: { x: x - 45, y: y - 10, w: 90, h: 37 },
    pointer: { x, y },
    keep: [dot, label],
    chrome: [],
    vp: VP,
    previous: null,
    ...more,
  };
}

describe('tooltipSlot', () => {
  it('goes right of the note, level with its top, 12px clear of it', () => {
    expect(tooltipSlot(pointedAt(300, 300))).toEqual({
      side: 'right',
      rect: { x: 357, y: 290, w: 280, h: 90 },
    });
  });

  it('goes left of a note near the right edge, and slides up off the bottom one', () => {
    expect(tooltipSlot(pointedAt(700, 300))).toEqual({
      side: 'left',
      rect: { x: 643 - 280, y: 290, w: 280, h: 90 },
    });
    // By the bottom edge it rises along the note's side rather than leave it.
    const low = tooltipSlot(pointedAt(300, 570))!;
    expect(low.side).toBe('right');
    expect(low.rect.y).toBe(600 - 8 - 90);
  });

  it('keeps to the side it took last frame while that still fits', () => {
    expect(tooltipSlot(pointedAt(400, 300, { previous: 'below' }))!.side).toBe('below');
    expect(tooltipSlot(pointedAt(400, 300, { previous: 'left' }))!.side).toBe('left');
    // Where the side it had no longer fits, it takes the first that does.
    expect(tooltipSlot(pointedAt(60, 300, { previous: 'left' }))!.side).toBe('right');
  });

  it('goes round the selected note’s label, and never under the chrome', () => {
    // The selected note's label just right of the note pointed at; a legend on the left.
    const selected = { x: 460, y: 280, w: 120, h: 17 };
    const legend = { x: 0, y: 250, w: 200, h: 200 };
    const ask = pointedAt(400, 300);
    const slot = tooltipSlot({ ...ask, keep: [...ask.keep, selected], chrome: [legend] })!;
    expect(slot.side).toBe('below');
    expect(overlap(slot.rect, selected)).toBe(false);
    expect(overlap(slot.rect, legend)).toBe(false);
    // Without them it would have gone right, over the label.
    expect(tooltipSlot(ask)!.side).toBe('right');
    expect(overlap(tooltipSlot(ask)!.rect, selected)).toBe(true);
  });

  it('beside a country, keeps clear of the cursor and of the country’s name', () => {
    const name = { x: 200, y: 280, w: 300, h: 26 };
    const slot = tooltipSlot({
      size: SIZE,
      anchor: null,
      pointer: { x: 300, y: 290 },
      keep: [name],
      chrome: [],
      vp: VP,
      previous: null,
    })!;
    expect(slot).not.toBeNull();
    expect(overlap(slot.rect, name)).toBe(false);
    expect(overlap(slot.rect, { x: 290, y: 280, w: 20, h: 20 })).toBe(false);
  });

  it('is nowhere when there is no room on any side', () => {
    expect(tooltipSlot(pointedAt(150, 100, { vp: { width: 300, height: 200 } }))).toBeNull();
    const all = { x: 0, y: 0, w: 800, h: 600 };
    expect(tooltipSlot(pointedAt(300, 300, { chrome: [all] }))).toBeNull();
  });

  it('never covers what it keeps clear of, the chrome or the cursor, and stays on the stage', () => {
    const rnd = rng(11);
    let placed = 0;
    for (let i = 0; i < 1500; i++) {
      const x = 20 + rnd() * 760;
      const y = 20 + rnd() * 560;
      const keep = [...pointedAt(x, y).keep];
      for (let k = rnd() * 4; k > 1; k--)
        keep.push({ x: rnd() * 800, y: rnd() * 600, w: 30 + rnd() * 150, h: 17 });
      const chrome = [
        { x: 0, y: 0, w: 200 + rnd() * 600, h: 30 + rnd() * 60 },
        { x: rnd() * 600, y: 400 + rnd() * 200, w: 200, h: 120 },
      ];
      const ask = pointedAt(x, y, {
        keep,
        chrome,
        size: { w: 120 + Math.round(rnd() * 160), h: 40 + Math.round(rnd() * 60) },
        previous: (['right', 'left', 'below', 'above', null] as const)[i % 5]!,
      });
      const slot = tooltipSlot(ask);
      if (!slot) continue;
      placed++;
      const r = slot.rect;
      expect(r.x).toBeGreaterThanOrEqual(8);
      expect(r.y).toBeGreaterThanOrEqual(8);
      expect(r.x + r.w).toBeLessThanOrEqual(800 - 8);
      expect(r.y + r.h).toBeLessThanOrEqual(600 - 8);
      for (const other of [...keep, ...chrome, ask.anchor!])
        expect(overlap(r, other), JSON.stringify({ r, other })).toBe(false);
      expect(overlap(r, { x: x - 10, y: y - 10, w: 20, h: 20 })).toBe(false);
    }
    expect(placed).toBeGreaterThan(1200);
  });
});
