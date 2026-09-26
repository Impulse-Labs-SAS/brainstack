// The 2D layer over the WebGL scene: what needs crisp text or strokes wider
// than a pixel. Labels, the focused note's signal, paths, rings, project and
// vault names — and, when there is no WebGL, the notes and edges themselves.
//
// Labels are drawn in screen space and dropped when they would collide, so
// text stays 12px at any zoom and never piles up. Vault chips and project
// names claim their space first; note labels fit around them.

import { projector, pixelsPerUnit, type Camera, type Viewport } from '@/lib/graph-camera';
import { colorOf, type GraphEdge, type GraphModel, type GraphNode, type GraphPath } from '@/lib/graph-model';
import { LABEL_COLORS } from '@/lib/graph-palette';

export interface OverlayFrame {
  now: number;
  vp: Viewport;
  dpr: number;
  cam: Camera;
  is3D: boolean;
  brainScale: number;
  cloud: number;
  model: GraphModel;
  hover: GraphNode | null;
  selected: GraphNode | null;
  pathFrom: GraphNode | null;
  path: GraphPath | null;
  pathT0: number;
  focus: GraphNode | null;
  focusT0: number;
  hops: Map<GraphNode, number> | null;
  matched: Set<GraphNode> | null;
  /** Vault chips over each vault's region: Territories and Brain, with more than one vault. */
  vaultLabels: boolean;
  /** No WebGL: the overlay draws notes and edges too. */
  fallback: boolean;
  appear(n: GraphNode): number;
  reduceMotion: boolean;
  fonts: { sans: string; mono: string };
}

type Rect = { x: number; y: number; w: number; h: number };
type Curve = [number, number, number, number, number, number];

const MAX_NODE_PX = 11;
const screenRadius = (n: GraphNode) => Math.min(MAX_NODE_PX, Math.max(1.8, n.radius * n.sScale));
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function overlaps(a: Rect, placed: Rect[]): boolean {
  for (const b of placed) if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
  return false;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const widths = new Map<string, number>();
function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    widths.set(key, w);
  }
  return w;
}
/** Web fonts load after the first frame; widths measured with the fallback are wrong. */
export function forgetTextWidths(): void {
  widths.clear();
}

const sprites = new Map<string, HTMLCanvasElement>();
function glowSprite(rgb: readonly number[]): HTMLCanvasElement {
  const key = rgb.join(',');
  let s = sprites.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 64;
  const g = s.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${key},1)`);
  grad.addColorStop(0.18, `rgba(${key},0.6)`);
  grad.addColorStop(0.45, `rgba(${key},0.14)`);
  grad.addColorStop(1, `rgba(${key},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  sprites.set(key, s);
  return s;
}
const WHITE = [255, 255, 255];

/** Screen position, depth and scale of every note, for drawing and for picking. */
export function projectNodes(model: GraphModel, cam: Camera, vp: Viewport, is3D: boolean, brainScale: number): void {
  const project = projector(cam, vp);
  for (const n of model.nodes) {
    n.onScreen = false;
    if (!Number.isFinite(n.x)) continue;
    const p = project(n.x, n.y, Number.isFinite(n.z) ? n.z : 0);
    if (!p) continue;
    n.sx = p.x;
    n.sy = p.y;
    n.sDepth = p.depth;
    n.sScale = p.scale;
    n.sFade = is3D ? clamp(1 - (p.depth - cam.dist) / (brainScale * 1.4), 0.2, 1) : 1;
    n.onScreen = true;
  }
}

