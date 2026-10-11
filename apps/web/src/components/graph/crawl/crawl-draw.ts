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

import type { Projected } from '@/lib/graph-camera';

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
  width: number;
  font: string;
  /** The lit threads, as the brain's curves. False over a space that lights its own; default true. */
  threads?: boolean;
  /** A halo on each note found. False over a space that lights its own; default true. */
  halos?: boolean;
  /** All of it at this opacity, 0–1: the cluster's level as it fades in and out. Default 1. */
  alpha?: number;
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
/** A card's inner padding and line heights, CSS pixels. */
const PAD = 9;
const CARD_H = 34;

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (r: Box, x: number, y: number, w: number, h: number) =>
  x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;

/** "Title · why" into its two lines; a label with no reason is all title. */
function splitLabel(text: string): { title: string; why: string } {
  const at = text.lastIndexOf(' · ');
  return at < 0 ? { title: text, why: '' } : { title: text.slice(0, at), why: text.slice(at + 3) };
}

function drawLabels(ctx: CanvasRenderingContext2D, P: Project, d: CrawlDrawing): void {
  const at: Vec3 = [0, 0, 0];
  const shown: Array<{ L: ReplayLabel; x: number; y: number; alpha: number }> = [];
  for (const L of d.labels) {
    const where = L.nodeId ? (d.view.field.node(L.nodeId, at) ? at : null) : L.point;
    const p = where ? P(where) : null;
    if (!p) continue;
    const age = d.view.clock - L.born;
    let alpha = Math.min(1, age / 0.25) * (age > 4 ? (L.kind === 'ask' ? 0.85 : 0.6) : 1);
    if (d.view.mode === 'done' && L.kind !== 'named' && L.kind !== 'ask') alpha *= 0.35;
    if (alpha <= 0.01) continue;
    shown.push({ L, x: p.x, y: p.y, alpha });
  }
  // Every note that carries a label is kept clear, so no card covers a find.
  const placed: Box[] = shown
    .filter((s) => s.L.nodeId)
    .map((s) => ({ x: s.x - RETICLE - 2, y: s.y - RETICLE - 2, w: 2 * RETICLE + 4, h: 2 * RETICLE + 4 }));
  const level = d.alpha ?? 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const { L, x, y, alpha } of shown) {
    const colour = CRAWL_COLORS[L.kind];
    const { title, why } = splitLabel(L.text);
    ctx.font = `500 12px ${d.font}`;
    const titleW = ctx.measureText(title).width;
    ctx.font = `500 9.5px ${d.font}`;
    const whyW = why ? ctx.measureText(why.toUpperCase()).width * 1.08 : 0;
    const w = Math.ceil(Math.max(titleW, whyW)) + 2 * PAD + 8;
    const h = why ? CARD_H : 24;

    // To the upper right, else mirrored; then the first height free of every
    // card and note already placed.
    let right = x + LEAD_X + w <= d.width - 8;
    let cx = right ? x + LEAD_X : x - LEAD_X - w;
    if (cx < 8) {
      right = true;
      cx = Math.max(8, x + LEAD_X);
    }
    let cy = y - LEAD_Y - h / 2;
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      const ty = y - LEAD_Y - h / 2 + step * (h + 6);
      if (!placed.some((r) => overlaps(r, cx, ty, w, h))) {
        cy = ty;
        break;
      }
    }
    cy = Math.max(6, cy);
    placed.push({ x: cx, y: cy, w, h });

    ctx.globalAlpha = alpha * level;
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
    ctx.fillStyle = 'rgba(14,15,24,0.84)';
    ctx.beginPath();
    ctx.roundRect(cx, cy, w, h, 7);
    ctx.fill();
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
    ctx.fillRect(cx + PAD, cy + (why ? 9 : 10), 3, 3);
    ctx.font = `500 12px ${d.font}`;
    ctx.fillStyle = '#ecebf5';
    ctx.fillText(title, cx + PAD + 8, cy + (why ? 14.5 : 16));
    if (why) {
      ctx.font = `500 9.5px ${d.font}`;
      ctx.fillStyle = hexA(colour, 0.9);
      ctx.fillText(why.toUpperCase(), cx + PAD + 8, cy + 27);
    }
  }
}

/**
 * The note the person points at in the side panel, at (`x`, `y`) in CSS
 * pixels: a ring round it and its title beside, so a row of the panel and the
 * note it names can be found together. Still under reduced motion.
 */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  mark: { title: string; font: string; width: number; time: number; still: boolean; alpha?: number },
): void {
  const r = 13 + (mark.still ? 0 : 1.5 * Math.sin(mark.time * 5));
  ctx.globalAlpha = mark.alpha ?? 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(237,237,237,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = `500 12px ${mark.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(mark.title).width + 14;
  const h = 22;
  let lx = x + r + 6;
  if (lx + w > mark.width - 6) lx = x - r - 6 - w;
  lx = Math.max(6, lx);
  const ly = y - h / 2;
  ctx.fillStyle = 'rgba(6,6,10,0.92)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(lx, ly, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ededed';
  ctx.fillText(mark.title, lx + 7, ly + 15);
  ctx.globalAlpha = 1;
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
