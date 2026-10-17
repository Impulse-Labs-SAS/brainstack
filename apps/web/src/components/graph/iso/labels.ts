// Line art's labels: names on the 2D overlay, screen-aligned, each on an opaque tag of its own.
// A label never covers another, the chrome, or a note that matters; one with no room is dropped,
// never faded, so whatever is drawn reads at full strength. Room goes by importance, as in the
// classic graph (labels/placer.ts): the selected note, the one pointed at and the keyboard's;
// what the selected note links to and what a search found; the names of places; then any note
// there is room for, those named last frame first, so names hold their places while the camera
// moves instead of trading them with a neighbour every other frame.
//
// Mono for structure (vaults, projects, folders), sans for titles. Which notes are named at all
// goes by the zoom: the atlas names places only, the project level adds the index notes, the
// folder level every note.
//
// Pure apart from the context it draws on: no DOM, no three.

import type { Viewport } from '@/lib/graph-camera';

import { LabelSpace, shownFirst, type LabelMemory, type Rect } from '../labels/placer';
import { BLOCK, BLOCK_H } from './block';
import type { IsoLayout, IsoPlate } from './layout/territories';
import { isoProject, type IsoCam } from './math/camera';

/** Pixels per unit where the project level starts: below it, the atlas. */
export const LEVEL_PROJECT = 9;
/** Pixels per unit where the folder level starts: every note is named from here. */
export const LEVEL_FOLDER = 24;

export interface PlateMeta {
  label: string;
  /** A vault's chip: its name or owner and count, beside a swatch of its hue. */
  chip?: { text: string; swatch: string; shared: boolean };
}

export interface LabelState {
  /** Note indices, in `layout.ids`. */
  selected: number | null;
  hovered: number | null;
  /** The keyboard's. */
  cursor: number | null;
  /** The selected note's links, in the order to try them. */
  linked: readonly number[];
  /** Search matches, best first. */
  found: readonly number[];
  /** A plate index. */
  hoverPlate: number | null;
  /**
   * The plate flown to, a project or a folder, by index: its notes are named whatever the zoom,
   * so arriving at a large folder never leaves it untitled.
   */
  focus?: number | null;
}

export interface LabelColors {
  /** The tag's fill, and its edge. */
  tag: string;
  tagEdge: string;
  /** Inks: what is active, a note's title, a folder's name. */
  strong: string;
  body: string;
  quiet: string;
  /** Edges: the selected note's, the one pointed at, a shared vault's. */
  accent: string;
  hoverEdge: string;
  route: string;
}

export interface LabelFrame {
  /** The overlay; the caller has cleared it and set no transform. */
  ctx: CanvasRenderingContext2D;
  vp: Viewport;
  dpr: number;
  cam: IsoCam;
  layout: IsoLayout;
  /** Per note index. */
  titles: readonly string[];
  /** Per note index: links in and out, for who gets a label first. */
  degree: readonly number[];
  /** Per note index: an index note. */
  index: readonly boolean[];
  /** Per plate index. */
  plates: readonly PlateMeta[];
  /** How far a note's block is raised: its label goes with it. */
  lift(note: number): number;
  state: LabelState;
  chrome: readonly Rect[];
  /** 12, or 13 on a touch screen. */
  px: number;
  fonts: { sans: string; mono: string };
  memory: LabelMemory;
  colors: LabelColors;
}

/** A label drawn: where, and the note or plate it names. */
export interface LabelHit {
  rect: Rect;
  note?: number;
  plate?: number;
}

/**
 * The defaults, from the app's tokens: --fg-primary, --fg-body and --fg-secondary for the inks,
 * --accent, --graph-la-hover-edge and --graph-la-route for the edges. The tag is the label's own,
 * near-black and all but opaque, so every ink reads on it over any plate or block.
 */
