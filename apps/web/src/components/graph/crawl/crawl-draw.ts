// A crawl drawn in 2D, on the canvas over whatever shows the notes: the
// threads it lit, the notes it found and their labels, and the light point
// that stands for the walker when nothing else draws one. The Sentinel view
// draws it over its own stage (labels only: the space lights its threads and
// notes itself, in 3D) and over the brain when the stage cannot run (all of
// it, the brain's curves and halos included); the lab draws it over either.
//
// The lit threads are the brain's gentle curves, bent through each thread's
// midpoint. Over a space that routes a thread its own way they would cut the
// corner — two walks on screen that disagree — so whoever draws over one
// turns them off, and the found halos with them. Only found notes and asks
// have a label. A found note's is a reticle — brackets that close on the
// note, and a leader out to a card beside it, its title over why it was
// found — so a label never covers the note it names, nor another one.
//
// Cards are placed as every label on the graph is (labels/placer.ts): by
// importance, each where it fits, none over another, a note or the chrome, and
// at most MAX_CARDS. A find with no room for its card keeps its brackets; the
// panel names it. Their text is 12px and stays legible as they age; a long
// title is cut short rather than its card dropped. The note the panel points at
// is marked last, over the cards, its title wherever they left room: pointing at
// a row moves no card.

import { basis, type Camera, type Projected, type Viewport } from '@/lib/graph-camera';

import { LabelSpace, shownFirst, type LabelMemory, type Rect } from '../labels/placer';

import { CRAWL_COLORS, hexA } from './crawl-colors';
import type { ReplayLabel } from './crawl-replay';
import type { ReplayView } from './replay-view';
import { threadEnds } from './threads';
import type { Vec3 } from './vec';

export type Project = (p: Vec3) => Projected | null;

/** What a switched-off layer iterates over. */
const NONE: ReadonlyMap<never, never> = new Map<never, never>();

export interface CrawlDrawing {
  view: ReplayView;
  labels: readonly ReplayLabel[];
  /** A note's world radius and pulse phase, for the found halos. */
  note(id: string): { radius: number; phase: number } | null;
  /** Seconds, for the pulse of what was found. */
  time: number;
  still: boolean;
  /** The stage's size, CSS pixels: no card goes off it. */
  width: number;
  height: number;
  font: string;
  /** The lit threads, as the brain's curves. False over a space that lights its own; default true. */
  threads?: boolean;
  /** A halo on each note found. False over a space that lights its own; default true. */
  halos?: boolean;
  /** All of it at this opacity, 0–1: the cluster's level as it fades in and out. Default 1. */
  alpha?: number;
  /** The cards shown last frame: one that was up stays up while it fits, rather than trade with a peer. */
  memory?: LabelMemory;
  /** What no card may cover, CSS pixels: the chrome over the stage. */
  keep?: readonly Rect[];
  /** The note the panel points at, where it is on the screen: marked over the rest (`drawMark`). */
  mark?: Mark & { x: number; y: number; time: number; still: boolean };
}

