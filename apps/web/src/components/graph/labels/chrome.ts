// What floats over the graph, measured: the rectangles labels keep clear of. Shared by the view,
// for the graph's labels, and the Sentinel, for its cards.

import type { Rect } from './placer';

/**
 * What floats over the graph, in CSS pixels from the stage's corner: every element marked
 * `data-graph-chrome`, or each child of one marked `data-graph-chrome="children"` (a row of
 * controls, whose gaps are graph). A child marked itself is measured as it says, not whole.
 * Hidden elements measure nothing.
 */
export function chromeRects(stage: HTMLElement): Rect[] {
  const base = stage.getBoundingClientRect();
  const rects: Rect[] = [];
  for (const el of stage.querySelectorAll<HTMLElement>('[data-graph-chrome]')) {
    const parts =
      el.dataset.graphChrome === 'children'
        ? [...el.children].filter(
            (c) => !(c instanceof HTMLElement && c.dataset.graphChrome !== undefined),
          )
        : [el];
    for (const part of parts) {
      const r = part.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        rects.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      }
    }
  }
  return rects;
}