export const LABEL_COLORS: Readonly<LabelColors> = {
  tag: 'rgba(9, 9, 11, 0.95)',
  tagEdge: '#30303a',
  strong: '#ededed',
  body: '#d4d4d4',
  quiet: '#a0a0a0',
  accent: '#7c5cff',
  hoverEdge: '#e2e2ea',
  route: '#85858f',
};

/** How close a label may come to the stage's edge, or to the chrome. */
const MARGIN = 4;
/** Kept clear round a block that matters, so no label touches its edge. */
const BLOCK_ROOM = 2;
/** Between a block and its name: below or above it, and beside it. */
const NOTE_GAP_Y = 4;
const NOTE_GAP_X = 5;
/** Between a plate's corner and its name: above it, and beside it. */
const PLATE_GAP_Y = 5;
const PLATE_GAP_X = 6;
/** From the tag's edge to its text. */
const INSET = 6;
/** A vault's swatch, and the room it takes before the text. */
const SWATCH = 8;
const SWATCH_ROOM = 14;
const RADIUS = 4;
const SHARED_DASH: readonly number[] = [3, 2.5];
const NO_DASH: readonly number[] = [];
/** Where a title is cut: the selected note's is read, the others only recognised. */
const TITLE_MAX = 30;
const SELECTED_MAX = 46;
const NAME_MAX = 30;
/** How many search matches, and how many other notes, a frame tries before giving up. */
const FOUND_TRIED = 250;
const REST_TRIED = 500;
/**
 * The narrowest plate on screen that is named, CSS px. A folder's name on a plate narrower
 * than it would read as its neighbour's; a project's still fits on a small one.
 */
const FOLDER_MIN_PX = 72;
const PROJECT_MIN_PX = 26;
/** Two corners this close in height (or across) are one edge, seen square-on. */
const TIE_PX = 0.5;
/** How far a name never dropped steps down from its first slot to clear another, and by what. */
const FORCED_STEPS = 8;
const FORCED_GAP = 2;

/**
 * How close the camera is: the atlas names places, the project level adds the index notes, the
 * folder level every note.
 */
export type MapLevel = 'atlas' | 'project' | 'folder';
type NoteKind = 'selected' | 'pointed' | 'linked' | 'found' | 'index' | 'rest';

interface Pt {
  x: number;
  y: number;
}

interface TagStyle {
  font: string;
  ink: string;
  edge: string;
  edgeWidth: number;
  dash: readonly number[];
  swatch: string | null;
  spacing: string | null;
}

/** The level the camera is at, by its pixels per unit. */
export function levelOf(ppu: number): MapLevel {
  return ppu < LEVEL_PROJECT ? 'atlas' : ppu < LEVEL_FOLDER ? 'project' : 'folder';
}

/**
 * Draw the labels for this frame; returns where each one is, for picking a label like what it
 * names.
 */
