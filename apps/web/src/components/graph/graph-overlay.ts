// The 2D layer over the WebGL scene: what needs crisp text or strokes wider
// than a pixel. Labels, the focused note's signal, paths, rings, project and
// vault names, the map's coasts and borders — and, when there is no WebGL, the
// notes and edges themselves.
//
// Labels are drawn in screen space and dropped when they would collide, so
// text stays at least 12px at any zoom and never piles up. They are placed by
// importance (labels/placer.ts): the selected note and the one pointed at,
// which are never dropped; the path; what they link to; what a search found;
// then the names of places (vault chips, countries, projects); then any note
// there is room for. None goes under the chrome floating over the graph, and
// none is faded until it is hard to read: a label that would be is dropped.

import { projector, pixelsPerUnit, type Camera, type Viewport } from '@/lib/graph-camera';
import { MAP_SPACING, type MapLand, type TerritoryLayout } from '@/lib/graph-map';
import { LIFT_POP, cityRadius, colorOf, type GraphEdge, type GraphModel, type GraphNode, type GraphPath, type GraphView } from '@/lib/graph-model';
import { LABEL_COLORS } from '@/lib/graph-palette';

import type { LooseRing } from './graph-engine';
import { LabelSpace, shownFirst, type LabelMemory, type Rect } from './labels/placer';

/** The map's lines as paths in world units, built once per land. */
export interface LandPaths {
  coast: Map<string, Path2D>;
  borders: Map<string, Path2D>;
  provinces: Map<string, Path2D>;
}

export function landPaths(land: MapLand): LandPaths {
  const toPaths = (segments: Map<string, number[]>) => {
    const out = new Map<string, Path2D>();
    for (const [vault, list] of segments) {
      const path = new Path2D();
      for (let i = 0; i < list.length; i += 4) {
        path.moveTo(list[i]!, list[i + 1]!);
        path.lineTo(list[i + 2]!, list[i + 3]!);
      }
      out.set(vault, path);
    }
    return out;
  };
  return { coast: toPaths(land.coast), borders: toPaths(land.borders), provinces: toPaths(land.provinces) };
}

export interface OverlayFrame {
  now: number;
  vp: Viewport;
  dpr: number;
  cam: Camera;
  is3D: boolean;
  view: GraphView;
  brainScale: number;
  cloud: number;
  model: GraphModel;
  /** Territories: the map's lines and names, faded in with the land. */
  landAlpha: number;
  land: LandPaths | null;
  /** Which projects have land yet: during a replay, the countries that exist so far. */
  landed: ReadonlySet<string> | null;
  territory: TerritoryLayout | null;
  /** The country under the pointer, and the links that leave it: its routes. */
  hotCountry: string | null;
  countryRoutes: GraphEdge[] | null;
  /** Network: the ring of notes without links. */
  ring: LooseRing | null;
  hover: GraphNode | null;
  selected: GraphNode | null;
  pathFrom: GraphNode | null;
  path: GraphPath | null;
  pathT0: number;
  focus: GraphNode | null;
  focusT0: number;
  hops: Map<GraphNode, number> | null;
  matched: Set<GraphNode> | null;
  /** The same matches, best first: who gets a label when they do not all fit. */
  matches: GraphNode[] | null;
  /** When the matches last changed: the sonar pings start from here. */
  searchT0: number;
  /** Vault chips over each vault's region: Territories and Brain, with more than one vault. */
  vaultLabels: boolean;
  /** No WebGL: the overlay draws notes and edges too. */
  fallback: boolean;
  appear(n: GraphNode): number;
  reduceMotion: boolean;
  fonts: { sans: string; mono: string };
  /** What floats over the graph (toolbar, legend, panels), in CSS pixels from the stage's corner. */
  chrome: readonly Rect[];
  /** Which labels were drawn last frame, so they keep their place. */
  labels: LabelMemory;
  /** A note label's size in CSS pixels: larger on a touch screen. */
  labelPx: number;
}

