// Line art's labels in Node: an invented map laid out for real, drawn on a context that records
// what it is asked to draw and measures text by its length.

import { describe, expect, it } from 'vitest';

import type { Viewport } from '@/lib/graph-camera';
import { AA_TEXT, contrast, over, parseColor } from '@/lib/contrast';

import { LabelMemory, type Rect } from '../labels/placer';
import {
  LABEL_COLORS,
  LEVEL_FOLDER,
  LEVEL_PROJECT,
  drawLabels,
  levelOf,
  type LabelFrame,
  type LabelHit,
  type LabelState,
  type PlateMeta,
} from './labels';
import { rootTokens } from '@/lib/root-tokens';

import { BLOCK, BLOCK_H } from './block';
import { layoutIso, type IsoLayout, type LayoutNote, type LayoutVault } from './layout/territories';
import { ISO_EL, PLAN_EL, isoProject, snapAz, targetFor, type IsoCam } from './math/camera';

const FONTS = { sans: 'Sans', mono: 'Mono' };
const VP: Viewport = { width: 1200, height: 800 };
const MARGIN = 4;

// -- A context that records ---------------------------------------------------------------

interface Text {
  text: string;
  x: number;
  y: number;
  font: string;
  ink: string;
  spacing: string | undefined;
}
interface Fill {
  rect: Rect;
  fill: string;
}
interface Stroke {
  rect: Rect;
  stroke: string;
  width: number;
  dash: number[];
}

const pxOf = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? NaN);

class FakeContext {
  font = '10px sans-serif';
  fillStyle: string = '#000';
  strokeStyle: string = '#000';
  lineWidth = 1;
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  letterSpacing = '0px';
  transform: number[] = [1, 0, 0, 1, 0, 0];
  readonly texts: Text[] = [];
  readonly fills: Fill[] = [];
  readonly strokes: Stroke[] = [];
  readonly squares: Fill[] = [];
  private path: Rect[] = [];
  private dash: number[] = [];

  /** How wide a character is, per pixel of font size: a web font coming in changes it. */
  constructor(
    spacing = true,
    private readonly scale = 0.55,
  ) {
    if (!spacing) delete (this as { letterSpacing?: string }).letterSpacing;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.transform = [a, b, c, d, e, f];
  }
  beginPath() {
    this.path = [];
  }
  roundRect(x: number, y: number, w: number, h: number) {
    this.path.push({ x, y, w, h });
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push({ x, y, w, h });
  }
  fill() {
    for (const rect of this.path) this.fills.push({ rect, fill: this.fillStyle });
  }
  stroke() {
    for (const rect of this.path)
      this.strokes.push({ rect, stroke: this.strokeStyle, width: this.lineWidth, dash: this.dash });
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.squares.push({ rect: { x, y, w, h }, fill: this.fillStyle });
  }
  setLineDash(dash: number[]) {
    this.dash = [...dash];
  }
  /** Proportional to the text's length and the font's size: what the placing needs. */
  measureText(text: string) {
    return { width: text.length * pxOf(this.font) * this.scale };
  }
  fillText(text: string, x: number, y: number) {
    const spacing = (this as { letterSpacing?: string }).letterSpacing;
    this.texts.push({ text, x, y, font: this.font, ink: this.fillStyle, spacing });
  }
  /** The tags drawn, in order: every rectangle filled with the tag's colour. */
  tags(): Rect[] {
    return this.fills.filter((f) => f.fill === LABEL_COLORS.tag).map((f) => f.rect);
  }
}

// -- An invented map ----------------------------------------------------------------------

const VAULTS: LayoutVault[] = [
  { id: 'own', label: 'Orbit', shared: false },
  { id: 'sam', label: 'Gondor', shared: true },
];
const SWATCHES: Record<string, string> = { own: '#5b8def', sam: '#e0a458' };

function note(vault: string, path: string, createdAt: number): LayoutNote {
  const project = path.split('/')[0]!;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    id: `${vault}/${path}`,
    path,
    project: `${vault}|${project}`,
    projectLabel: project,
    vault,
    isIndex: name.startsWith('_'),
    createdAt,
  };
}
const many = (vault: string, folder: string, n: number) =>
  Array.from({ length: n }, (_, i) => note(vault, `${folder}/note ${i}.md`, 2_000 + i));

const ATLAS: LayoutNote[] = [
  note('own', 'Atlas/_Atlas.md', 10),
  ...many('own', 'Atlas', 6),
  ...many('own', 'Atlas/maps', 30),
  ...many('own', 'Atlas/charts', 20),
];
const WORLD: LayoutNote[] = [
  ...ATLAS,
  note('own', 'Ledger/_Ledger.md', 10),
  ...many('own', 'Ledger/q1', 12),
  ...many('own', 'Ledger/q2', 9),
  ...many('own', 'Erebor', 40),
  note('sam', 'Rohan/_Rohan.md', 10),
  ...many('sam', 'Rohan/Edoras', 25),
  ...many('sam', 'Rohan/Edoras/Meduseld', 8),
];

interface Scene {
  layout: IsoLayout;
  titles: string[];
  degree: number[];
  index: boolean[];
  plates: PlateMeta[];
}

function scene(notes: readonly LayoutNote[]): Scene {
  const layout = layoutIso(notes, VAULTS);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const titles = layout.ids.map((id) => {
    const n = byId.get(id)!;
    const name = n.path.slice(n.path.lastIndexOf('/') + 1, -3);
    // Every seventh a title too long to show whole, to be cut.
    return name.endsWith(' 3')
      ? `A rather long title about ${n.path} that keeps on going`
      : `${name} of ${n.projectLabel}`;
  });
  return {
    layout,
    titles,
    degree: layout.ids.map((_, k) => (k * 7919) % 13),
    index: layout.ids.map((id) => byId.get(id)!.isIndex),
    plates: layout.plates.map((p) =>
      p.kind === 'vault'
        ? {
            label: p.label,
            chip: {
              text: p.shared ? `@sam · ${p.count}` : `${p.label} · ${p.count}`,
              swatch: SWATCHES[p.vault]!,
              shared: p.shared,
            },
          }
        : { label: p.label },
    ),
  };
}