export function drawLabels(f: LabelFrame): LabelHit[] {
  const { ctx, vp, layout, state } = f;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  f.memory.begin();
  if (vp.width < 1 || vp.height < 1) return [];
  const pass = new Pass(f);

  // The notes that matter: their blocks reserved before any name looks for room, so none covers
  // one, then named in order. The first three are named even with no room.
  const key = keyNotes(state, layout.ids.length, (k) => pass.onStage(k));
  for (const { k } of key) pass.reserveBlock(k);
  for (const { k, kind, force } of key) pass.note(k, kind, force);

  // The names of places: the one pointed at, whatever it covers; the vaults, the projects
  // biggest first, the folders.
  if (state.hoverPlate !== null) pass.plate(state.hoverPlate, true);
  const plates = layout.plates.map((_, i) => i);
  const area = (i: number) => layout.plates[i]!.w * layout.plates[i]!.h;
  const ofKind = (kind: IsoPlate['kind']) => plates.filter((i) => layout.plates[i]!.kind === kind);
  const vaults = ofKind('vault');
  const projects = ofKind('project').sort((a, b) => area(b) - area(a) || a - b);
  const folders = ofKind('folder').sort(
    (a, b) => layout.plates[a]!.depth - layout.plates[b]!.depth || area(b) - area(a) || a - b,
  );
  for (const list of [vaults, projects, folders])
    for (const p of shownFirst(list, (i) => layout.plates[i]!.id, f.memory)) pass.plate(p, false);

  // Any note there is room for, by the level: the index notes from the project level, the rest
  // from the folder level; last frame's first, then the most linked.
  const level = levelOf(f.cam.ppu);
  const within = under(layout, f.state.focus ?? null);
  if (level === 'atlas' && !within) return pass.hits;
  const index: number[] = [];
  const rest: number[] = [];
  for (let k = 0; k < layout.ids.length; k++) {
    if (pass.named(k) || !pass.onStage(k)) continue;
    const near = within?.has(layout.plateOf[k]!) ?? false;
    if (f.index[k]) {
      if (level !== 'atlas' || near) index.push(k);
    } else if (level === 'folder' || near) rest.push(k);
  }
  const byDegree = (a: number, b: number) => (f.degree[b] ?? 0) - (f.degree[a] ?? 0) || a - b;
  const keyOf = (k: number) => noteKey(layout, k);
  for (const k of shownFirst(index.sort(byDegree), keyOf, f.memory)) pass.note(k, 'index', false);
  let tries = 0;
  for (const k of shownFirst(rest.sort(byDegree), keyOf, f.memory)) {
    if (++tries > REST_TRIED) break;
    pass.note(k, 'rest', false);
  }
  return pass.hits;
}

/** A plate and every plate on it, by index; null for none. */
function under(layout: IsoLayout, plate: number | null): Set<number> | null {
  if (plate === null || !layout.plates[plate]) return null;
  const set = new Set([plate]);
  // Parents come before their children in the layout.
  layout.plates.forEach((p, i) => {
    if (set.has(p.parent)) set.add(i);
  });
  return set;
}

/**
 * The notes named first, in the order they get room; the first three are never dropped. The
 * search matches are capped by those on the stage: a broad search ranks the whole map, and its
 * best matches may all lie elsewhere while the ones in view come later.
 */
function keyNotes(
  state: LabelState,
  count: number,
  onStage: (k: number) => boolean,
): { k: number; kind: NoteKind; force: boolean }[] {
  const out: { k: number; kind: NoteKind; force: boolean }[] = [];
  const seen = new Set<number>();
  const add = (k: number | null, kind: NoteKind, force: boolean): boolean => {
    if (k === null || !(k >= 0 && k < count) || seen.has(k)) return false;
    seen.add(k);
    out.push({ k, kind, force });
    return true;
  };
  add(state.selected, 'selected', true);
  add(state.hovered, 'pointed', true);
  add(state.cursor, 'pointed', true);
  for (const k of state.linked) add(k, 'linked', false);
  let tried = 0;
  for (const k of state.found) {
    if (tried >= FOUND_TRIED) break;
    if (k >= 0 && k < count && onStage(k) && add(k, 'found', false)) tried++;
  }
  return out;
}

/** What LabelMemory knows a note by: never the same as a plate's id, which has a kind prefix. */
const noteKey = (layout: IsoLayout, k: number) => `n:${layout.ids[k]}`;

/** One frame's placing and drawing. */
class Pass {
  readonly hits: LabelHit[] = [];
  private readonly space: LabelSpace;
  private readonly project: ReturnType<typeof isoProject>;
  private readonly level: MapLevel;
  private readonly spacing: boolean;
  private readonly boxes = new Map<number, Rect>();
  private readonly notes = new Set<number>();
  private readonly places = new Set<number>();
  private readonly probes = new Map<string, number>();

  constructor(private readonly f: LabelFrame) {
    const { vp, ctx } = f;
    this.space = new LabelSpace({
      x: MARGIN,
      y: MARGIN,
      w: vp.width - 2 * MARGIN,
      h: vp.height - 2 * MARGIN,
    });
    for (const r of f.chrome) this.space.reserve(grow(r, MARGIN));
    this.project = isoProject(f.cam, vp);
    this.level = levelOf(f.cam.ppu);
    this.spacing = 'letterSpacing' in ctx;
    this.setSpacing(null);
  }