/**
 * What a frame drew that the tooltip must not cover: the dot and label of the note pointed at
 * and of the selected note, and the name of the country pointed at. `anchor` is the note pointed
 * at with its label, which the tooltip goes beside; null with none on the stage.
 */
export interface KeepClear {
  anchor: Rect | null;
  keep: Rect[];
}

type Curve = [number, number, number, number, number, number];

/** How close a label may come to the stage's edge, or to the chrome. */
const LABEL_MARGIN = 4;
/** Chips and small names: the floor every label keeps. */
const SMALL_PX = 12;
/**
 * In the brain a note fades with its depth (`sFade`). Its label used to fade
 * with it, and under this much the ink fell below 4.5:1 on the dark; now a
 * label is drawn at full strength, and dropped for a note further back.
 */
const MIN_LABEL_FADE = 0.75;
/**
 * Chips over a region never sit higher than this: the toolbar's usual height.
 * The measured chrome keeps them from under it as well, but a chip pushed down
 * is still named where one dropped against the toolbar would not be.
 */
const CHIP_TOP = 70;
/** On the map, country names show until this zoom; past it, the cities say where you are. */
const COUNTRY_NAMES_UNTIL = 2.2;
/** On the map, every country's cities are named from this zoom. */
const CITY_NAMES_FROM = 1.9;
/**
 * Further out, a country whose radius on screen is at least this share of the stage's shorter
 * side names its cities all the same: flown to, a big one lands below CITY_NAMES_FROM, and would
 * fill the stage with its own name and nothing else.
 */
const BIG_COUNTRY = 0.3;
/** Project names come with the clouds, once they are this far in, and at full strength. */
const PROJECT_NAMES_FROM = 0.5;

/** How far round a note's dot the tooltip stays clear: past the widest ring drawn round one, a path's start. */
const RING_ROOM = 7;

const MAX_NODE_PX = 11;
const screenRadius = (n: GraphNode) => Math.min(MAX_NODE_PX, Math.max(1.8, n.drawRadius * n.sScale)) * (1 + LIFT_POP * n.lift);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** A note's dot, with `pad` px round it. */
function dotRect(n: GraphNode, pad: number): Rect {
  const r = screenRadius(n) * (n.isIndex ? 1.3 : 1) + pad;
  return { x: n.sx - r, y: n.sy - r, w: 2 * r, h: 2 * r };
}
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

/**
 * Screen position, depth and scale of every note, for drawing and for
 * picking — and the radius it is drawn at, which on the map (`mapBlend` 1) is
 * the same for every city.
 */
export function projectNodes(model: GraphModel, cam: Camera, vp: Viewport, is3D: boolean, brainScale: number, mapBlend = 0): void {
  const project = projector(cam, vp);
  for (const n of model.nodes) {
    n.drawRadius = n.radius + (cityRadius(n) - n.radius) * mapBlend;
    n.onScreen = false;
    if (!Number.isFinite(n.x)) continue;
    const p = project(n.x + n.ox, n.y + n.oy, (Number.isFinite(n.z) ? n.z : 0) + n.oz);
    if (!p) continue;
    n.sx = p.x;
    n.sy = p.y;
    n.sDepth = p.depth;
    n.sScale = p.scale;
    // A match that sprang out is in front of everything: depth no longer dims it.
    n.sFade = is3D ? Math.max(clamp(1 - (p.depth - cam.dist) / (brainScale * 1.4), 0.2, 1), Math.min(1, n.lift)) : 1;
    n.onScreen = true;
  }
}

/** The note under (x, y); the hit area is a little larger than the dot. */
export function pickNode(model: GraphModel, x: number, y: number, appear: (n: GraphNode) => number): GraphNode | null {
  return pickNearest(model, x, y, appear).node;
}