/** The note under (x, y); the hit area is a little larger than the dot. */
export function pickNode(model: GraphModel, x: number, y: number, appear: (n: GraphNode) => number): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const n of model.nodes) {
    if (!n.onScreen || appear(n) < 0.5) continue;
    const r = screenRadius(n) * (n.isIndex ? 1.3 : 1) + 6;
    const d = (n.sx - x) ** 2 + (n.sy - y) ** 2;
    if (d <= r * r && d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

function curveOf(e: GraphEdge, project: ReturnType<typeof projector>): Curve | null {
  const s = e.source;
  const t = e.target;
  if (!s.onScreen || !t.onScreen) return null;
  if (e.kind === 'affinity') return [s.sx, s.sy, (s.sx + t.sx) / 2, (s.sy + t.sy) / 2, t.sx, t.sy];
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const c = project((s.x + t.x) / 2 - dy * 0.1, (s.y + t.y) / 2 + dx * 0.1, ((s.z || 0) + (t.z || 0)) / 2);
  return c ? [s.sx, s.sy, c.x, c.y, t.sx, t.sy] : null;
}
function pointOn(c: Curve, u: number, fromSource: boolean): [number, number] {
  const t = fromSource ? u : 1 - u;
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const z = t * t;
  return [a * c[0] + b * c[2] + z * c[4], a * c[1] + b * c[3] + z * c[5]];
}
function stroke(ctx: CanvasRenderingContext2D, c: Curve) {
  ctx.beginPath();
  ctx.moveTo(c[0], c[1]);
  ctx.quadraticCurveTo(c[2], c[3], c[4], c[5]);
  ctx.stroke();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, f: OverlayFrame): void {
  const { vp, model } = f;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, vp.width, vp.height);
  if (f.fallback) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, vp.width, vp.height);
    drawFallback(ctx, f);
  }
  const project = projector(f.cam, vp);
  drawSignal(ctx, f, project);

  ctx.globalCompositeOperation = 'source-over';
  ring(ctx, f.hover, 3.5, f.hover ? colorOf(model, f.hover).core : '#fff', 1.4);
  ring(ctx, f.selected, 5, '#ffffff', 1.6);
  if (f.pathFrom && !f.path) ring(ctx, f.pathFrom, 6, '#ffffff', 1.4, true);

  const placed: Rect[] = [];
  if (f.vaultLabels) drawVaultLabels(ctx, f, project, placed);
  if (f.cloud > 0.01) drawProjectLabels(ctx, f, project, placed);
  drawNoteLabels(ctx, f, placed);
  ctx.globalAlpha = 1;
}