  named(k: number): boolean {
    return this.notes.has(k);
  }

  /** Whether a note's block stands on the stage: a name for one off it would point at nothing. */
  onStage(k: number): boolean {
    const { cells } = this.f.layout;
    const z = cells[k * 3 + 2]! + this.f.lift(k) + BLOCK_H / 2;
    const c = this.project(cells[k * 3]!, cells[k * 3 + 1]!, z);
    return c.x >= 0 && c.y >= 0 && c.x <= this.f.vp.width && c.y <= this.f.vp.height;
  }

  reserveBlock(k: number): void {
    if (this.onStage(k)) this.space.reserve(grow(this.box(k), BLOCK_ROOM));
  }

  /**
   * A note's name below its block, else above; one that matters may go to either side instead.
   * A lesser name beside its block would read as its neighbour's.
   */
  note(k: number, kind: NoteKind, force: boolean): void {
    if (this.notes.has(k) || !this.onStage(k)) return;
    const title = this.f.titles[k] ?? '';
    if (!title) return;
    const { px, fonts, colors } = this.f;
    const selected = kind === 'selected';
    const font = selected ? `600 ${px + 1}px ${fonts.sans}` : `500 ${px}px ${fonts.sans}`;
    const text = cut(title, selected ? SELECTED_MAX : TITLE_MAX);
    const w = Math.ceil(this.width(text, font, null)) + 2 * INSET;
    const h = px + (selected ? 11 : 9);
    const b = this.box(k);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const below = slot(cx - w / 2, b.y + b.h + NOTE_GAP_Y, w, h);
    const above = slot(cx - w / 2, b.y - NOTE_GAP_Y - h, w, h);
    const slots =
      kind === 'index' || kind === 'rest'
        ? [below, above]
        : [
            below,
            above,
            slot(b.x + b.w + NOTE_GAP_X, cy - h / 2, w, h),
            slot(b.x - NOTE_GAP_X - w, cy - h / 2, w, h),
          ];
    const rect = this.claim(slots, force);
    if (!rect) return;
    this.notes.add(k);
    this.f.memory.shown(noteKey(this.f.layout, k));
    const pointed = kind === 'pointed';
    this.tag(rect, text, {
      font,
      ink: selected || pointed ? colors.strong : colors.body,
      edge: selected ? colors.accent : pointed ? colors.hoverEdge : colors.tagEdge,
      edgeWidth: selected ? 1.5 : 1,
      dash: NO_DASH,
      swatch: null,
      spacing: null,
    });
    this.hits.push({ rect, note: k });
  }

  /**
   * A place's name above its top face's top corner, else beside its left or right corner, else
   * in the middle of the face. A project's in the atlas goes in the middle first: the atlas is
   * read by its projects, and there a name over the plate says which one it is.
   */
  plate(p: number, force: boolean): void {
    const plate = this.f.layout.plates[p];
    const meta = this.f.plates[p];
    if (!plate || !meta || this.places.has(p)) return;
    const { top, bounds } = this.shape(plate);
    const { width, height } = this.f.vp;
    const inView =
      bounds.x < width && bounds.y < height && bounds.x + bounds.w > 0 && bounds.y + bounds.h > 0;
    if (!inView) return;
    if (!force && plate.kind === 'folder' && bounds.w < FOLDER_MIN_PX) return;
    if (!force && plate.kind === 'project' && bounds.w < PROJECT_MIN_PX) return;
    const { text, style } = this.plateTag(plate, meta, p === this.f.state.hoverPlate);
    const w =
      Math.ceil(this.width(text, style.font, style.spacing)) +
      2 * INSET +
      (style.swatch ? SWATCH_ROOM : 0);
    const h = this.f.px + 9;
    const up = extreme(top, (q) => -q.y);
    const left = extreme(top, (q) => -q.x);
    const right = extreme(top, (q) => q.x);
    const mid = {
      x: top.reduce((s, q) => s + q.x, 0) / top.length,
      y: top.reduce((s, q) => s + q.y, 0) / top.length,
    };
    const above = slot(up.x - w / 2, up.y - PLATE_GAP_Y - h, w, h);
    const beforeIt = slot(left.x - PLATE_GAP_X - w, left.y - h / 2, w, h);
    const afterIt = slot(right.x + PLATE_GAP_X, right.y - h / 2, w, h);
    const middle = slot(mid.x - w / 2, mid.y - h / 2, w, h);
    const slots =
      plate.kind === 'project' && this.level === 'atlas'
        ? [middle, above, beforeIt, afterIt]
        : [above, beforeIt, afterIt, middle];
    const rect = this.claim(slots, force);
    if (!rect) return;
    this.places.add(p);
    this.f.memory.shown(plate.id);
    this.tag(rect, text, style);
    this.hits.push({ rect, plate: p });
  }

