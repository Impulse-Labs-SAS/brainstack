// Where the tooltip goes: beside what the pointer is on, never over it. The note pointed at and
// the selected note keep their dots and labels in sight, and so do the chrome and the cursor. It
// tries each side of the note in turn, sliding along that side to stay on the stage, and keeps to
// the side it took last frame while that still fits, so it does not jump between two that both
// do. With no room on any side there is no tooltip: the note's label, never dropped, names it.
//
// Pure: no DOM. Every rectangle is in CSS pixels from the stage's corner.

import type { Viewport } from '@/lib/graph-camera';

import { LabelSpace, type Rect } from './placer';

export type TooltipSide = 'right' | 'left' | 'below' | 'above';

/** Beside the note first, read on from its name; under or over it when both sides are taken. */
const SIDES: readonly TooltipSide[] = ['right', 'left', 'below', 'above'];
/** How close the tooltip may come to the stage's edge. */
const EDGE = 8;
/** Between the tooltip and what it names. */
const GAP = 12;
/** Half the box kept clear round the pointer: the cursor is drawn there. */
const CURSOR = 10;

export interface TooltipAsk {
  /** The tooltip's size, as measured. */
  size: { w: number; h: number };
  /** The note pointed at with its label; null to go beside the pointer alone, as over a country. */
  anchor: Rect | null;
  pointer: { x: number; y: number };
  /**
   * What stays in sight: the dots and labels of the note pointed at and of the selection, and the
   * name of the country pointed at.
   */
  keep: readonly Rect[];
  /** What floats over the graph. */
  chrome: readonly Rect[];
  vp: Viewport;
  /** The side it took last frame, tried first; null when there was no tooltip. */
  previous: TooltipSide | null;
}

export interface TooltipSlot {
  rect: Rect;
  side: TooltipSide;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/**
 * Where the tooltip goes, or null when it fits nowhere. In whole pixels, so the box tested is the
 * box shown.
 */
export function tooltipSlot(ask: TooltipAsk): TooltipSlot | null {
  const { w, h } = ask.size;
  const { pointer: p, vp } = ask;
  const space = new LabelSpace({
    x: EDGE,
    y: EDGE,
    w: vp.width - 2 * EDGE,
    h: vp.height - 2 * EDGE,
  });
  const cursor = { x: p.x - CURSOR, y: p.y - CURSOR, w: 2 * CURSOR, h: 2 * CURSOR };
  for (const r of ask.chrome) space.reserve(r);
  for (const r of ask.keep) space.reserve(r);
  space.reserve(cursor);
  const a = ask.anchor ?? cursor;
  const b = space.bounds;
  // Along its side it slides to stay on the stage: a note by the edge still has it beside it.
  const across = clamp(
    Math.round(a.x + a.w / 2 - w / 2),
    Math.ceil(b.x),
    Math.floor(b.x + b.w - w),
  );
  const down = clamp(Math.round(a.y), Math.ceil(b.y), Math.floor(b.y + b.h - h));
  const slots: Record<TooltipSide, Rect> = {
    right: { x: Math.ceil(a.x + a.w + GAP), y: down, w, h },
    left: { x: Math.floor(a.x - GAP - w), y: down, w, h },
    below: { x: across, y: Math.ceil(a.y + a.h + GAP), w, h },
    above: { x: across, y: Math.floor(a.y - GAP - h), w, h },
  };
  const previous = ask.previous;
  const order = previous ? [previous, ...SIDES.filter((s) => s !== previous)] : SIDES;
  for (const side of order) if (space.fits(slots[side])) return { rect: slots[side], side };
  return null;
}