const EMPTY: LabelState = {
  selected: null,
  hovered: null,
  cursor: null,
  linked: [],
  found: [],
  hoverPlate: null,
};

interface Options {
  vp?: Viewport;
  chrome?: Rect[];
  state?: Partial<LabelState>;
  memory?: LabelMemory;
  lift?: (k: number) => number;
  degree?: number[];
  dpr?: number;
}

function frameOf(s: Scene, ctx: FakeContext, cam: IsoCam, o: Options = {}): LabelFrame {
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    vp: o.vp ?? VP,
    dpr: o.dpr ?? 1,
    cam,
    layout: s.layout,
    titles: s.titles,
    degree: o.degree ?? s.degree,
    index: s.index,
    plates: s.plates,
    lift: o.lift ?? (() => 0),
    state: { ...EMPTY, ...o.state },
    chrome: o.chrome ?? [],
    px: 12,
    fonts: FONTS,
    memory: o.memory ?? new LabelMemory(),
    colors: LABEL_COLORS,
  };
}

/** A camera at this zoom and turn, with `at` in the middle of the stage. */
function camOn(
  at: { x: number; y: number; z: number },
  ppu: number,
  turn = 0,
  plan = false,
  vp = VP,
): IsoCam {
  const cam = { tx: 0, ty: 0, tz: 0.6, az: snapAz(turn, plan), el: plan ? PLAN_EL : ISO_EL, ppu };
  return { ...cam, ...targetFor(cam, vp, at, { x: vp.width / 2, y: vp.height / 2 }) };
}

const cellOf = (s: Scene, k: number) => ({
  x: s.layout.cells[k * 3]!,
  y: s.layout.cells[k * 3 + 1]!,
  z: s.layout.cells[k * 3 + 2]!,
});
const plateAt = (s: Scene, id: string) => s.layout.plates.findIndex((p) => p.id === id);
const plateCentre = (s: Scene, p: number) => {
  const pl = s.layout.plates[p]!;
  return { x: pl.x + pl.w / 2, y: pl.y + pl.h / 2, z: pl.z1 };
};
const noteAt = (s: Scene, id: string) => {
  const k = s.layout.ids.indexOf(id);
  if (k < 0) throw new Error(`no note ${id}`);
  return k;
};

function boundsOf(pts: readonly { x: number; y: number }[]): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A block's box on screen, from its eight corners. */
function blockBox(s: Scene, cam: IsoCam, k: number, lift = 0, vp = VP): Rect {
  const P = isoProject(cam, vp);
  const c = cellOf(s, k);
  const pts = [];
  for (const dx of [-BLOCK / 2, BLOCK / 2])
    for (const dy of [-BLOCK / 2, BLOCK / 2])
      for (const z of [c.z + lift, c.z + lift + BLOCK_H]) pts.push(P(c.x + dx, c.y + dy, z));
  return boundsOf(pts);
}

/** A plate's top face on screen. */
function topFace(s: Scene, cam: IsoCam, p: number, vp = VP) {
  const P = isoProject(cam, vp);
  const { x, y, w, h, z1, z0 } = s.layout.plates[p]!;
  const ring = (z: number) =>
    [P(x, y, z), P(x + w, y, z), P(x + w, y + h, z), P(x, y + h, z)].map((q) => ({
      x: q.x,
      y: q.y,
    }));
  return { top: ring(z1), bounds: boundsOf([...ring(z1), ...ring(z0)]) };
}

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
});
const inside = (p: { x: number; y: number }, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const keyOf = (h: LabelHit) => (h.note !== undefined ? `n${h.note}` : `p${h.plate}`);
const notesIn = (hits: readonly LabelHit[]) =>
  hits.filter((h) => h.note !== undefined).map((h) => h.note!);
const platesIn = (s: Scene, hits: readonly LabelHit[], kind: string) =>
  hits.filter((h) => h.plate !== undefined && s.layout.plates[h.plate]!.kind === kind);

/** What a hit's tag should say. */
function textOf(s: Scene, hit: LabelHit, state: LabelState): string {
  if (hit.note !== undefined)
    return cut(s.titles[hit.note]!, hit.note === state.selected ? 46 : 30);
  const plate = s.layout.plates[hit.plate!]!;
  const meta = s.plates[hit.plate!]!;
  if (plate.kind === 'vault') return meta.chip!.text;
  return plate.kind === 'project' ? cut(meta.label, 30).toUpperCase() : cut(meta.label, 30);
}

/** The corner furthest along `score`; seen square-on, two tie, and it is their edge's middle. */
function extremeOf(
  pts: readonly { x: number; y: number }[],
  score: (p: { x: number; y: number }) => number,
) {
  const best = Math.max(...pts.map(score));
  const ends = pts.filter((p) => score(p) >= best - 0.5);
  return {
    x: ends.reduce((a, p) => a + p.x, 0) / ends.length,
    y: ends.reduce((a, p) => a + p.y, 0) / ends.length,
  };
}

/**
 * Where a hit's tag may stand, at its own size: a note's below, above, right and left of its
 * block (a note that does not matter, below or above only); a place's above its top corner,
 * left of its left one, right of its right one, or on its face.
 */
function slotsOf(s: Scene, frame: LabelFrame, hit: LabelHit): Rect[] {
  const { w, h } = hit.rect;
  const at = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y), w, h });
  const { state, cam } = frame;
  if (hit.note !== undefined) {
    const k = hit.note;
    const b = blockBox(s, cam, k, frame.lift(k));
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const slots = [at(cx - w / 2, b.y + b.h + 4), at(cx - w / 2, b.y - 4 - h)];
    const matters =
      [state.selected, state.hovered, state.cursor].includes(k) ||
      state.linked.includes(k) ||
      state.found.includes(k);
    if (matters) slots.push(at(b.x + b.w + 5, cy - h / 2), at(b.x - 5 - w, cy - h / 2));
    return slots;
  }
  const { top } = topFace(s, cam, hit.plate!);
  const up = extremeOf(top, (q) => -q.y);
  const left = extremeOf(top, (q) => -q.x);
  const right = extremeOf(top, (q) => q.x);
  const mid = extremeOf(top, () => 0);
  return [
    at(up.x - w / 2, up.y - 5 - h),
    at(left.x - 6 - w, left.y - h / 2),
    at(right.x + 6, right.y - h / 2),
    at(mid.x - w / 2, mid.y - h / 2),
  ];
}