  private plateTag(
    plate: IsoPlate,
    meta: PlateMeta,
    hovered: boolean,
  ): { text: string; style: TagStyle } {
    const { px, fonts, colors } = this.f;
    const base = {
      edge: hovered ? colors.hoverEdge : colors.tagEdge,
      edgeWidth: 1,
      dash: NO_DASH,
      swatch: null,
      spacing: null,
    };
    if (plate.kind === 'vault') {
      const chip = meta.chip;
      return {
        text: chip?.text ?? cut(meta.label, NAME_MAX),
        style: {
          ...base,
          font: `500 ${px}px ${fonts.mono}`,
          ink: colors.strong,
          // A shared vault's chip is rimmed as its plate is: dashed.
          edge: hovered ? colors.hoverEdge : chip?.shared ? colors.route : colors.tagEdge,
          dash: chip?.shared ? SHARED_DASH : NO_DASH,
          swatch: chip?.swatch ?? null,
        },
      };
    }
    if (plate.kind === 'project') {
      return {
        text: cut(meta.label, NAME_MAX).toUpperCase(),
        style: {
          ...base,
          font: `600 ${px}px ${fonts.mono}`,
          ink: colors.strong,
          spacing: '0.06em',
        },
      };
    }
    return {
      text: cut(meta.label, NAME_MAX),
      style: { ...base, font: `500 ${px}px ${fonts.mono}`, ink: colors.quiet },
    };
  }

  /**
   * The first slot with room, taken. With none, a name never dropped takes the first slot no
   * other name lies in, whatever chrome or block it covers, for two tags over each other read as
   * neither; failing that, the first slot stepped down until it is clear, or the first anyway.
   */
  private claim(slots: readonly Rect[], force: boolean): Rect | null {
    const rect = this.space.place(slots);
    if (rect || !force) return rect;
    const clear = (r: Rect) => this.hits.every((h) => !overlaps(r, h.rect));
    const first = slots[0]!;
    let pick = slots.find(clear);
    for (let step = 1; !pick && step <= FORCED_STEPS; step++) {
      const r = { ...first, y: first.y + step * (first.h + FORCED_GAP) };
      if (clear(r)) pick = r;
    }
    pick ??= first;
    this.space.take(pick);
    return pick;
  }

  /** A note's block on screen: the box round its eight corners, raised by its lift. */
  private box(k: number): Rect {
    let r = this.boxes.get(k);
    if (r) return r;
    const { cells } = this.f.layout;
    const x = cells[k * 3]!;
    const y = cells[k * 3 + 1]!;
    const z = cells[k * 3 + 2]! + this.f.lift(k);
    const half = BLOCK / 2;
    const corners: Pt[] = [];
    for (const cx of [x - half, x + half])
      for (const cy of [y - half, y + half])
        for (const cz of [z, z + BLOCK_H]) corners.push(this.project(cx, cy, cz));
    r = boundsOf(corners);
    this.boxes.set(k, r);
    return r;
  }

