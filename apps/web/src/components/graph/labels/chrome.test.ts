import { afterEach, describe, expect, it, vi } from 'vitest';

import { chromeRects } from './chrome';

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