/**
 * The note nearest (x, y) whose hit area takes it in — at least `minRadius` px round its
 * centre, however small it is drawn — with its distance, and the next nearest's that also
 * took it in (Infinity when none did): how sure a finger can be of what it meant.
 */
export function pickNearest(
  model: GraphModel,
  x: number,
  y: number,
  appear: (n: GraphNode) => number,
  minRadius = 0,
): { node: GraphNode | null; dist: number; next: number } {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  let nextD = Infinity;
  for (const n of model.nodes) {
    if (!n.onScreen || appear(n) < 0.5) continue;
    const r = Math.max(minRadius, screenRadius(n) * (n.isIndex ? 1.3 : 1) + 6);
    const d = (n.sx - x) ** 2 + (n.sy - y) ** 2;
    if (d > r * r) continue;
    if (d < bestD) {
      nextD = bestD;
      bestD = d;
      best = n;
    } else if (d < nextD) {
      nextD = d;
    }
  }
  return { node: best, dist: Math.sqrt(bestD), next: Math.sqrt(nextD) };
}

function curveOf(e: GraphEdge, project: ReturnType<typeof projector>): Curve | null {
  const s = e.source;
  const t = e.target;
  if (!s.onScreen || !t.onScreen) return null;
  if (e.kind === 'affinity') return [s.sx, s.sy, (s.sx + t.sx) / 2, (s.sy + t.sy) / 2, t.sx, t.sy];
  const sx = s.x + s.ox;
  const sy = s.y + s.oy;
  const tx = t.x + t.ox;
  const ty = t.y + t.oy;
  const dx = tx - sx;
  const dy = ty - sy;
  const c = project((sx + tx) / 2 - dy * 0.1, (sy + ty) / 2 + dx * 0.1, ((s.z || 0) + s.oz + (t.z || 0) + t.oz) / 2);
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

/** One frame of the overlay; what it returns is for the tooltip, which goes over it. */
export function drawOverlay(ctx: CanvasRenderingContext2D, f: OverlayFrame): KeepClear {
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
  drawLand(ctx, f);
  drawLooseRing(ctx, f, project);
  drawSignal(ctx, f, project);

  ctx.globalCompositeOperation = 'source-over';
  drawSearch(ctx, f, project);
  ring(ctx, f.hover, 3.5, f.hover ? colorOf(model, f.hover).core : '#fff', 1.4);
  ring(ctx, f.selected, 5, '#ffffff', 1.6);
  if (f.pathFrom && !f.path) ring(ctx, f.pathFrom, 6, '#ffffff', 1.4, true);

  // Labels, most important first: each takes its room before the next looks for some.
  const m = LABEL_MARGIN;
  const space = new LabelSpace({ x: m, y: m, w: vp.width - 2 * m, h: vp.height - 2 * m });
  for (const r of f.chrome) space.reserve({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  f.labels.begin();
  const key = keyNotes(f);
  // No label covers a note that matters.
  for (const { n } of key) if (n.onScreen) space.reserve(dotRect(n, 2));
  const labels = new Map<GraphNode, Rect>();
  for (const { n, level, force } of key) {
    const rect = noteLabel(ctx, f, space, n, level, force);
    if (rect) labels.set(n, rect);
  }

  let hotName: Rect | null = null;
  if (f.landAlpha > 0.01 && f.territory) {
    drawContinentLabels(ctx, f, project, space);
    hotName = drawCountryLabels(ctx, f, project, space);
  } else if (f.matches) {
    drawMatchZones(ctx, f, project, space);
  } else if (f.vaultLabels) {
    drawVaultLabels(ctx, f, project, space);
  }
  drawLooseRingLabel(ctx, f, project, space);
  // While searching, the zone chips name the projects that matter.
  if (f.cloud >= PROJECT_NAMES_FROM && !f.matches) drawProjectLabels(ctx, f, project, space);
  drawRestLabels(ctx, f, space, new Set(key.map((k) => k.n)));
  ctx.globalAlpha = 1;
  return keepClear(f, labels, hotName);
}

/** What the tooltip must leave in sight (KeepClear), from the labels this frame gave the key notes. */
function keepClear(f: OverlayFrame, labels: ReadonlyMap<GraphNode, Rect>, hotName: Rect | null): KeepClear {
  const keep: Rect[] = hotName ? [hotName] : [];
  let anchor: Rect | null = null;
  for (const n of new Set([f.hover, f.selected])) {
    if (!n?.onScreen) continue;
    const dot = dotRect(n, RING_ROOM);
    const label = labels.get(n);
    keep.push(dot);
    if (label) keep.push(label);
    if (n === f.hover) anchor = label ? union(dot, label) : dot;
  }
  return { anchor, keep };
}

/**
 * The map's lines, in world units: folder lines dotted, borders thin, the
 * coast glowing in the vault's colour. The flat views look straight down, so
 * world to screen is a scale and a shift.
 */
function drawLand(ctx: CanvasRenderingContext2D, f: OverlayFrame) {
  if (!f.land || f.landAlpha <= 0.01) return;
  const s = pixelsPerUnit(f.cam, f.vp);
  const { width, height } = f.vp;
  ctx.save();
  ctx.setTransform(f.dpr * s, 0, 0, -f.dpr * s, f.dpr * (width / 2 - f.cam.tx * s), f.dpr * (height / 2 + f.cam.ty * s));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const vault of f.model.vaults) {
    if (vault.hidden) continue;
    const [r, g, b] = vault.color.rgb;
    const provinces = f.land.provinces.get(vault.id);
    if (provinces) {
      ctx.setLineDash([2.5 / s, 3.5 / s]);
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.4 * f.landAlpha})`;
      ctx.lineWidth = 0.8 / s;
      ctx.stroke(provinces);
      ctx.setLineDash([]);
    }
    const borders = f.land.borders.get(vault.id);
    if (borders) {
      ctx.strokeStyle = vault.color.core;
      ctx.globalAlpha = 0.42 * f.landAlpha;
      ctx.lineWidth = 1.1 / s;
      ctx.stroke(borders);
      ctx.globalAlpha = 1;
    }
    const coast = f.land.coast.get(vault.id);
    if (coast) {
      ctx.shadowColor = vault.color.hue;
      ctx.shadowBlur = 14 * f.dpr;
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.85 * f.landAlpha})`;
      ctx.lineWidth = 1.5 / s;
      ctx.stroke(coast);
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
}

/** Network: a dotted ring where the notes without a single link wait. */
function drawLooseRing(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>) {
  if (!f.ring || f.view !== 'network') return;
  const c = project(0, 0, 0);
  if (!c) return;
  const r = f.ring.r * c.scale;
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Over the ring, how many notes wait on it: a name of a place, placed with the others. */
function drawLooseRingLabel(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace) {
  if (!f.ring || f.view !== 'network') return;
  const c = project(0, 0, 0);
  if (!c) return;
  const y = c.y - f.ring.r * c.scale - 12;
  const text = `NO LINKS · ${f.ring.count}`;
  const font = `500 ${SMALL_PX}px ${f.fonts.mono}`;
  const w = measure(ctx, text, font);
  if (!space.place([{ x: c.x - w / 2 - 3, y: y - SMALL_PX / 2 - 3, w: w + 6, h: SMALL_PX + 6 }])) return;
  ctx.globalAlpha = 1;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = LABEL_COLORS.topic;
  ctx.fillText(text, c.x, y);
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/** A chip over each continent, like the vault chips of the other views. */
function drawContinentLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${SMALL_PX}px ${f.fonts.mono}`;
  const counts = new Map<string, number>();
  for (const n of f.model.nodes) if (n.kind === 'note' && f.appear(n) > 0) counts.set(n.vault, (counts.get(n.vault) ?? 0) + 1);
  for (const c of f.territory!.continents) {
    const vault = f.model.vaults.find((v) => v.id === c.vault);
    const count = counts.get(c.vault) ?? 0;
    if (!vault || !count) continue;
    const p = project(c.x, c.top, 0);
    if (!p) continue;
    const text = `${vault.label.toUpperCase()} · ${count}`;
    const w = ctx.measureText(text).width;
    const x = p.x;
    const y = p.y - 18;
    if (!space.place([{ x: x - w / 2 - 10, y: y - 11, w: w + 20, h: 22 }])) continue;
    ctx.globalAlpha = 0.92 * f.landAlpha;
    ctx.fillStyle = 'rgba(12,12,15,0.8)';
    ctx.beginPath();
    roundRect(ctx, x - w / 2 - 10, y - 11, w + 20, 22, 11);
    ctx.fill();
    ctx.strokeStyle = vault.color.hue;
    ctx.globalAlpha = 0.45 * f.landAlpha;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = f.landAlpha;
    ctx.fillStyle = vault.color.core;
    ctx.fillText(text, x, y + 0.5);
  }
  ctx.globalAlpha = 1;
}

/**
 * Country names, as on a map: spaced capitals, as big as the country allows,
 * until you are close enough to read the cities themselves. Then only the
 * country under the pointer keeps its name. A name is shown whole or not at
 * all: one faded to a ghost would be text nobody can read, over cities that
 * could have been named. Returns where the name of the country under the
 * pointer went, if it found room.
 */
function drawCountryLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace): Rect | null {
  const k = pixelsPerUnit(f.cam, f.vp);
  const all = k < COUNTRY_NAMES_UNTIL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const list = [...f.territory!.countries].filter((c) => !f.landed || f.landed.has(c.id)).sort((a, b) => b.count - a.count);
  let hotName: Rect | null = null;
  for (const c of list) {
    const hot = f.hotCountry === c.id;
    if (!all && !hot) continue;
    const p = project(c.x, c.y, 0);
    if (!p || p.x < -200 || p.x > f.vp.width + 200 || p.y < -40 || p.y > f.vp.height + 40) continue;
    const text = c.label.toUpperCase();
    // Within the country's own width, so a neighbour's name still fits beside it.
    const fitting = (1.75 * (c.r + 0.5 * MAP_SPACING) * k) / (text.length * 0.78);
    const size = Math.round(Math.max(SMALL_PX, Math.min(24, fitting, (7 + Math.sqrt(c.count) * 1.7) * clamp(k, 0.75, 1.5))));
    const spacing = size * 0.16;
    const font = `600 ${size}px ${f.fonts.sans}`;
    ctx.font = font;
    setSpacing(ctx, spacing);
    const w = ctx.measureText(text).width;
    const rect = space.place([{ x: p.x - w / 2 - 2, y: p.y - size / 2 - 2, w: w + 4, h: size + 4 }]);
    if (!rect) {
      setSpacing(ctx, 0);
      continue;
    }
    if (hot) hotName = rect;
    const vault = f.model.vaults.find((v) => v.id === c.vault);
    ctx.globalAlpha = (hot ? 1 : 0.9) * f.landAlpha;
    ctx.strokeStyle = 'rgba(10,10,10,0.75)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, p.x + spacing / 2, p.y);
    ctx.fillStyle = vault?.color.core ?? LABEL_COLORS.note;
    ctx.fillText(text, p.x + spacing / 2, p.y);
    setSpacing(ctx, 0);
  }
  ctx.globalAlpha = 1;
  return hotName;
}

/** Without WebGL: straight edges and flat dots, enough to use the flat views. */
function drawFallback(ctx: CanvasRenderingContext2D, f: OverlayFrame) {
  ctx.lineWidth = 1;
  // The map shows links only as routes of what the pointer is on.
  for (const e of f.landAlpha > 0.5 ? [] : f.model.edges) {
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
  } else if (f.countryRoutes && f.hotCountry) {
    // A country under the pointer: its routes, the signal travelling outwards.
    for (const e of f.countryRoutes.slice(0, 240)) {
      const c = curveOf(e, project);
      if (c) lit.push({ e, c, fromSource: e.source.project?.id === f.hotCountry, level: 1 });
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

/** How many matches get rings, pings and anchors: past this, they only glow. */
const MARKED_MATCHES = 150;
const PING_MS = 1300;

/**
 * What makes a search's matches findable: in the brain, a dotted anchor from
 * each lifted note back to where it lives; sonar pings when the matches
 * change; then a quiet ring in the vault's colour that stays while they do.
 */
function drawSearch(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>) {
  if (!f.matches?.length) return;
  const marked = f.matches.slice(0, MARKED_MATCHES);
  ctx.lineCap = 'round';
  if (f.is3D) {
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    for (const n of marked) {
      if (!n.onScreen || n.lift < 0.05 || f.appear(n) < 0.5) continue;
      const home = project(n.x, n.y, n.z || 0);
      if (!home) continue;
      const color = colorOf(f.model, n);
      ctx.globalAlpha = 0.5 * Math.min(1, n.lift);
      ctx.strokeStyle = color.hue;
      ctx.beginPath();
      ctx.moveTo(home.x, home.y);
      ctx.lineTo(n.sx, n.sy);
      ctx.stroke();
      ctx.globalAlpha = 0.7 * Math.min(1, n.lift);
      ctx.fillStyle = color.hue;
      ctx.beginPath();
      ctx.arc(home.x, home.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);
  }
  marked.forEach((n, i) => {
    if (!n.onScreen || f.appear(n) < 0.5) return;
    const hue = colorOf(f.model, n).hue;
    const r = screenRadius(n) * (n.isIndex ? 1.3 : 1);
    ctx.strokeStyle = hue;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    if (f.reduceMotion) return;
    // Two pings, the best matches first.
    const t = (f.now - f.searchT0 - Math.min(i, 24) * 35) / PING_MS;
    for (const k of [0, 0.32]) {
      const u = t - k;
      if (u < 0 || u > 1) continue;
      const eased = 1 - (1 - u) ** 3;
      ctx.globalAlpha = 0.85 * (1 - u) ** 1.5;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r + 4 + eased * 36, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
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

/** How many of the focused note's neighbours, and of a search's matches, are named. */
const NAMED_NEIGHBOURS = 28;
const NAMED_MATCHES = 40;

/**
 * The notes whose names matter most, in the order they get room. Level 2: the
 * selected note, the one pointed at and where a path starts — never dropped —
 * then the notes on the path. Level 1: the neighbours of the focus, biggest
 * first, and then what a search found, best first.
 */
function keyNotes(f: OverlayFrame): { n: GraphNode; level: 1 | 2; force: boolean }[] {
  const out: { n: GraphNode; level: 1 | 2; force: boolean }[] = [];
  const seen = new Set<GraphNode>();
  const add = (n: GraphNode | null, level: 1 | 2, force: boolean) => {
    if (!n || seen.has(n) || f.appear(n) <= 0.5) return;
    seen.add(n);
    out.push({ n, level, force });
  };
  add(f.selected, 2, true);
  add(f.focus, 2, true);
  add(f.pathFrom, 2, true);
  for (const n of f.path?.nodes ?? []) add(n, 2, false);
  if (f.hops) {
    const near: GraphNode[] = [];
    for (const [n, h] of f.hops) if (h === 1) near.push(n);
    near.sort((a, b) => b.size - a.size);
    for (const n of shownFirst(near.slice(0, NAMED_NEIGHBOURS), (x) => x.id, f.labels)) add(n, 1, false);
  }
  for (const n of f.matches?.slice(0, NAMED_MATCHES) ?? []) add(n, 1, false);
  return out;
}

/**
 * A note's name, under it if there is room; a name that matters (level 1 or 2)
 * may go above or to either side instead. Dropped when it finds no room,
 * unless `force`: then it is drawn under the note whatever it covers.
 * Returns the room it took, or null when it was dropped.
 */
function noteLabel(ctx: CanvasRenderingContext2D, f: OverlayFrame, space: LabelSpace, n: GraphNode, level: 0 | 1 | 2, force = false): Rect | null {
  // A note off the stage has no name on it: its label would point at nothing.
  if (!n.onScreen || n.sx < 0 || n.sx > f.vp.width || n.sy < 0 || n.sy > f.vp.height) return null;
  const px = f.labelPx;
  const { sans } = f.fonts;
  const font = level === 2 ? `600 ${px + 1.5}px ${sans}` : n.isIndex || n.size >= 5 ? `600 ${px + 0.5}px ${sans}` : `500 ${px}px ${sans}`;
  const text = truncate(n.label, 34);
  const w = measure(ctx, text, font) + 6;
  const h = px + 5;
  const r = screenRadius(n) * (n.isIndex ? 1.25 : 1);
  const below = { x: n.sx - w / 2, y: n.sy + r + 3, w, h };
  const slots =
    level === 0
      ? [below]
      : [below, { ...below, y: n.sy - r - 3 - h }, { x: n.sx + r + 4, y: n.sy - h / 2, w, h }, { x: n.sx - r - 4 - w, y: n.sy - h / 2, w, h }];
  let rect = space.place(slots);
  if (!rect && force) {
    rect = below;
    space.take(rect);
  }
  if (!rect) return null;
  f.labels.shown(n.id);
  const x = rect.x + rect.w / 2;
  const y = rect.y + 2;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = level ? 1 : 0.88;
  ctx.strokeStyle = 'rgba(10,10,10,0.92)';
  ctx.lineWidth = 4;
  ctx.strokeText(text, x, y);
  ctx.fillStyle =
    level === 2 ? LABEL_COLORS.strong : level === 1 ? LABEL_COLORS.neighbour : n.kind === 'topic' ? LABEL_COLORS.topic : n.isIndex ? LABEL_COLORS.index : LABEL_COLORS.note;
  ctx.fillText(text, x, y);
  return rect;
}

/**
 * Every other note there is room for, the most connected first and those
 * named last frame before the rest. Not while a search or a path is on
 * screen, nor once the clouds name the projects; with a note in focus, half
 * as many, so its neighbours still stand out.
 */
function drawRestLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, space: LabelSpace, named: ReadonlySet<GraphNode>) {
  if (f.matched || f.path || f.cloud >= 0.65) return;
  const k = pixelsPerUnit(f.cam, f.vp);
  // On the map the country names speak first, and are placed first, so no
  // city covers one; the cities get theirs once you are close enough, and
  // further out only in a country that fills much of the stage.
  const onMap = f.landAlpha > 0.5;
  const only = onMap && k < CITY_NAMES_FROM ? bigCountries(f, k) : null;
  if (only && !only.size) return;
  const minSize = f.is3D ? (k >= 1.8 ? 0 : k >= 1.1 ? 2 : k >= 0.6 ? 4 : 8) : k >= 1 ? 0 : k >= 0.7 ? 1.2 : k >= 0.45 ? 3 : 7;
  const cap = Math.round((f.vp.width * f.vp.height) / (f.is3D ? 10000 : 5200) / (f.focus ? 2 : 1));
  const candidates: GraphNode[] = [];
  for (const n of f.model.labelOrder) {
    if (named.has(n) || f.appear(n) < 0.9 || !n.onScreen) continue;
    if (only && !(n.project && only.has(n.project.id))) continue;
    if (!onMap && n.size < minSize) continue;
    if (f.is3D && n.sFade < MIN_LABEL_FADE) continue;
    if (n.sx < 0 || n.sx > f.vp.width || n.sy < 0 || n.sy > f.vp.height) continue;
    candidates.push(n);
  }
  for (const n of shownFirst(candidates, (x) => x.id, f.labels)) {
    if (space.count > cap) break;
    noteLabel(ctx, f, space, n, 0);
  }
}

/** The countries with land so far whose radius on screen, at `k`, makes them big (BIG_COUNTRY). */
function bigCountries(f: OverlayFrame, k: number): Set<string> {
  const out = new Set<string>();
  const min = BIG_COUNTRY * Math.min(f.vp.width, f.vp.height);
  for (const c of f.territory?.countries ?? []) if (c.r * k >= min && (!f.landed || f.landed.has(c.id))) out.add(c.id);
  return out;
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

/** Project names over their notes, once zoomed out far enough for the clouds; drawn at full strength. */
function drawProjectLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace) {
  const font = `600 14px ${f.fonts.sans}`;
  const small = `500 ${SMALL_PX}px ${f.fonts.mono}`;
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
    const count = `${c.count} notes`;
    const w = Math.max(measure(ctx, text, font), measure(ctx, count, small));
    if (!space.place([{ x: c.x - w / 2 - 4, y: c.y - 11, w: w + 8, h: 32 }])) continue;
    ctx.globalAlpha = 1;
    ctx.font = font;
    ctx.strokeStyle = 'rgba(10,10,10,0.85)';
    ctx.lineWidth = 4;
    ctx.strokeText(text, c.x, c.y);
    ctx.fillStyle = colorOf(f.model, { kind: 'note', vault: p.vault }).core;
    ctx.fillText(text, c.x, c.y);
    ctx.font = small;
    ctx.strokeText(count, c.x, c.y + 16);
    ctx.fillStyle = LABEL_COLORS.topic;
    ctx.fillText(count, c.x, c.y + 16);
  }
  ctx.globalAlpha = 1;
}

/**
 * While searching: a chip over each project with matches, saying how many,
 * so the zone reads before the notes do. Placed over the whole project,
 * where it lives, not over the matches that sprang out of it.
 */
function drawMatchZones(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace) {
  const counts = new Map<string, number>();
  for (const n of f.matches ?? []) if (n.project) counts.set(n.project.id, (counts.get(n.project.id) ?? 0) + 1);
  if (!counts.size) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${SMALL_PX}px ${f.fonts.mono}`;
  const zones = f.model.projects.filter((p) => counts.has(p.id)).sort((a, b) => counts.get(b.id)! - counts.get(a.id)!);
  for (const p of zones.slice(0, 12)) {
    const c = centroid(p.nodes, f, project);
    if (!c) continue;
    const vault = f.model.vaults.find((v) => v.id === p.vault);
    const text = `${truncate(p.label, 24).toUpperCase()} · ${counts.get(p.id)}`;
    const w = measure(ctx, text, ctx.font);
    const x = clamp(c.x, w / 2 + 16, f.vp.width - w / 2 - 16);
    const y = clamp(f.is3D ? c.y - 30 : c.top - 26, CHIP_TOP, f.vp.height - 16);
    const rect = space.place([{ x: x - w / 2 - 10, y: y - 11, w: w + 20, h: 22 }]);
    if (!rect) continue;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(12,12,15,0.85)';
    ctx.beginPath();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 11);
    ctx.fill();
    ctx.strokeStyle = vault?.color.hue ?? '#fff';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = vault?.color.core ?? LABEL_COLORS.strong;
    ctx.fillText(text, x, y + 0.5);
  }
}

function drawVaultLabels(ctx: CanvasRenderingContext2D, f: OverlayFrame, project: ReturnType<typeof projector>, space: LabelSpace) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${SMALL_PX}px ${f.fonts.mono}`;
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
    const y = clamp(f.is3D ? c.y - 40 : c.top - 26, CHIP_TOP, f.vp.height - 16);
    if (!space.place([{ x: x - w / 2 - 10, y: y - 11, w: w + 20, h: 22 }])) continue;
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