  /** A plate on screen: its top face's corners, and the box round all eight. */
  private shape(plate: IsoPlate): { top: Pt[]; bounds: Rect } {
    const { x, y, w, h, z0, z1 } = plate;
    const ring = (z: number) =>
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ].map(([px, py]) => this.project(px!, py!, z));
    const top = ring(z1);
    return { top, bounds: boundsOf(top.concat(ring(z0))) };
  }

  private tag(r: Rect, text: string, s: TagStyle): void {
    const { ctx, colors } = this.f;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    roundRect(ctx, r.x, r.y, r.w, r.h, RADIUS);
    ctx.fillStyle = colors.tag;
    ctx.fill();
    // The edge inside the tag, so a wider one does not reach past the room it was given.
    const inset = s.edgeWidth / 2;
    ctx.beginPath();
    roundRect(ctx, r.x + inset, r.y + inset, r.w - 2 * inset, r.h - 2 * inset, RADIUS - inset);
    ctx.strokeStyle = s.edge;
    ctx.lineWidth = s.edgeWidth;
    ctx.setLineDash([...s.dash]);
    ctx.stroke();
    ctx.setLineDash([]);
    let x = r.x + INSET;
    if (s.swatch) {
      ctx.fillStyle = s.swatch;
      ctx.fillRect(r.x + INSET + 1, r.y + r.h / 2 - SWATCH / 2, SWATCH, SWATCH);
      x += SWATCH_ROOM;
    }
    ctx.font = s.font;
    this.setSpacing(s.spacing);
    ctx.fillStyle = s.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, r.y + r.h / 2 + 0.5);
    if (s.spacing) this.setSpacing(null);
  }

  private width(text: string, font: string, spacing: string | null): number {
    const { ctx } = this.f;
    let probe = this.probes.get(font);
    if (probe === undefined) {
      ctx.font = font;
      probe = ctx.measureText(PROBE).width;
      this.probes.set(font, probe);
    }
    const key = `${font}|${spacing ?? ''}|${probe}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (widths.size >= WIDTHS_KEPT) widths.clear();
      ctx.font = font;
      this.setSpacing(spacing);
      w = ctx.measureText(text).width;
      if (spacing) this.setSpacing(null);
      widths.set(key, w);
    }
    return w;
  }

  /** Letter spacing where the context has it; where it has not, text is measured without it too. */
  private setSpacing(spacing: string | null): void {
    if (this.spacing) this.f.ctx.letterSpacing = spacing ?? '0px';
  }
}

/**
 * Text widths, by font, spacing and text: a frame measures hundreds. A key also holds a probe's
 * width in that font, so when a web font comes in the probe measures otherwise and every width
 * taken with the fallback is measured again, with nobody having to say so.
 */
const widths = new Map<string, number>();
const WIDTHS_KEPT = 20_000;
const PROBE = 'Hamburgefontsiv 0123';

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never between the halves of a surrogate pair: half an emoji is drawn as a box.
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** In whole pixels, so a tag's 1 px edge lands on the pixel grid. */
function slot(x: number, y: number, w: number, h: number): Rect {
  return { x: Math.round(x), y: Math.round(y), w, h };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

function boundsOf(pts: readonly Pt[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The corner furthest along `score`; when two tie, the middle of the edge between them. Seen
 * square-on, as in plan, a plate has a top edge rather than a top corner, and a name centred on
 * one of its ends would hang off the plate.
 */
function extreme(pts: readonly Pt[], score: (p: Pt) => number): Pt {
  let best = -Infinity;
  for (const p of pts) best = Math.max(best, score(p));
  let x = 0;
  let y = 0;
  let n = 0;
  for (const p of pts) {
    if (score(p) < best - TIE_PX) continue;
    x += p.x;
    y += p.y;
    n++;
  }
  return { x: x / n, y: y / n };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
