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
// have a label.

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

function drawLabels(ctx: CanvasRenderingContext2D, P: Project, d: CrawlDrawing): void {
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const at: Vec3 = [0, 0, 0];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 11px ${d.font}`;
  for (const L of d.labels) {
    const where = L.nodeId ? (d.view.field.node(L.nodeId, at) ? at : null) : L.point;
    const p = where ? P(where) : null;
    if (!p) continue;
    const age = d.view.clock - L.born;
    let alpha = Math.min(1, age / 0.25) * (age > 4 ? (L.kind === 'ask' ? 0.85 : 0.55) : 1);
    if (d.view.mode === 'done' && L.kind !== 'named' && L.kind !== 'ask') alpha *= 0.25;
    if (alpha <= 0.01) continue;
    const w = ctx.measureText(L.text).width + 12;
    const h = 18;
    let x = p.x + 10;
    let y = p.y - 24;
    if (x + w > d.width - 6) x = p.x - 10 - w;
    x = Math.max(6, x);
    for (let i = 0; i < 4; i++) {
      if (!placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y)) break;
      y += 21;
    }
    placed.push({ x, y, w, h });
    ctx.globalAlpha = alpha * (d.alpha ?? 1);
    ctx.fillStyle = 'rgba(6,6,10,0.86)';
    ctx.strokeStyle = CRAWL_COLORS[L.kind];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = CRAWL_COLORS[L.kind];
    ctx.fillText(L.text, x + 6, y + 12.5);
  }
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
