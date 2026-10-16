// What floats over the graph, measured: the rectangles labels keep clear of, and the stage they
// leave free. Shared by the view, for the graph's labels, the Sentinel, for its cards and its
// camera, and line art, for where it frames what it flies to.

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

/** How near an edge of the free stage a piece of chrome is to stand along it, CSS pixels. */
const ALONG_EDGE = 16;

/**
 * The stage less the chrome along its edges, CSS pixels: whatever stands within ALONG_EDGE of an
 * edge — a panel, a sheet, a toolbar, the zoom, the transport — takes the strip it stands on,
 * whichever of its edges costs least; taking one can bring another to the new edge (the
 * transport over a phone's sheet). Something across the whole width takes only the top or the
 * bottom, and something down the whole height only a side. What floats clear of every edge takes
 * nothing, and nor does what has slid off the stage.
 */
export function freeStage(width: number, height: number, chrome: readonly Rect[]): Rect {
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  const pending = chrome.filter((r) => r.w > 0 && r.h > 0).sort((a, b) => b.w * b.h - a.w * a.h);
  for (let taken = true; taken; ) {
    taken = false;
    for (const r of [...pending]) {
      // Outside what is still free (already under a panel, slid away): nothing to take.
      if (r.x >= x1 || r.y >= y1 || r.x + r.w <= x0 || r.y + r.h <= y0) {
        pending.splice(pending.indexOf(r), 1);
        continue;
      }
      const top = r.y <= y0 + ALONG_EDGE;
      const bottom = r.y + r.h >= y1 - ALONG_EDGE;
      const left = r.x <= x0 + ALONG_EDGE;
      const right = r.x + r.w >= x1 - ALONG_EDGE;
      const across = left && right;
      const down = top && bottom;
      const cuts: [number, () => void][] = [];
      if (top && !down) cuts.push([(r.y + r.h - y0) * (x1 - x0), () => (y0 = r.y + r.h)]);
      if (bottom && !down) cuts.push([(y1 - r.y) * (x1 - x0), () => (y1 = r.y)]);
      if (left && !across) cuts.push([(r.x + r.w - x0) * (y1 - y0), () => (x0 = r.x + r.w)]);
      if (right && !across) cuts.push([(x1 - r.x) * (y1 - y0), () => (x1 = r.x)]);
      if (!cuts.length) continue;
      cuts.sort((a, b) => a[0] - b[0])[0]![1]();
      pending.splice(pending.indexOf(r), 1);
      taken = true;
    }
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
