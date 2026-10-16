import { afterEach, describe, expect, it, vi } from 'vitest';

import { chromeRects, freeStage } from './chrome';

/** An element as chromeRects reads one: a box, a mark, children. */
class FakeElement {
  constructor(
    readonly box: { x: number; y: number; w: number; h: number },
    readonly dataset: Record<string, string> = {},
    readonly children: FakeElement[] = [],
  ) {}
  getBoundingClientRect() {
    return { left: this.box.x, top: this.box.y, width: this.box.w, height: this.box.h };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('chromeRects', () => {
  it('measures what is marked, from the stage’s corner: whole, or each child, and never what is hidden', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const marked = new FakeElement({ x: 30, y: 20, w: 100, h: 40 }, { graphChrome: '' });
    const hidden = new FakeElement({ x: 0, y: 0, w: 0, h: 0 }, { graphChrome: '' });
    // A row of controls: its children, not the gaps between them; a child marked itself is measured as it says.
    const row = new FakeElement({ x: 10, y: 500, w: 600, h: 40 }, { graphChrome: 'children' }, [
      new FakeElement({ x: 10, y: 500, w: 80, h: 40 }),
      new FakeElement({ x: 400, y: 500, w: 90, h: 40 }),
      new FakeElement({ x: 200, y: 500, w: 60, h: 40 }, { graphChrome: '' }),
    ]);
    const stage = {
      getBoundingClientRect: () => ({ left: 10, top: 5, width: 800, height: 600 }),
      querySelectorAll: () => [marked, hidden, row],
    } as unknown as HTMLElement;
    expect(chromeRects(stage)).toEqual([
      { x: 20, y: 15, w: 100, h: 40 },
      { x: 0, y: 495, w: 80, h: 40 },
      { x: 390, y: 495, w: 90, h: 40 },
    ]);
  });
});

describe('freeStage in bands', () => {
  // A phone's graph chrome, as measured: the views, then a row of search and filters, then line
  // art's breadcrumb, then the zoom at the right under them; the legend along the bottom.
  const phone = [
    { x: 12, y: 12, w: 290, h: 50 },
    { x: 12, y: 72, w: 87, h: 44 },
    { x: 107, y: 72, w: 150, h: 44 },
    { x: 265, y: 72, w: 44, h: 44 },
    { x: 12, y: 125, w: 187, h: 53 },
    { x: 228, y: 187, w: 150, h: 53 },
    { x: 12, y: 742, w: 366, h: 90 },
  ];

  it('takes rows stacked from the top as the top, each reached by the one above it', () => {
    expect(freeStage(390, 844, phone, 'bands')).toEqual({ x: 0, y: 240, w: 390, h: 502 });
  });

  it('by area, takes a row under a row for a side strip: what bands are for', () => {
    expect(freeStage(390, 844, phone).w).toBeLessThan(250);
  });
});