/** Without WebGL: straight edges and flat dots, enough to use the flat views. */
function drawFallback(ctx: CanvasRenderingContext2D, f: OverlayFrame) {
  ctx.lineWidth = 1;
  for (const e of f.model.edges) {
    if (!e.source.onScreen || !e.target.onScreen || f.appear(e.source) < 0.6 || f.appear(e.target) < 0.6) continue;
    ctx.globalAlpha = e.kind === 'structure' ? 0.12 : 0.3;
    ctx.strokeStyle = e.kind === 'affinity' || e.kind === 'topic' ? '#8f8ca3' : colorOf(f.model, e.source).hue;
    ctx.setLineDash(e.kind === 'affinity' ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(e.source.sx, e.source.sy);
    ctx.lineTo(e.target.sx, e.target.sy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const n of f.model.nodes) {
    if (!n.onScreen) continue;
    const dim = (f.matched && !f.matched.has(n)) || (f.hops && !f.hops.has(n));
    ctx.globalAlpha = f.appear(n) * (dim ? 0.2 : 1);
    ctx.fillStyle = colorOf(f.model, n).core;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, screenRadius(n), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSignal(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>) {
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const lit: Array<{ e: GraphEdge; c: Curve; fromSource: boolean; level: number }> = [];
  if (f.hops) {
    let second = 0;
    for (const e of f.model.edges) {
      const hs = f.hops.get(e.source);
      const ht = f.hops.get(e.target);
      if (hs === undefined || ht === undefined || Math.abs(hs - ht) !== 1) continue;
      const level = Math.max(hs, ht);
      if (level === 2 && second++ > 400) continue;
      const c = curveOf(e, project);
      if (c) lit.push({ e, c, fromSource: hs < ht, level });
    }
  }
  for (const h of lit) {
    ctx.strokeStyle = colorOf(f.model, h.fromSource ? h.e.source : h.e.target).hue;
    ctx.globalAlpha = (h.level === 1 ? 0.85 : 0.3) * Math.min(h.e.source.sFade, h.e.target.sFade);
    ctx.lineWidth = h.level === 1 ? 1.6 : 1;
    ctx.setLineDash(h.e.kind === 'affinity' ? [2, 4] : []);
    stroke(ctx, h.c);
  }
  ctx.setLineDash([]);

  const pathCurves = f.path ? f.path.edges.map((e) => curveOf(e, project)) : [];
  pathCurves.forEach((c, i) => {
    if (!c) return;
    const e = f.path!.edges[i]!;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2.2;
    ctx.setLineDash(e.kind === 'link' || e.kind === 'structure' ? [] : [3, 4]);
    stroke(ctx, c);
  });
  ctx.setLineDash([]);
  if (f.reduceMotion) return;

  // The signal travels out from the focused note, one hop, then the next.
  lit.slice(0, 240).forEach((h) => {
    const t = (f.now - f.focusT0 - (h.level - 1) * 420) / 950;
    if (t < 0) return;
    const u = t % 1;
    const [x, y] = pointOn(h.c, u, h.fromSource);
    const r = h.level === 1 ? 8 : 5.5;
    const alpha = (h.level === 1 ? 0.95 : 0.5) * (1 - u * 0.55);
    ctx.globalAlpha = alpha;
    ctx.drawImage(glowSprite(colorOf(f.model, h.fromSource ? h.e.source : h.e.target).rgb), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = alpha * 0.9;
    ctx.drawImage(glowSprite(WHITE), x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9);
  });

  if (f.path && pathCurves.length) {
    const count = pathCurves.length;
    const s = (((f.now - f.pathT0) / (430 * count)) % 1) * count;
    for (let j = 0; j < 5; j++) {
      const sj = s - j * 0.07;
      if (sj < 0) continue;
      const seg = Math.min(count - 1, Math.floor(sj));
      const c = pathCurves[seg];
      if (!c) continue;
      const e = f.path.edges[seg]!;
      const [x, y] = pointOn(c, sj - seg, e.source === f.path.nodes[seg]);
      const r = 10 - j * 1.5;
      ctx.globalAlpha = 1 - j * 0.18;
      ctx.drawImage(glowSprite(WHITE), x - r, y - r, r * 2, r * 2);
    }
  }
}

function ring(ctx: CanvasRenderingContext2D, n: GraphNode | null, gap: number, color: string, width: number, dashed = false) {
  if (!n?.onScreen) return;
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [3, 3] : []);
  ctx.beginPath();
  ctx.arc(n.sx, n.sy, screenRadius(n) * (n.isIndex ? 1.3 : 1) + gap, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawNoteLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, placed: Rect[]) {
  const { sans } = f.fonts;
  const fontBase = `500 12px ${sans}`;
  const fontHub = `600 12.5px ${sans}`;
  const fontStrong = `600 13.5px ${sans}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';

  // level 2: focused, on the path; 1: a neighbour or a match; 0: everything else.
  const label = (n: GraphNode, level: 0 | 1 | 2) => {
    if (!n.onScreen || n.sx < -120 || n.sx > f.vp.width + 120 || n.sy < -30 || n.sy > f.vp.height + 30) return;
    const text = truncate(n.label, 34);
    const font = level === 2 ? fontStrong : n.isIndex || n.size >= 5 ? fontHub : fontBase;
    const w = measure(ctx, text, font);
    const top = n.sy + screenRadius(n) * (n.isIndex ? 1.25 : 1) + 5;
    const rect = { x: n.sx - w / 2 - 3, y: top - 2, w: w + 6, h: 17 };
    if (level < 2 && overlaps(rect, placed)) return;
    placed.push(rect);
    ctx.font = font;
    ctx.globalAlpha = (level ? 1 : 0.88) * (level === 2 ? 1 : n.sFade);
    ctx.strokeStyle = 'rgba(10,10,10,0.92)';
    ctx.lineWidth = 4;
    ctx.strokeText(text, n.sx, top);
    ctx.fillStyle =
      level === 2 ? LABEL_COLORS.strong : level === 1 ? LABEL_COLORS.neighbour : n.kind === 'topic' ? LABEL_COLORS.topic : n.isIndex ? LABEL_COLORS.index : LABEL_COLORS.note;
    ctx.fillText(text, n.sx, top);
  };

  const seen = new Set<GraphNode>();
  const special = (n: GraphNode | null, level: 1 | 2) => {
    if (!n || seen.has(n) || f.appear(n) <= 0.5) return;
    seen.add(n);
    label(n, level);
  };
  special(f.focus, 2);
  for (const n of f.path?.nodes ?? []) special(n, 2);
  special(f.pathFrom, 2);
  if (f.hops) {
    let c = 0;
    for (const [n, h] of f.hops) if (h === 1 && c++ < 28) special(n, 1);
  }
  if (f.matched) {
    let c = 0;
    for (const n of f.model.labelOrder) if (f.matched.has(n) && c++ < 40) special(n, 1);
  }
  if (f.focus || f.matched || f.path || f.cloud >= 0.65) return;

  const k = pixelsPerUnit(f.cam, f.vp);
  const minSize = f.is3D ? (k >= 1.8 ? 0 : k >= 1.1 ? 2 : k >= 0.6 ? 4 : 8) : k >= 1 ? 0 : k >= 0.7 ? 1.2 : k >= 0.45 ? 3 : 7;
  const cap = Math.round((f.vp.width * f.vp.height) / (f.is3D ? 10000 : 5200));
  for (const n of f.model.labelOrder) {
    if (placed.length > cap) break;
    if (seen.has(n) || n.size < minSize || f.appear(n) < 0.9) continue;
    if (f.is3D && n.sFade < 0.45) continue;
    label(n, 0);
  }
}

function centroid(nodes: GraphNode[], f: OverlayFrame, project: ReturnType<typeof projector>) {
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  let top = Infinity;
  for (const n of nodes) {
    if (f.appear(n) <= 0 || !Number.isFinite(n.x)) continue;
    x += n.x;
    y += n.y;
    z += n.z || 0;
    count++;
    if (n.onScreen && n.sy < top) top = n.sy;
  }
  if (!count) return null;
  const p = project(x / count, y / count, z / count);
  return p ? { x: p.x, y: p.y, count, top } : null;
}

function drawProjectLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, placed: Rect[]) {
  const font = `600 14px ${f.fonts.sans}`;
  const small = `500 11px ${f.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const list = f.model.projects
    .map((p) => ({ p, c: centroid(p.nodes, f, project) }))
    .filter((x): x is { p: (typeof f.model.projects)[number]; c: NonNullable<ReturnType<typeof centroid>> } => !!x.c && x.c.count >= 3)
    .sort((a, b) => b.c.count - a.c.count);
  for (const { p, c } of list) {
    if (c.x < -80 || c.x > f.vp.width + 80 || c.y < -20 || c.y > f.vp.height + 20) continue;
    const text = truncate(p.label, 26);
    const w = measure(ctx, text, font);
    const rect = { x: c.x - w / 2 - 4, y: c.y - 11, w: w + 8, h: 30 };
    if (overlaps(rect, placed)) continue;
    placed.push(rect);
    ctx.globalAlpha = f.cloud;
    ctx.font = font;
    ctx.strokeStyle = 'rgba(10,10,10,0.85)';
    ctx.lineWidth = 4;
    ctx.strokeText(text, c.x, c.y);
    ctx.fillStyle = colorOf(f.model, { kind: 'note', vault: p.vault }).core;
    ctx.fillText(text, c.x, c.y);
    ctx.font = small;
    ctx.fillStyle = 'rgba(200,198,210,0.7)';
    ctx.fillText(`${c.count} notes`, c.x, c.y + 15);
  }
  ctx.globalAlpha = 1;
}

function drawVaultLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, placed: Rect[]) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 11px ${f.fonts.mono}`;
  for (const vault of f.model.vaults) {
    if (vault.hidden) continue;
    const c = centroid(
      f.model.nodes.filter((n) => n.kind === 'note' && n.vault === vault.id),
      f,
      project,
    );
    if (!c) continue;
    const text = `${vault.label.toUpperCase()} · ${c.count}`;
    const w = ctx.measureText(text).width;
    const x = clamp(c.x, w / 2 + 16, f.vp.width - w / 2 - 16);
    const y = clamp(f.is3D ? c.y - 40 : c.top - 26, 70, f.vp.height - 16);
    placed.push({ x: x - w / 2 - 10, y: y - 11, w: w + 20, h: 22 });
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(12,12,15,0.8)';
    ctx.beginPath();
    roundRect(ctx, x - w / 2 - 10, y - 11, w + 20, 22, 11);
    ctx.fill();
    ctx.strokeStyle = vault.color.hue;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = vault.color.core;
    ctx.fillText(text, x, y + 0.5);
  }
}

export interface MinimapTransform {
  scale: number;
  ox: number;
  oy: number;
}

/** A flat overview with the viewport's rectangle. World y points up; the map, like the screen, down. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number; dpr: number },
  model: GraphModel,
  cam: Camera,
  vp: Viewport,
  appear: (n: GraphNode) => number,
): MinimapTransform | null {
  const { width, height, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0c0c0f';
  ctx.fillRect(0, 0, width, height);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of model.nodes) {
    if (!Number.isFinite(n.x)) continue;
    x0 = Math.min(x0, n.x);
    x1 = Math.max(x1, n.x);
    y0 = Math.min(y0, n.y);
    y1 = Math.max(y1, n.y);
  }
  if (x0 === Infinity) return null;
  const pad = 9;
  const scale = Math.min((width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0));
  const t = { scale, ox: width / 2 - ((x0 + x1) / 2) * scale, oy: height / 2 + ((y0 + y1) / 2) * scale };
  ctx.globalAlpha = 0.8;
  for (const n of model.nodes) {
    if (!Number.isFinite(n.x) || appear(n) <= 0) continue;
    ctx.fillStyle = colorOf(model, n).hue;
    ctx.fillRect(n.x * scale + t.ox - 0.8, -n.y * scale + t.oy - 0.8, 1.6, 1.6);
  }
  const p = pixelsPerUnit(cam, vp);
  const left = cam.tx - vp.width / 2 / p;
  const top = cam.ty + vp.height / 2 / p;
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.strokeRect(left * scale + t.ox, -top * scale + t.oy, (vp.width / p) * scale, (vp.height / p) * scale);
  return t;
}