/** How a hit's tag should be drawn: font, ink, edge, letter spacing, and how tall. */
function styleOf(s: Scene, hit: LabelHit, state: LabelState) {
  const C = LABEL_COLORS;
  const plain = { width: 1, dashed: false, spacing: '0px', height: 12 + 9 };
  const sans = `500 12px ${FONTS.sans}`;
  if (hit.note !== undefined) {
    if (hit.note === state.selected)
      return {
        ...plain,
        font: `600 13px ${FONTS.sans}`,
        ink: C.strong,
        edge: C.accent,
        width: 1.5,
        height: 12 + 11,
      };
    if (hit.note === state.hovered || hit.note === state.cursor)
      return { ...plain, font: sans, ink: C.strong, edge: C.hoverEdge };
    return { ...plain, font: sans, ink: C.body, edge: C.tagEdge };
  }
  const plate = s.layout.plates[hit.plate!]!;
  const pointed = hit.plate === state.hoverPlate;
  const mono = (weight: number) => `${weight} 12px ${FONTS.mono}`;
  if (plate.kind === 'vault') {
    const edge = pointed ? C.hoverEdge : plate.shared ? C.route : C.tagEdge;
    return { ...plain, font: mono(500), ink: C.strong, edge, dashed: plate.shared };
  }
  const edge = pointed ? C.hoverEdge : C.tagEdge;
  if (plate.kind === 'project')
    return { ...plain, font: mono(600), ink: C.strong, edge, spacing: '0.06em' };
  return { ...plain, font: mono(500), ink: C.quiet, edge };
}

// -- A sweep of busy frames ----------------------------------------------------------------

const CHROME: Rect[] = [
  { x: 0, y: 0, w: VP.width, h: 52 },
  { x: 860, y: 80, w: 340, h: 520 },
  { x: 16, y: 720, w: 260, h: 64 },
];

interface Run {
  name: string;
  s: Scene;
  ctx: FakeContext;
  hits: LabelHit[];
  frame: LabelFrame;
  forced: (h: LabelHit) => boolean;
  keyBlocks: Rect[];
}

function sweep(): Run[] {
  const s = scene(WORLD);
  const sel = noteAt(s, 'own/Atlas/maps/note 4.md');
  const state: LabelState = {
    selected: sel,
    hovered: noteAt(s, 'own/Atlas/maps/note 5.md'),
    cursor: noteAt(s, 'own/Atlas/charts/note 2.md'),
    linked: [
      'own/Atlas/maps/note 10.md',
      'own/Atlas/maps/note 11.md',
      'own/Atlas/charts/note 3.md',
      'own/Erebor/note 7.md',
      'sam/Rohan/Edoras/note 1.md',
    ].map((id) => noteAt(s, id)),
    found: s.layout.ids.map((_, k) => k).filter((k) => k % 3 === 0),
    hoverPlate: plateAt(s, 'f:own|Atlas/maps'),
  };
  const runs: Run[] = [];
  const views: [number, boolean][] = [
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [0, true],
    [1, true],
  ];
  for (const [turn, plan] of views) {
    for (const ppu of [4, 10, 28, 64]) {
      for (const lifted of [0, 0.55]) {
        const lift = (k: number) => (k === sel ? lifted : 0);
        const cam = camOn({ ...cellOf(s, sel), z: 0.6 }, ppu, turn, plan);
        const ctx = new FakeContext();
        const frame = frameOf(s, ctx, cam, { chrome: CHROME, state, lift });
        const hits = drawLabels(frame);
        const keys = [state.selected, state.hovered, state.cursor, ...state.linked, ...state.found];
        const P = isoProject(cam, VP);
        const keyBlocks = keys
          .filter((k): k is number => k !== null)
          .filter((k) => {
            const c = cellOf(s, k);
            const p = P(c.x, c.y, c.z + lift(k) + BLOCK_H / 2);
            return p.x >= 0 && p.y >= 0 && p.x <= VP.width && p.y <= VP.height;
          })
          .map((k) => blockBox(s, cam, k, lift(k)));
        runs.push({
          name: `turn ${turn}${plan ? ' plan' : ''} at ${ppu} px${lifted ? ', lifted' : ''}`,
          s,
          ctx,
          hits,
          frame,
          forced: (h) =>
            h.note === state.selected ||
            h.note === state.hovered ||
            h.note === state.cursor ||
            (h.plate !== undefined && h.plate === state.hoverPlate),
          keyBlocks,
        });
      }
    }
  }
  return runs;
}

const RUNS = sweep();

// -- The tests ----------------------------------------------------------------------------

describe('levelOf', () => {
  it('is the atlas below the project level, the folder level from LEVEL_FOLDER', () => {
    expect(levelOf(1)).toBe('atlas');
    expect(levelOf(LEVEL_PROJECT - 0.01)).toBe('atlas');
    expect(levelOf(LEVEL_PROJECT)).toBe('project');
    expect(levelOf(LEVEL_FOLDER - 0.01)).toBe('project');
    expect(levelOf(LEVEL_FOLDER)).toBe('folder');
    expect(levelOf(150)).toBe('folder');
  });
});