/** The lit threads, the found notes' halos and the labels, all at `alpha`. */
export function drawCrawl(ctx: CanvasRenderingContext2D, P: Project, d: CrawlDrawing): void {
  const { view } = d;
  const field = view.field;
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [0, 0, 0];
  const m: Vec3 = [0, 0, 0];
  const lit = d.threads === false ? NONE : view.lit;
  const found = d.halos === false ? NONE : view.found;
  ctx.globalAlpha = d.alpha ?? 1;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const [key, l] of lit) {
    const [from, to] = threadEnds(key);
    if (!field.node(from, a) || !field.node(to, b) || !field.point(key, 0.5, m)) continue;
    const pa = P(a);
    const pm = P(m);
    const pb = P(b);
    if (!pa || !pm || !pb) continue;
    ctx.strokeStyle = hexA(
      l.kind === 'decision' ? CRAWL_COLORS.decision : CRAWL_COLORS.linked,
      Math.min(1, 0.35 + l.glow * 0.5),
    );
    ctx.lineWidth = 1.2 + l.glow;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.quadraticCurveTo(2 * pm.x - (pa.x + pb.x) / 2, 2 * pm.y - (pa.y + pb.y) / 2, pb.x, pb.y);
    ctx.stroke();
  }
  for (const [id, kind] of found) {
    const note = d.note(id);
    if (!note || !field.node(id, a)) continue;
    const p = P(a);
    if (!p) continue;
    const pulse =
      view.mode === 'done' && !d.still ? 1 + 0.2 * Math.sin(d.time * 3 + note.phase * 6) : 1;
    const r = Math.max(3, note.radius * p.scale * 1.6) * pulse;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
    g.addColorStop(0, hexA(CRAWL_COLORS[kind], 0.9));
    g.addColorStop(1, hexA(CRAWL_COLORS[kind], 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  drawLabels(ctx, P, d);
  ctx.globalAlpha = 1;
}

/** Half the side of a found note's brackets, and how long each arm is, CSS pixels. */
const RETICLE = 11;
const ARM = 4.5;
/** How far a card stands off its note, CSS pixels: across, and up. */
const LEAD_X = 30;
const LEAD_Y = 26;
/** A card's inner padding, its text and its heights, CSS pixels: 12px, the graph's floor for text. */
const PAD = 9;
const TEXT_PX = 12;
const CARD_H = 37;
const TITLE_H = 24;
/** How far from the stage's edges a card keeps, CSS pixels. */
const EDGE = 8;
/** The most cards up at once. */
export const MAX_CARDS = 12;
/** How wide a card's text may run, CSS pixels, and at most this share of the stage: past that it is cut short. */
const CARD_TEXT = 240;
const CARD_SHARE = 0.45;
/** How long a card stays at full strength, replay seconds. */
const FRESH_S = 4;
/** A card's glass: the same at any age, so what lies behind it never shows through more as it fades. */
export const GLASS = 0.92;
/**
 * What an older card's text and lines fade to. On its glass, over the stage's dark or over a lit
 * thread at full strength behind it, every line still reads at 4.5:1 or more, the colour of why
 * included (crawl-draw.test.ts): below this, a card is not fainter, it is unreadable.
 */
export const FADED = 0.85;
/** Which cards go first once the fresh ones have: what to clarify, what was named, then the rest. */
const RANK: Record<ReplayLabel['kind'], number> = { ask: 0, named: 1, decision: 2, linked: 3 };

/** "Title · why" into its two lines; a label with no reason is all title. */
function splitLabel(text: string): { title: string; why: string } {
  const at = text.lastIndexOf(' · ');
  return at < 0 ? { title: text, why: '' } : { title: text.slice(0, at), why: text.slice(at + 3) };
}

/** What names a label from one frame to the next. */
const keyOf = (L: ReplayLabel) => L.nodeId ?? `? ${L.text}`;

/** A found note's brackets, and the gap round them no card may take. */
const reticleBox = (x: number, y: number): Rect => ({
  x: x - RETICLE - 2,
  y: y - RETICLE - 2,
  w: 2 * RETICLE + 4,
  h: 2 * RETICLE + 4,
});

/**
 * Where a card may go beside (`x`, `y`), best first: upper right, else mirrored where the
 * stage ends, at the note's height or a card's height above or below, up to three; then the
 * other side.
 */
function cardSlots(x: number, y: number, w: number, h: number, width: number): Rect[] {
  const right = x + LEAD_X + w <= width - EDGE;
  const slots: Rect[] = [];
  for (const side of right ? [1, -1] : [-1, 1]) {
    const cx = side > 0 ? x + LEAD_X : x - LEAD_X - w;
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      slots.push({ x: cx, y: y - LEAD_Y - h / 2 + step * (h + 6), w, h });
    }
  }
  return slots;
}

/** A label to draw: where, how far it has faded in (`appear`), and what its age leaves of its ink. */
type Shown = { L: ReplayLabel; x: number; y: number; appear: number; ink: number; fresh: boolean };

function drawLabels(ctx: CanvasRenderingContext2D, P: Project, d: CrawlDrawing): void {
  const at: Vec3 = [0, 0, 0];
  const shown: Shown[] = [];
  for (const L of d.labels) {
    const where = L.nodeId ? (d.view.field.node(L.nodeId, at) ? at : null) : L.point;
    const p = where ? P(where) : null;
    if (!p) continue;
    const age = d.view.clock - L.born;
    const appear = Math.min(1, age / 0.25);
    if (appear <= 0.01) continue;
    const fresh = age <= FRESH_S;
    shown.push({ L, x: p.x, y: p.y, appear, ink: fresh ? 1 : FADED, fresh });
  }

  // By importance: what was just found, newest first, as the walk shows it; then the rest by
  // rank, in the order they were found. A card up last frame goes first among its peers.
  const fresh = shown.filter((s) => s.fresh).sort((a, b) => b.L.born - a.L.born);
  const rest = shown
    .filter((s) => !s.fresh)
    .sort((a, b) => RANK[a.L.kind] - RANK[b.L.kind] || a.L.born - b.L.born);
  const groups: Shown[][] = [fresh, ...[0, 1, 2, 3].map((r) => rest.filter((s) => RANK[s.L.kind] === r))];
  const memory = d.memory;
  memory?.begin();
  const order = groups.flatMap((g) => (memory ? shownFirst(g, (s) => keyOf(s.L), memory) : g));

  // Every note that carries a label is kept clear, and the chrome.
  const space = new LabelSpace({ x: EDGE, y: 6, w: d.width - 2 * EDGE, h: d.height - 12 });
  for (const s of shown) if (s.L.nodeId) space.reserve(reticleBox(s.x, s.y));
  for (const r of d.keep ?? []) space.reserve(r);
  const textMax = Math.min(CARD_TEXT, d.width * CARD_SHARE);

  const level = d.alpha ?? 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${TEXT_PX}px ${d.font}`;
  for (const { L, x, y, appear, ink } of order) {
    const colour = CRAWL_COLORS[L.kind];
    const split = splitLabel(L.text);
    let card: Rect | null = null;
    let title = split.title;
    let why = split.why.toUpperCase();
    if (space.count < MAX_CARDS) {
      title = ellipsize(ctx, title, textMax);
      why = why && ellipsize(ctx, why, textMax / 1.08);
      const titleW = ctx.measureText(title).width;
      const whyW = why ? ctx.measureText(why).width * 1.08 : 0;
      const w = Math.ceil(Math.max(titleW, whyW)) + 2 * PAD + 8;
      card = space.place(cardSlots(x, y, w, why ? CARD_H : TITLE_H, d.width));
    }
    if (card) memory?.shown(keyOf(L));

    // Ink: the brackets, the leader and the text, faded with age. The glass is not.
    ctx.globalAlpha = appear * ink * level;
    if (L.nodeId) {
      // The reticle: four corners closing on the note.
      ctx.strokeStyle = hexA(colour, 0.9);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        ctx.moveTo(x + sx * RETICLE, y + sy * (RETICLE - ARM));
        ctx.lineTo(x + sx * RETICLE, y + sy * RETICLE);
        ctx.lineTo(x + sx * (RETICLE - ARM), y + sy * RETICLE);
      }
      ctx.stroke();
    }
    if (!card) continue;
    const { x: cx, y: cy, w, h } = card;
    const right = cx > x;
    if (L.nodeId) {
      // The leader: from the nearest corner out, then level into the card.
      const edge = right ? cx : cx + w;
      const mid = cy + h / 2;
      const ox = x + (right ? RETICLE : -RETICLE);
      const oy = y + (mid < y ? -RETICLE : RETICLE);
      const knee = edge + (right ? -10 : 10);
      ctx.strokeStyle = hexA(colour, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(knee, mid);
      ctx.lineTo(edge, mid);
      ctx.stroke();
    }

    // The card: dark glass with a hairline edge and a lit top, a swatch of why, two lines.
    ctx.globalAlpha = appear * level;
    ctx.fillStyle = `rgba(14,15,24,${GLASS})`;
    ctx.beginPath();
    ctx.roundRect(cx, cy, w, h, 7);
    ctx.fill();
    ctx.globalAlpha = appear * ink * level;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx + 0.5, cy + 0.5, w - 1, h - 1, 7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(cx + 7, cy + 0.5);
    ctx.lineTo(cx + w - 7, cy + 0.5);
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.fillRect(cx + PAD, cy + (why ? 9.5 : 10), 3, 3);
    ctx.fillStyle = '#ecebf5';
    ctx.fillText(title, cx + PAD + 8, cy + (why ? 15.5 : 16));
    if (why) {
      ctx.fillStyle = hexA(colour, 0.9);
      ctx.fillText(why, cx + PAD + 8, cy + 30);
    }
  }

  // The mark, over the cards and taking no room from them: its title wherever they left some
  // beside the ring or the arrow, cut short to fit the free stage; none if nowhere. A free stage
  // too small to point from (a phone's sheet risen to the top) gets no mark at all.
  const mark = d.mark;
  if (mark && mark.free.w >= 4 * MARK_INSET && mark.free.h >= 2 * MARK_INSET) {
    const marked = markPlace(mark.x, mark.y, mark.free);
    ctx.font = `500 ${TEXT_PX}px ${mark.font}`;
    const text = ellipsize(ctx, mark.title, Math.min(MARK_TEXT, mark.free.w - 2 * EDGE - 14));
    const w = ctx.measureText(text).width + 14;
    const title = space.place(markSlots(marked, w, mark.free));
    ctx.globalAlpha = level;
    drawMark(ctx, mark.x, mark.y, marked, { ...mark, title: text }, title);
  }
}

/**
 * `text` cut short with an ellipsis to fit `max` CSS pixels in the context's font: the longest
 * start that does, or the ellipsis alone.
 */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** What a mark is drawn with: the note's title, the font, and the stage left free by the chrome. */
export interface Mark {
  title: string;
  font: string;
  free: Rect;
}

/** How far the ring reaches at its widest, CSS pixels: the title stands off that. */
const MARK_REACH = 14.5;
/** How far inside the free stage an arrow to a note off it stands, CSS pixels. */
const MARK_INSET = 22;
const MARK_H = 22;
/** How wide a mark's title may run, CSS pixels: past that, or past the free stage, it is cut short. */
const MARK_TEXT = 320;

type MarkPlace = { x: number; y: number; toward: number | null };

/**
 * Where a mark goes, CSS pixels: on its note, or, the note being off the free stage, on that
 * stage's edge in its direction, `toward` it (an angle; null on the note).
 */
export function markPlace(x: number, y: number, free: Rect): MarkPlace {
  if (x >= free.x && x <= free.x + free.w && y >= free.y && y <= free.y + free.h) return { x, y, toward: null };
  const cx = free.x + free.w / 2;
  const cy = free.y + free.h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const k = Math.min(
    Math.max(1, free.w / 2 - MARK_INSET) / Math.max(Math.abs(dx), 1e-6),
    Math.max(1, free.h / 2 - MARK_INSET) / Math.max(Math.abs(dy), 1e-6),
  );
  return { x: cx + dx * k, y: cy + dy * k, toward: Math.atan2(dy, dx) };
}

/** Where a mark's title may go, `w` wide, best first: beside the ring, right then left, then above and below. */
export function markSlots(at: MarkPlace, w: number, free: Rect): Rect[] {
  const y = at.y - MARK_H / 2;
  // Above and below, centred on it as far as the free stage lets: a title as wide as the free
  // stage still has a place there.
  const cx = Math.min(Math.max(at.x - w / 2, free.x + EDGE), free.x + free.w - EDGE - w);
  const slots = [
    { x: at.x + MARK_REACH + 6, y, w, h: MARK_H },
    { x: at.x - MARK_REACH - 6 - w, y, w, h: MARK_H },
    { x: cx, y: at.y - MARK_REACH - 6 - MARK_H, w, h: MARK_H },
    { x: cx, y: at.y + MARK_REACH + 6, w, h: MARK_H },
  ];
  // On the free stage: the arrow's title never goes under the chrome it was kept clear of.
  return slots.filter((r) => r.x >= free.x && r.x + r.w <= free.x + free.w && r.y >= free.y && r.y + r.h <= free.y + free.h);
}

/**
 * The note the person points at in the side panel, CSS pixels: a ring round it at (`x`, `y`),
 * or, off the free stage, an arrowhead on its edge pointing the way (`at`); and its title in
 * `title`, so a row of the panel and the note it names can be found together. Still under
 * reduced motion.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  at: MarkPlace,
  mark: Mark & { time: number; still: boolean },
  title: Rect | null,
): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(237,237,237,0.9)';
  ctx.lineWidth = 1.5;
  if (at.toward === null) {
    const r = 13 + (mark.still ? 0 : 1.5 * Math.sin(mark.time * 5));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const ux = Math.cos(at.toward);
    const uy = Math.sin(at.toward);
    ctx.fillStyle = 'rgba(237,237,237,0.9)';
    ctx.beginPath();
    ctx.moveTo(at.x + ux * 9, at.y + uy * 9);
    ctx.lineTo(at.x - ux * 5 - uy * 7, at.y - uy * 5 + ux * 7);
    ctx.lineTo(at.x - ux * 5 + uy * 7, at.y - uy * 5 - ux * 7);
    ctx.closePath();
    ctx.fill();
  }
  if (!title) return;
  ctx.fillStyle = 'rgba(6,6,10,0.92)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(title.x, title.y, title.w, title.h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ededed';
  ctx.fillText(mark.title, title.x + 7, title.y + 15);
}

/**
 * Where a point the camera cannot project — behind it — lies as seen on the stage: a point far
 * off the stage on that side, so a mark still points the way. Null when it lies straight behind.
 */
export function behindCamera(cam: Camera, vp: Viewport, at: Vec3): { x: number; y: number } | null {
  const { position, right, up } = basis(cam);
  const v = [at[0] - position[0], at[1] - position[1], at[2] - position[2]];
  const sx = v[0]! * right[0] + v[1]! * right[1] + v[2]! * right[2];
  const sy = -(v[0]! * up[0] + v[1]! * up[1] + v[2]! * up[2]);
  const len = Math.hypot(sx, sy);
  // Straight behind, to within rounding: no side to point to.
  if (!(len > 1e-9 * Math.hypot(v[0]!, v[1]!, v[2]!))) return null;
  return { x: vp.width / 2 + (sx / len) * 1e5, y: vp.height / 2 + (sy / len) * 1e5 };
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

/**
 * The walker as light alone, at (`x`, `y`) in CSS pixels: a soft point that
 * breathes, still under reduced motion. What shows where the walk is when no
 * creature is drawn — the trail over the brain, when the stage cannot run.
 */
export function drawSignal(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  time: number,
  still: boolean,
): void {
  const r = 9 + (still ? 0 : 2 * Math.sin(time * 6));
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
  g.addColorStop(0, hexA(CRAWL_COLORS.linked, 1));
  g.addColorStop(0.3, hexA(CRAWL_COLORS.linked, 0.55));
  g.addColorStop(1, hexA(CRAWL_COLORS.linked, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
  ctx.fill();
}
