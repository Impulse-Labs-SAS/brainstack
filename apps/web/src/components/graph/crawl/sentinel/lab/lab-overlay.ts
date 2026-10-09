// What the lab draws in 2D over the Sentinel. First the crawl as the Crawl
// view's overlay draws it — lit threads, found notes, labels — because that
// overlay sits above the creature in the real view, and the composition is
// only judged right with the walk on top. Then, when asked, the motion's
// insides: every joint, each tentacle's target and the six grip slots.
//
// Over a space of Crawl's own, the space lights its pipes and notes itself,
// in 3D. The overlay's lit threads are the brain's gentle curves, bent
// through each thread's midpoint, and over an L-shaped pipe they would cut
// the corner — two walks on screen that disagree — so the lab turns them off
// there, and the found halos with them unless asked. Labels stay: no space
// draws text yet.

import type { Projected } from '@/lib/graph-camera';

import { CRAWL_COLORS } from '../../crawl-layer';
import type { ReplayLabel } from '../../crawl-replay';
import type { ReplayView } from '../../replay-view';
import { threadEnds } from '../../threads';
import type { Vec3 } from '../../vec';
import { GRIP_SLOTS, TENTACLES, TENTACLE_SPECS } from '../anatomy';
import type { SentinelPose } from '../pose';

export type Project = (p: Vec3) => Projected | null;

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

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
}

/** The lit threads, found notes and labels, drawn the way crawl-layer.ts draws them. */
export function drawCrawl(ctx: CanvasRenderingContext2D, P: Project, d: CrawlDrawing): void {
  const { view } = d;
  const field = view.field;
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [0, 0, 0];
  const m: Vec3 = [0, 0, 0];
  const lit = d.threads === false ? NONE : view.lit;
  const found = d.halos === false ? NONE : view.found;
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
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,6,10,0.86)';
    ctx.strokeStyle = CRAWL_COLORS[L.kind];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = CRAWL_COLORS[L.kind];
    ctx.fillText(L.text, x + 6, y + 12.5);
    ctx.globalAlpha = 1;
  }
}

/** What the motion exposes for debugging, in creature space like the pose. */
export interface MotionDebug {
  joints: Float32Array;
  jointCount: number;
  targets: Float32Array;
}

const ROLE_COLOR = { gripper: '#5eead4', crown: '#9aa3a6', explorer: '#fbbf24' } as const;

/**
 * Joints as dots, each tentacle's target as a cross in its role's colour, and
 * per grip slot its natural spot (a ring, numbered) tied to what it holds.
 */
export function drawDebug(
  ctx: CanvasRenderingContext2D,
  P: Project,
  pose: SentinelPose,
  debug: MotionDebug,
  view: ReplayView,
  font: string,
): void {
  const [ax, ay, az] = pose.anchor;
  const u = pose.unit;
  const world = (x: number, y: number, z: number): Vec3 => [ax + x * u, ay + y * u, az + z * u];

  ctx.fillStyle = 'rgba(235,240,245,0.7)';
  for (let q = 0; q < debug.jointCount * 3; q += 3) {
    const p = P(world(debug.joints[q]!, debug.joints[q + 1]!, debug.joints[q + 2]!));
    if (!p) continue;
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }

  ctx.lineWidth = 1.2;
  for (let i = 0; i < TENTACLES; i++) {
    const k = i * 3;
    const p = P(world(debug.targets[k]!, debug.targets[k + 1]!, debug.targets[k + 2]!));
    if (!p) continue;
    ctx.strokeStyle = ROLE_COLOR[TENTACLE_SPECS[i]!.role];
    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.y - 4);
    ctx.lineTo(p.x + 4, p.y + 4);
    ctx.moveTo(p.x + 4, p.y - 4);
    ctx.lineTo(p.x - 4, p.y + 4);
    ctx.stroke();
  }

  // The hull's matrix carries the body frame (x right, y up, z forward) and its centre.
  const h = pose.hull;
  const held: Vec3 = [0, 0, 0];
  ctx.font = `500 10px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  GRIP_SLOTS.forEach((slot, s) => {
    const [x, y, z] = slot.natural;
    const natural = P(
      world(
        h[12]! + h[0]! * x + h[4]! * y + h[8]! * z,
        h[13]! + h[1]! * x + h[5]! * y + h[9]! * z,
        h[14]! + h[2]! * x + h[6]! * y + h[10]! * z,
      ),
    );
    if (!natural) return;
    const hold = view.holds[s];
    const color = slot.side < 0 ? '#f472b6' : '#60a5fa';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (hold && view.field.point(hold.key, hold.u, held)) {
      const p = P(held);
      if (p) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(natural.x, natural.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(natural.x, natural.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(String(s), natural.x, natural.y + 0.5);
  });
}

/** A few lines of text at the bottom left: what the lab is doing, and what is wrong. */
export function drawNotes(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  height: number,
  font: string,
): void {
  ctx.font = `500 11px ${font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(200,205,210,0.75)';
  lines.forEach((line, i) => ctx.fillText(line, 14, height - 14 - (lines.length - 1 - i) * 16));
}