describe('drawLabels', () => {
  it('draws something in every frame of the sweep', () => {
    for (const run of RUNS) expect(run.hits.length, run.name).toBeGreaterThan(3);
    // Some frames are crowded: the rest of the notes compete for room.
    expect(Math.max(...RUNS.map((r) => r.hits.length))).toBeGreaterThan(25);
  });

  it('keeps every label off the others; all but a forced one off the chrome, edge, key notes', () => {
    const stage = { x: MARGIN, y: MARGIN, w: VP.width - 2 * MARGIN, h: VP.height - 2 * MARGIN };
    const wrong: string[] = [];
    for (const run of RUNS) {
      const { hits, forced, keyBlocks, name } = run;
      hits.forEach((h, j) => {
        const r = h.rect;
        const say = (what: string) => wrong.push(`${name}: ${keyOf(h)} ${what}`);
        // Nothing placed before it, forced or not, lies under it: not even a forced one.
        for (const other of hits.slice(0, j))
          if (overlap(r, other.rect)) say(`covers ${keyOf(other)}`);
        if (forced(h)) return;
        const within =
          r.x >= stage.x &&
          r.y >= stage.y &&
          r.x + r.w <= stage.x + stage.w &&
          r.y + r.h <= stage.y + stage.h;
        if (!within) say('leaves the stage');
        if (CHROME.some((c) => overlap(r, grow(c, MARGIN)))) say('is under the chrome');
        if (keyBlocks.some((b) => overlap(r, b))) say('covers a note that matters');
      });
    }
    expect(wrong).toEqual([]);
  });

  it('writes every name 12 px or larger, in an ink of its own palette', () => {
    const inks = new Set([LABEL_COLORS.strong, LABEL_COLORS.body, LABEL_COLORS.quiet]);
    let count = 0;
    for (const run of RUNS) {
      for (const t of run.ctx.texts) {
        expect(pxOf(t.font), run.name).toBeGreaterThanOrEqual(12);
        expect(inks.has(t.ink), `${run.name}: ${t.ink}`).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThan(500);
  });

  it('returns where each label is, naming the note or plate it says', () => {
    for (const run of RUNS) {
      const { ctx, hits, s, frame, name } = run;
      expect(ctx.tags(), name).toEqual(hits.map((h) => h.rect));
      // One text a tag, in the order the tags were drawn.
      expect(ctx.texts.length, name).toBe(hits.length);
      hits.forEach((h, i) => {
        const said = ctx.texts[i]!;
        expect(inside(said, h.rect), `${name}: ${keyOf(h)}`).toBe(true);
        expect(said.text, name).toBe(textOf(s, h, frame.state));
        // Sans for titles, mono for places.
        expect(said.font.endsWith(h.note !== undefined ? FONTS.sans : FONTS.mono)).toBe(true);
      });
    }
  });

  it('writes each kind of name in its own font, ink and edge', () => {
    let pointed = 0;
    for (const run of RUNS) {
      const { ctx, hits, s, frame, name } = run;
      // One edge a tag, in the order the tags were drawn.
      expect(ctx.strokes.length, name).toBe(hits.length);
      hits.forEach((h, i) => {
        const said = ctx.texts[i]!;
        const edge = ctx.strokes[i]!;
        const got = {
          font: said.font,
          ink: said.ink,
          edge: edge.stroke,
          width: edge.width,
          dashed: edge.dash.length > 0,
          spacing: said.spacing,
          height: h.rect.h,
        };
        expect(got, `${name}: ${keyOf(h)}`).toEqual(styleOf(s, h, frame.state));
        if (h.note === frame.state.hovered || h.note === frame.state.cursor) pointed++;
      });
    }
    expect(pointed).toBeGreaterThan(RUNS.length);
  });

  it('names the places in order: the one pointed at, vaults, projects biggest first, folders', () => {
    const rank = { vault: 0, project: 1, folder: 2 } as const;
    let projects = 0;
    for (const run of RUNS) {
      const { hits, s, frame, name } = run;
      const placed = hits.filter((h) => h.plate !== undefined);
      const pointedAt = placed.findIndex((h) => h.plate === frame.state.hoverPlate);
      expect(pointedAt, name).toBeLessThanOrEqual(0);
      const plates = placed
        .filter((h) => h.plate !== frame.state.hoverPlate)
        .map((h) => s.layout.plates[h.plate!]!);
      for (let i = 1; i < plates.length; i++) {
        const a = plates[i - 1]!;
        const b = plates[i]!;
        const order = `${name}: ${a.id} before ${b.id}`;
        expect(rank[a.kind] <= rank[b.kind], order).toBe(true);
        if (a.kind !== b.kind) continue;
        const bigger = a.w * a.h >= b.w * b.h;
        if (a.kind === 'project') expect(bigger, order).toBe(true);
        if (a.kind === 'folder')
          expect(a.depth < b.depth || (a.depth === b.depth && bigger)).toBe(true);
        if (a.kind === 'project') projects++;
      }
    }
    expect(projects).toBeGreaterThan(0);
  });

  it('puts every name but a forced one in a slot of its own block or plate', () => {
    const wrong: string[] = [];
    for (const run of RUNS) {
      const { hits, s, frame, forced, name } = run;
      for (const h of hits) {
        if (forced(h)) continue;
        const near = slotsOf(s, frame, h).some(
          (sl) => Math.abs(sl.x - h.rect.x) <= 1 && Math.abs(sl.y - h.rect.y) <= 1,
        );
        if (!near) wrong.push(`${name}: ${keyOf(h)} at ${h.rect.x},${h.rect.y}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('draws in CSS pixels, at the stage pixel ratio', () => {
    const s = scene(ATLAS);
    const ctx = new FakeContext();
    drawLabels(frameOf(s, ctx, camOn(plateCentre(s, 0), 30), { dpr: 2 }));
    expect(ctx.transform).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('says how many links a route carries on it, where there is room, and picks nothing', () => {
    const s = scene(ATLAS);
    const c = plateCentre(s, 0);
    const cam = camOn(c, 30);
    const at: [number, number, number] = [c.x, c.y, c.z];
    const ctx = new FakeContext();
    // Two at one point: the second finds the first's room taken, and is dropped.
    const counts = [
      { at, text: '12' },
      { at, text: '34' },
    ];
    const hits = drawLabels(frameOf(s, ctx, cam, { state: { counts } }));
    const said = ctx.texts.filter((t) => t.text === '12' || t.text === '34');
    expect(said.map((t) => t.text)).toEqual(['12']);
    expect(said[0]!.ink).toBe(LABEL_COLORS.quiet);
    expect(said[0]!.font).toContain(FONTS.mono);
    // Centred on the point, in a tag edged in the routes' grey.
    const p = isoProject(cam, VP)(...at);
    const edge = ctx.strokes.find((st) => st.stroke === LABEL_COLORS.route && inside(p, st.rect));
    expect(edge).toBeDefined();
    expect(Math.abs(edge!.rect.x + edge!.rect.w / 2 - p.x)).toBeLessThan(1);
    expect(Math.abs(edge!.rect.y + edge!.rect.h / 2 - p.y)).toBeLessThan(1);
    // Nothing a pointer could pick, and no name drawn over it.
    expect(hits.some((h) => inside(p, h.rect))).toBe(false);
    // Off the stage, not drawn at all.
    const away = new FakeContext();
    drawLabels(
      frameOf(s, away, cam, { state: { counts: [{ at: [c.x + 500, c.y, c.z], text: '12' }] } }),
    );
    expect(away.texts.some((t) => t.text === '12')).toBe(false);
  });
});

describe('a path, and the growth replay', () => {
  it("numbers a path's notes, the two ends whatever the room, and a step keeps its number when pointed at", () => {
    const s = scene(ATLAS);
    const cam = camOn(plateCentre(s, plateAt(s, 'f:own|Atlas/maps')), 30);
    // In three places, so each has room: the middle step is named when there is room, as a link is.
    const steps = [
      noteAt(s, 'own/Atlas/maps/note 3.md'),
      noteAt(s, 'own/Atlas/note 2.md'),
      noteAt(s, 'own/Atlas/charts/note 5.md'),
    ];
    const ctx = new FakeContext();
    const hits = drawLabels(frameOf(s, ctx, cam, { state: { steps } }));
    const said = (c: FakeContext) => c.texts.map((t) => t.text);
    steps.forEach((k, i) => {
      // The title cut to its room, after the number.
      const named = said(ctx).some((t) => t.startsWith(`${i + 1} · ${s.titles[k]!.slice(0, 12)}`));
      expect(named, `${i + 1}`).toBe(true);
      expect(notesIn(hits)).toContain(k);
    });
    // The ends read as a selection does, the step between as a name in the accent's rim.
    const end = ctx.texts.find((t) => t.text.startsWith('1 · '))!;
    const mid = ctx.texts.find((t) => t.text.startsWith('2 · '))!;
    expect(end.font.startsWith('600')).toBe(true);
    expect(mid.font.startsWith('500')).toBe(true);
    // Pointed at, the step keeps its number.
    const pointed = new FakeContext();
    drawLabels(frameOf(s, pointed, cam, { state: { steps, hovered: steps[1]! } }));
    expect(said(pointed).some((t) => t.startsWith('2 · '))).toBe(true);
  });

  it('names nothing the growth replay has not brought yet', () => {
    const s = scene(ATLAS);
    const cam = camOn(plateCentre(s, plateAt(s, 'f:own|Atlas/maps')), 30);
    const notes = new Uint8Array(s.layout.ids.length).fill(1);
    const plates = new Uint8Array(s.layout.plates.length).fill(1);
    const none = new FakeContext();
    expect(drawLabels(frameOf(s, none, cam, { state: { unborn: { notes, plates } } }))).toEqual([]);
    expect(none.texts).toEqual([]);
    // One note in, with the plates under it: it and they may be named, nothing else.
    const k = noteAt(s, 'own/Atlas/maps/note 3.md');
    notes[k] = 0;
    for (let q = s.layout.plateOf[k]!; q >= 0; q = s.layout.plates[q]!.parent) plates[q] = 0;
    const one = new FakeContext();
    const hits = drawLabels(
      frameOf(s, one, cam, { state: { unborn: { notes, plates }, selected: k } }),
    );
    expect(notesIn(hits)).toEqual([k]);
    for (const h of hits) if (h.plate !== undefined) expect(plates[h.plate]).toBe(0);
  });
});

describe('the notes that matter', () => {
  it('names the selected note on a stage packed with notes and chrome', () => {
    const s = scene(WORLD);
    const sel = noteAt(s, 'own/Erebor/note 12.md');
    const hov = noteAt(s, 'own/Erebor/note 13.md');
    const cam = camOn({ ...cellOf(s, sel), z: 0.6 }, 40);
    const box = blockBox(s, cam, sel);
    // Chrome over the whole stage but the selected block: no room for anything anywhere.
    const chrome: Rect[] = [
      { x: 0, y: 0, w: VP.width, h: box.y - 1 },
      { x: 0, y: box.y + box.h + 1, w: VP.width, h: VP.height },
      { x: 0, y: 0, w: box.x - 1, h: VP.height },
      { x: box.x + box.w + 1, y: 0, w: VP.width, h: VP.height },
    ];
    const all = s.layout.ids.map((_, k) => k);
    const ctx = new FakeContext();
    const cur = noteAt(s, 'own/Erebor/note 14.md');
    const erebor = plateAt(s, 'p:own|Erebor');
    const state = {
      selected: sel,
      hovered: hov,
      cursor: cur,
      hoverPlate: erebor,
      linked: all.slice(0, 60),
      found: all,
    };
    const hits = drawLabels(frameOf(s, ctx, cam, { chrome, state }));

    const mine = hits.find((h) => h.note === sel);
    expect(mine).toBeDefined();
    // Under its block, centred, where a forced name goes.
    expect(mine!.rect.y).toBe(Math.round(box.y + box.h + 4));
    expect(Math.abs(mine!.rect.x + mine!.rect.w / 2 - (box.x + box.w / 2))).toBeLessThanOrEqual(1);
    const said = ctx.texts.find((t) => inside(t, mine!.rect))!;
    expect(said.text).toBe(cut(s.titles[sel]!, 46));
    expect(said.font).toBe(`600 13px ${FONTS.sans}`);
    expect(said.ink).toBe(LABEL_COLORS.strong);
    const edgeOf = (hit: LabelHit) => ctx.strokes[hits.indexOf(hit)];
    expect(edgeOf(mine!)).toMatchObject({ stroke: LABEL_COLORS.accent, width: 1.5 });
    // The note pointed at, the keyboard's and the place pointed at are named too, in the hover
    // edge; nothing else found room.
    expect(notesIn(hits).sort()).toEqual([sel, hov, cur].sort());
    for (const k of [hov, cur]) {
      const hit = hits.find((h) => h.note === k)!;
      expect(edgeOf(hit)?.stroke).toBe(LABEL_COLORS.hoverEdge);
      expect(ctx.texts[hits.indexOf(hit)]?.ink).toBe(LABEL_COLORS.strong);
    }
    const place = hits.find((h) => h.plate === erebor);
    expect(place).toBeDefined();
    expect(edgeOf(place!)?.stroke).toBe(LABEL_COLORS.hoverEdge);
    expect(hits).toHaveLength(4);
    // Forced, and still not one over another.
    for (const [i, a] of hits.entries())
      for (const b of hits.slice(i + 1)) expect(overlap(a.rect, b.rect)).toBe(false);
  });

  it('names no note whose block is off the stage, not even the selected one', () => {
    const s = scene(ATLAS);
    const k = noteAt(s, 'own/Atlas/maps/note 8.md');
    const at = { ...cellOf(s, k), z: 0.6 };
    const cam = camOn(at, 40);
    const away = { ...cam, ...targetFor(cam, VP, at, { x: -300, y: VP.height / 2 }) };
    const hits = drawLabels(frameOf(s, new FakeContext(), away, { state: { selected: k } }));
    expect(hits.some((h) => h.note === k)).toBe(false);
  });

  it('names the search matches in view, however many lie elsewhere ahead of them', () => {
    const s = scene([...ATLAS, ...many('own', 'Mordor', 800)]);
    const vp = { width: 500, height: 360 };
    // The project level: no note but an index note is named unless it matters.
    const cam = camOn(plateCentre(s, plateAt(s, 'f:own|Atlas/maps')), 20, 0, false, vp);
    const P = isoProject(cam, vp);
    const shown = (k: number) => {
      const c = cellOf(s, k);
      const p = P(c.x, c.y, c.z + BLOCK_H / 2);
      return p.x >= 0 && p.y >= 0 && p.x <= vp.width && p.y <= vp.height;
    };
    const all = s.layout.ids.map((_, k) => k);
    const elsewhere = all.filter((k) => !shown(k));
    const here = all.filter((k) => shown(k) && !s.index[k]);
    expect(elsewhere.length).toBeGreaterThan(300); // More than the 250 matches a frame tries.
    expect(here.length).toBeGreaterThan(10);
    const state = { found: [...elsewhere, ...here] };
    const hits = drawLabels(frameOf(s, new FakeContext(), cam, { vp, state }));
    expect(notesIn(hits).filter((k) => !s.index[k]).length).toBeGreaterThanOrEqual(3);
  });

  it('measures the text again when the web font comes in', () => {
    const s = scene(ATLAS);
    const k = noteAt(s, 'own/Atlas/maps/note 8.md');
    const cam = camOn({ ...cellOf(s, k), z: 0.6 }, 40);
    const text = cut(s.titles[k]!, 30);
    const widthIn = (scale: number) => {
      const ctx = new FakeContext(true, scale);
      const hits = drawLabels(frameOf(s, ctx, cam, { state: { linked: [k] } }));
      return hits.find((h) => h.note === k)!.rect.w;
    };
    for (const scale of [0.55, 0.7, 0.55])
      expect(widthIn(scale)).toBe(Math.ceil(text.length * 12 * scale) + 12);
  });

  it('names a lifted note where its block is drawn', () => {
    const s = scene(ATLAS);
    const sel = noteAt(s, 'own/Atlas/maps/note 8.md');
    const cam = camOn({ ...cellOf(s, sel), z: 0.6 }, 40);
    const ctx = new FakeContext();
    const lift = (k: number) => (k === sel ? 0.55 : 0);
    const hits = drawLabels(frameOf(s, ctx, cam, { state: { selected: sel }, lift }));
    const box = blockBox(s, cam, sel, 0.55);
    const mine = hits.find((h) => h.note === sel)!;
    expect(mine.rect.y).toBe(Math.round(box.y + box.h + 4));
  });

  it('cuts a long title, and the selected one later', () => {
    const s = scene(ATLAS);
    const k = noteAt(s, 'own/Atlas/maps/note 3.md');
    expect(s.titles[k]!.length).toBeGreaterThan(46);
    const cam = camOn({ ...cellOf(s, k), z: 0.6 }, 40);
    const said = (state: Partial<LabelState>) => {
      const ctx = new FakeContext();
      const hit = drawLabels(frameOf(s, ctx, cam, { state })).find((h) => h.note === k)!;
      return ctx.texts.find((t) => inside(t, hit.rect))!.text;
    };
    expect(said({ linked: [k] })).toHaveLength(30);
    expect(said({ linked: [k] }).endsWith('…')).toBe(true);
    expect(said({ selected: k })).toHaveLength(46);
  });

  it('never cuts a title between the halves of an emoji', () => {
    const s = scene(ATLAS);
    const k = noteAt(s, 'own/Atlas/maps/note 8.md');
    const titles = [...s.titles];
    // The globe's first half is the 29th code unit: cut there, the tag would draw half of it.
    titles[k] = `${'x'.repeat(28)}\u{1F30D} and a little further`;
    const cam = camOn({ ...cellOf(s, k), z: 0.6 }, 40);
    const ctx = new FakeContext();
    const hits = drawLabels(frameOf({ ...s, titles }, ctx, cam, { state: { linked: [k] } }));
    const hit = hits.find((h) => h.note === k)!;
    expect(ctx.texts[hits.indexOf(hit)]!.text).toBe(`${'x'.repeat(28)}…`);
  });
});

describe('placement', () => {
  const solo = scene([note('own', 'Solo/only.md', 1)]);
  const k = 0;
  const cam = camOn({ ...cellOf(solo, k), z: 0.6 }, 40);
  const box = blockBox(solo, cam, k);
  const h = 12 + 9;
  const drawn = (state: Partial<LabelState>, chrome: Rect[] = []) => {
    const ctx = new FakeContext();
    const hits = drawLabels(frameOf(solo, ctx, cam, { state, chrome }));
    return hits.find((x) => x.note === k)?.rect ?? null;
  };
  const band = (y0: number, y1: number): Rect => ({ x: 0, y: y0, w: VP.width, h: y1 - y0 });

  it("puts a note's name under its block, else over it, else beside it", () => {
    const below = drawn({ linked: [k] })!;
    expect(below.y).toBe(Math.round(box.y + box.h + 4));
    expect(Math.abs(below.x + below.w / 2 - (box.x + box.w / 2))).toBeLessThanOrEqual(1);

    const under = band(box.y + box.h + 1, box.y + box.h + 40);
    const above = drawn({ linked: [k] }, [under])!;
    expect(above.y).toBe(Math.round(box.y - 4 - h));

    const over = band(box.y - 40, box.y - 1);
    const right = drawn({ linked: [k] }, [under, over])!;
    expect(right.x).toBe(Math.round(box.x + box.w + 5));
    // With the right side gone too, the left.
    const besideRight = { x: box.x + box.w + 1, y: 0, w: VP.width, h: VP.height };
    const left = drawn({ linked: [k] }, [under, over, besideRight])!;
    expect(left.x + left.w).toBeLessThanOrEqual(box.x - 5 + 1);
  });

  it('gives any other note only under or over its block, and drops it with neither', () => {
    expect(drawn({})).not.toBeNull();
    const under = band(box.y + box.h + 1, box.y + box.h + 40);
    const over = band(box.y - 40, box.y - 1);
    expect(drawn({}, [under, over])).toBeNull();
  });

  it("names a place over its top face's top corner; a project in the atlas, in its middle", () => {
    const s = scene(ATLAS);
    const project = plateAt(s, 'p:own|Atlas');
    const nameOf = (cam: IsoCam) => {
      const ctx = new FakeContext();
      return drawLabels(frameOf(s, ctx, cam)).find((x) => x.plate === project)!.rect;
    };
    const near = camOn(plateCentre(s, project), 30);
    const { top } = topFace(s, near, project);
    const up = top.reduce((a, b) => (b.y < a.y ? b : a));
    const r = nameOf(near);
    expect(Math.abs(r.x + r.w / 2 - up.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y + r.h + 5 - up.y)).toBeLessThanOrEqual(1);

    const far = camOn(plateCentre(s, project), 6);
    const face = topFace(s, far, project).top;
    const mid = {
      x: face.reduce((a, q) => a + q.x, 0) / 4,
      y: face.reduce((a, q) => a + q.y, 0) / 4,
    };
    const m = nameOf(far);
    expect(Math.abs(m.x + m.w / 2 - mid.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y + m.h / 2 - mid.y)).toBeLessThanOrEqual(1);
  });

  it('centres a place on its top edge when seen square-on', () => {
    const s = scene(ATLAS);
    const project = plateAt(s, 'p:own|Atlas');
    const cam = camOn(plateCentre(s, project), 30, 0, true);
    const ctx = new FakeContext();
    const r = drawLabels(frameOf(s, ctx, cam)).find((x) => x.plate === project)!.rect;
    const { top } = topFace(s, cam, project);
    const xs = top.map((q) => q.x);
    expect(Math.abs(r.x + r.w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThanOrEqual(
      1,
    );
  });

  it('names a folder only once its plate is 72 px across', () => {
    const s = scene(ATLAS);
    const folder = plateAt(s, 'f:own|Atlas/charts');
    const unit = topFace(s, camOn(plateCentre(s, folder), 1), folder).bounds.w;
    const named = (px: number) => {
      const ctx = new FakeContext();
      const cam = camOn(plateCentre(s, folder), px / unit);
      return drawLabels(frameOf(s, ctx, cam)).some((x) => x.plate === folder);
    };
    expect(named(70)).toBe(false);
    expect(named(74)).toBe(true);
  });

  it("rims a shared vault's chip with a dashed route edge, beside its swatch", () => {
    const s = scene(WORLD);
    const shared = s.layout.plates.findIndex((p) => p.kind === 'vault' && p.shared);
    const ctx = new FakeContext();
    const hits = drawLabels(frameOf(s, ctx, camOn(plateCentre(s, shared), 5)));
    const chip = hits.find((x) => x.plate === shared)!;
    const edge = ctx.strokes.find((e) => inside({ x: e.rect.x + 1, y: e.rect.y + 1 }, chip.rect))!;
    expect(edge.stroke).toBe(LABEL_COLORS.route);
    expect(edge.dash.length).toBeGreaterThan(0);
    const square = ctx.squares.find((q) => inside(q.rect, chip.rect))!;
    expect(square.fill).toBe(SWATCHES.sam);
    expect(square.rect.w).toBe(8);
    // The text starts after the swatch.
    const said = ctx.texts.find((t) => inside(t, chip.rect))!;
    expect(said.x).toBeGreaterThan(square.rect.x + square.rect.w);
  });

  it('spaces project names only where the context can', () => {
    const s = scene(ATLAS);
    const cam = camOn(plateCentre(s, 0), 12);
    const spaced = new FakeContext();
    drawLabels(frameOf(s, spaced, cam));
    const projectNames = spaced.texts.filter((t) => t.text === 'ATLAS');
    expect(projectNames).toHaveLength(1);
    expect(projectNames[0]!.spacing).toBe('0.06em');
    expect(spaced.letterSpacing).toBe('0px');
    for (const t of spaced.texts) if (t.text !== 'ATLAS') expect(t.spacing).toBe('0px');

    const plain = new FakeContext(false);
    drawLabels(frameOf(s, plain, cam));
    expect('letterSpacing' in plain).toBe(false);
    expect(plain.texts.some((t) => t.text === 'ATLAS')).toBe(true);
  });
});

describe('levels', () => {
  const s = scene(WORLD);
  const middle = {
    x: (s.layout.bounds.x0 + s.layout.bounds.x1) / 2,
    y: (s.layout.bounds.y0 + s.layout.bounds.y1) / 2,
    z: 0.6,
  };
  const at = (ppu: number, on = middle) => {
    const ctx = new FakeContext();
    return drawLabels(frameOf(s, ctx, camOn(on, ppu)));
  };

  it('names the vaults and the projects in the atlas, and no note', () => {
    const hits = at(5);
    expect(platesIn(s, hits, 'vault')).toHaveLength(2);
    expect(platesIn(s, hits, 'project').length).toBeGreaterThanOrEqual(3);
    expect(notesIn(hits)).toEqual([]);
    expect(notesIn(at(LEVEL_PROJECT - 0.1))).toEqual([]);
  });

  it('names index notes from the project level, and no other note before the folder level', () => {
    const hits = at(LEVEL_PROJECT);
    const named = notesIn(hits);
    expect(named.length).toBeGreaterThan(0);
    for (const k of named) expect(s.index[k]).toBe(true);
    const later = notesIn(at(LEVEL_FOLDER - 0.1));
    for (const k of later) expect(s.index[k]).toBe(true);
  });

  it('names any note from the folder level', () => {
    const maps = plateCentre(s, plateAt(s, 'f:own|Atlas/maps'));
    const named = notesIn(at(LEVEL_FOLDER, maps));
    expect(named.filter((k) => !s.index[k]).length).toBeGreaterThan(5);
  });

  it('names the notes of the plate flown to whatever the zoom, and only those before the folder level', () => {
    const p = plateAt(s, 'f:own|Atlas/maps');
    const ctx = new FakeContext();
    const cam = camOn(plateCentre(s, p), LEVEL_PROJECT + 1);
    const hits = drawLabels(frameOf(s, ctx, cam, { state: { focus: p } }));
    const rest = notesIn(hits).filter((k) => !s.index[k]);
    expect(rest.length).toBeGreaterThan(0);
    for (const k of rest) expect(s.layout.plateOf[k]).toBe(p);
  });
});

describe('LABEL_COLORS', () => {
  it('are the tokens globals.css sets for the same inks', () => {
    const tokens = rootTokens();
    expect(LABEL_COLORS.strong).toBe(tokens.get('fg-primary'));
    expect(LABEL_COLORS.body).toBe(tokens.get('fg-body'));
    expect(LABEL_COLORS.quiet).toBe(tokens.get('fg-secondary'));
    expect(LABEL_COLORS.accent).toBe(tokens.get('accent'));
    expect(LABEL_COLORS.hoverEdge).toBe(tokens.get('graph-la-hover-edge'));
    expect(LABEL_COLORS.route).toBe(tokens.get('graph-la-route'));
  });
});

describe('hysteresis', () => {
  const s = scene(ATLAS);
  const maps = plateCentre(s, plateAt(s, 'f:own|Atlas/maps'));
  const vp = { width: 1600, height: 1000 };
  const keys = (hits: readonly LabelHit[]) => new Set(hits.map(keyOf));

  it('draws the same labels when the camera moves by a pixel', () => {
    for (const [ppu, turn] of [
      [16, 0],
      [30, 1],
      [48, 2],
      [30, 3],
    ] as const) {
      const memory = new LabelMemory();
      const cam = camOn(maps, ppu, turn, false, vp);
      const draw = (c: IsoCam) => drawLabels(frameOf(s, new FakeContext(), c, { vp, memory }));
      const first = keys(draw(cam));
      expect(first.size).toBeGreaterThan(ppu >= LEVEL_FOLDER ? 10 : 3);
      // One pixel left, then one up.
      const nudged = (dx: number, dy: number) => ({
        ...cam,
        ...targetFor(cam, vp, maps, { x: vp.width / 2 + dx, y: vp.height / 2 + dy }),
      });
      expect(keys(draw(nudged(-1, 0)))).toEqual(first);
      expect(keys(draw(nudged(-1, -1)))).toEqual(first);
    }
  });

  it('keeps a name shown last frame before a better-linked one that would take its room', () => {
    const cam = camOn(maps, 30, 0, false, vp);
    const count = s.layout.ids.length;
    const d1 = s.layout.ids.map((_, k) => k % 5);
    const d2 = d1.map((d) => 4 - d);
    const memory = new LabelMemory();
    const draw = (degree: number[], m: LabelMemory) =>
      keys(drawLabels(frameOf(s, new FakeContext(), cam, { vp, memory: m, degree })));
    const first = draw(d1, memory);
    // The ranking turned round: last frame's names hold all the same.
    expect(draw(d2, memory)).toEqual(first);
    // Fresh, the same ranking names others: the memory did it.
    expect(draw(d2, new LabelMemory())).not.toEqual(first);
    expect(count).toBeGreaterThan(50);
  });

  it('tries the places and index notes named last frame first', () => {
    const world = scene(WORLD);
    const remembering = (...keys: string[]) => {
      const memory = new LabelMemory();
      memory.begin();
      for (const key of keys) memory.shown(key);
      return memory;
    };
    const order = (cam: IsoCam, memory: LabelMemory) =>
      drawLabels(frameOf(world, new FakeContext(), cam, { memory }));

    // Two folders at one depth: the bigger first, unless the smaller was named and it was not.
    const maps = plateAt(world, 'f:own|Atlas/maps');
    const charts = plateAt(world, 'f:own|Atlas/charts');
    const near = camOn(plateCentre(world, plateAt(world, 'p:own|Atlas')), 30);
    const places = (hits: LabelHit[]) => hits.map(keyOf).filter((x) => x.startsWith('p'));
    const fresh = places(order(near, new LabelMemory()));
    expect(fresh.indexOf(`p${maps}`)).toBeGreaterThanOrEqual(0);
    expect(fresh.indexOf(`p${maps}`)).toBeLessThan(fresh.indexOf(`p${charts}`));
    const kept = places(order(near, remembering(world.layout.plates[charts]!.id)));
    expect(kept.indexOf(`p${charts}`)).toBeGreaterThanOrEqual(0);
    expect(kept.indexOf(`p${charts}`)).toBeLessThan(kept.indexOf(`p${maps}`));

    // Index notes at the project level, likewise.
    const middle = {
      x: (world.layout.bounds.x0 + world.layout.bounds.x1) / 2,
      y: (world.layout.bounds.y0 + world.layout.bounds.y1) / 2,
      z: 0.6,
    };
    const far = camOn(middle, LEVEL_PROJECT + 2);
    const firstNamed = notesIn(order(far, new LabelMemory()));
    expect(firstNamed.length).toBeGreaterThanOrEqual(2);
    const [a, b] = firstNamed as [number, number];
    const again = notesIn(order(far, remembering(`n:${world.layout.ids[b]}`)));
    expect(again.indexOf(b)).toBeGreaterThanOrEqual(0);
    expect(again.indexOf(b)).toBeLessThan(again.indexOf(a));
  });
});

describe('LABEL_COLORS', () => {
  it('reads at 4.5:1 or better on the tag, over the darkest and lightest ground under it', () => {
    const tag = parseColor(LABEL_COLORS.tag)!;
    for (const ground of ['#0a0a0a', '#27272f']) {
      const under = over(tag, parseColor(ground)!.rgb);
      for (const ink of [LABEL_COLORS.strong, LABEL_COLORS.body, LABEL_COLORS.quiet])
        expect(
          contrast(parseColor(ink)!.rgb, under),
          `${ink} over ${ground}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
