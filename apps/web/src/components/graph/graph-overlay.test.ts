// What the overlay promises about labels, checked on what it actually draws: a 2D context that
// records every fillText with the font, alignment and alpha in force, over a vault dense enough
// for labels to fight for room.

import { describe, expect, it } from 'vitest';

import { boundsOf, fitBounds, type Camera, type Viewport } from '@/lib/graph-camera';
import { layoutTerritories } from '@/lib/graph-map';
import { hopsFrom, type GraphModel, type GraphNode, type GraphPath } from '@/lib/graph-model';

import { largeVault } from './crawl/space/large-vault';
import { drawOverlay, overlayMovesUntil, projectNodes, type OverlayFrame } from './graph-overlay';
import { LabelMemory, type Rect } from './labels/placer';

interface Drawn {
  text: string;
  rect: Rect;
  px: number;
  alpha: number;
  baseline: string;
}

const sizeOf = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
/** A stand-in for text metrics: wide enough per character for labels to collide as they would. */
const widthOf = (text: string, font: string) => text.length * sizeOf(font) * 0.55;

/** A context that draws nothing and keeps every piece of text, where it went and how. */
function recorder() {
  const drawn: Drawn[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key === 'measureText')
        return (text: string) => ({ width: widthOf(text, String(target.font)) });
      if (key === 'fillText') {
        return (text: string, x: number, y: number) => {
          const font = String(target.font);
          const w = widthOf(text, font);
          const px = sizeOf(font);
          const left = target.textAlign === 'center' ? x - w / 2 : x;
          const top = target.textBaseline === 'top' ? y : y - px / 2;
          drawn.push({
            text,
            rect: { x: left, y: top, w, h: px },
            px,
            alpha: Number(target.globalAlpha),
            baseline: String(target.textBaseline),
          });
        };
      }
      return () => undefined;
    },
    set(target, key, value: unknown) {
      if (typeof key === 'string') target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, drawn };
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const VP: Viewport = { width: 1280, height: 800 };

/** The large vault seen straight down, zoomed in to where notes are named, projected. */
function scene(zoom: number, is3D = false): { model: GraphModel; cam: Camera } {
  const { model } = largeVault(11, 1600);
  const fit = fitBounds(boundsOf(model.nodes)!, VP);
  const cam: Camera = { ...fit, dist: fit.dist / zoom, yaw: 0, pitch: 0 };
  projectNodes(model, cam, VP, is3D, 300);
  return { model, cam };
}

function frame(model: GraphModel, cam: Camera, over: Partial<OverlayFrame> = {}): OverlayFrame {
  return {
    now: 0,
    vp: VP,
    dpr: 1,
    cam,
    is3D: false,
    view: 'network',
    brainScale: 300,
    cloud: 0,
    model,
    landAlpha: 0,
    land: null,
    landed: null,
    territory: null,
    hotCountry: null,
    countryRoutes: null,
    ring: null,
    hover: null,
    selected: null,
    pathFrom: null,
    path: null,
    pathT0: 0,
    focus: null,
    focusT0: 0,
    hops: null,
    matched: null,
    matches: null,
    searchT0: 0,
    vaultLabels: false,
    fallback: false,
    appear: () => 1,
    reduceMotion: true,
    fonts: { sans: 'sans-serif', mono: 'monospace' },
    chrome: [],
    labels: new LabelMemory(),
    labelPx: 12,
    ...over,
  };
}

/**
 * Notes well inside the stage, in model order, whose title no other note shares: the large
 * vault repeats titles across projects, and a label is told apart by where it is as well.
 */
const inside = (model: GraphModel) => {
  const count = new Map<string, number>();
  for (const n of model.nodes) count.set(n.label, (count.get(n.label) ?? 0) + 1);
  return model.nodes.filter(
    (n) =>
      count.get(n.label) === 1 &&
      n.onScreen &&
      n.sx > 200 &&
      n.sx < VP.width - 200 &&
      n.sy > 150 &&
      n.sy < VP.height - 150,
  );
};

/** The label drawn for `n`: its text, under, over or beside its dot. */
const labelOf = (drawn: Drawn[], n: GraphNode) =>
  drawn.find(
    (d) =>
      d.baseline === 'top' &&
      n.label.startsWith(d.text.replace(/…$/, '')) &&
      Math.abs(d.rect.x + d.rect.w / 2 - n.sx) <= d.rect.w / 2 + 30 &&
      d.rect.y > n.sy - 40 &&
      d.rect.y < n.sy + 30,
  );

/** Every piece of text: at least 12px, at full strength, clear of the rest and of the chrome. */
function expectReadable(drawn: Drawn[], chrome: Rect[] = []) {
  for (const d of drawn) {
    expect(d.px, d.text).toBeGreaterThanOrEqual(12);
    expect(d.alpha, d.text).toBeGreaterThanOrEqual(0.88);
    for (const c of chrome) expect(intersects(d.rect, c), d.text).toBe(false);
  }
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      expect(
        intersects(drawn[i]!.rect, drawn[j]!.rect),
        `${drawn[i]!.text} / ${drawn[j]!.text}`,
      ).toBe(false);
    }
  }
}

describe('drawOverlay labels', () => {
  it('never draws one label over another, at any zoom, with or without a note in focus', () => {
    for (const zoom of [1, 2.5, 6]) {
      const { model, cam } = scene(zoom);
      const focus = inside(model)[0]!;
      for (const over of [{}, { focus, selected: focus, hops: hopsFrom(model, focus) }]) {
        const { ctx, drawn } = recorder();
        drawOverlay(ctx, frame(model, cam, over));
        const labels = drawn.filter((d) => d.baseline === 'top');
        expect(labels.length).toBeGreaterThan(5);
        for (let i = 0; i < labels.length; i++) {
          for (let j = i + 1; j < labels.length; j++) {
            expect(
              intersects(labels[i]!.rect, labels[j]!.rect),
              `${labels[i]!.text} / ${labels[j]!.text}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the selected note named while the pointer is on another one', () => {
    const { model, cam } = scene(2.5);
    const [selected, hovered] = inside(model);
    const { ctx, drawn } = recorder();
    drawOverlay(
      ctx,
      frame(model, cam, {
        selected,
        hover: hovered,
        focus: hovered,
        hops: hopsFrom(model, hovered!),
      }),
    );
    expect(labelOf(drawn, selected!)).toBeDefined();
    expect(labelOf(drawn, hovered!)).toBeDefined();
  });

  it('draws no text under 12px, and none faint', () => {
    for (const is3D of [false, true]) {
      const { model, cam } = scene(2.5, is3D);
      const focus = inside(model)[3]!;
      const { ctx, drawn } = recorder();
      drawOverlay(
        ctx,
        frame(model, cam, {
          is3D,
          view: is3D ? 'brain' : 'network',
          focus,
          hops: hopsFrom(model, focus),
        }),
      );
      expect(drawn.length).toBeGreaterThan(5);
      for (const d of drawn) {
        expect(d.px).toBeGreaterThanOrEqual(12);
        expect(d.alpha).toBeGreaterThanOrEqual(0.88);
      }
    }
  });

  it('leaves the chrome clear, and still names the selected note if it lies under it', () => {
    const { model, cam } = scene(2.5);
    const selected = inside(model)[0]!;
    const toolbar = { x: 0, y: 0, w: VP.width, h: 60 };
    const panel = { x: VP.width - 330, y: 60, w: 330, h: VP.height - 60 };
    const legend = { x: 0, y: selected.sy - 10, w: selected.sx + 200, h: 120 };
    const { ctx, drawn } = recorder();
    drawOverlay(ctx, frame(model, cam, { selected, chrome: [toolbar, panel, legend] }));
    for (const d of drawn.filter((x) => x.baseline === 'top' && !labelOf([x], selected))) {
      for (const c of [toolbar, panel, legend]) expect(intersects(d.rect, c), d.text).toBe(false);
    }
    expect(labelOf(drawn, selected)).toBeDefined();
  });

  it('names continents and countries readably on the map, as cities come in', () => {
    const { model } = largeVault(11, 1600);
    const territory = layoutTerritories(model.nodes, model.vaults);
    for (const [n, p] of territory.positions) Object.assign(n, { x: p.x, y: p.y, z: 0 });
    const fit = fitBounds(boundsOf([...territory.positions.keys()])!, VP);
    const toolbar = { x: 0, y: 0, w: VP.width, h: 56 };
    for (const zoom of [1, 3]) {
      const cam: Camera = { ...fit, dist: fit.dist / zoom, yaw: 0, pitch: 0 };
      projectNodes(model, cam, VP, false, 300, 1);
      const { ctx, drawn } = recorder();
      drawOverlay(
        ctx,
        frame(model, cam, { view: 'territories', landAlpha: 1, territory, chrome: [toolbar] }),
      );
      expect(drawn.length).toBeGreaterThan(3);
      expectReadable(drawn, [toolbar]);
    }
  });

  it('names projects, vaults, search zones and the ring of loose notes readably', () => {
    const { model, cam } = scene(0.7);
    const matches = model.nodes.filter((n) => n.kind === 'note').slice(0, 30);
    const cases: Partial<OverlayFrame>[] = [
      { cloud: 0.8, ring: { r: 250, count: 12 } },
      { vaultLabels: true },
      { matches, matched: new Set(matches) },
    ];
    for (const over of cases) {
      const { ctx, drawn } = recorder();
      drawOverlay(ctx, frame(model, cam, over));
      expect(drawn.length).toBeGreaterThan(1);
      expectReadable(drawn);
    }
  });

  it('keeps the labels it drew last frame when there is room for them', () => {
    const { model, cam } = scene(2.5);
    const labels = new LabelMemory();
    const first = recorder();
    drawOverlay(first.ctx, frame(model, cam, { labels }));
    const second = recorder();
    drawOverlay(second.ctx, frame(model, cam, { labels }));
    expect(second.drawn.map((d) => d.text)).toEqual(first.drawn.map((d) => d.text));
  });
});

describe('overlayMovesUntil', () => {
  const still = {
    hops: null,
    hotCountry: null,
    countryRoutes: null,
    focusT0: 1000,
    path: null,
    pathT0: 1000,
    matches: null,
    searchT0: 1000,
    reduceMotion: false,
  };
  const pathOf = (edges: number) =>
    ({ nodes: [], edges: Array.from({ length: edges }), implicit: false }) as unknown as GraphPath;

  /** A focused note's hops: itself, and `linked` notes a hop away. */
  const hopsOf = (linked: number) =>
    new Map(Array.from({ length: linked + 1 }, (_, i) => [{} as GraphNode, Math.min(i, 1)]));

  it('is long past with nothing moving, and under reduced motion whatever there is', () => {
    expect(overlayMovesUntil(still)).toBe(-Infinity);
    // A note with no links: nothing for the signal to run along.
    expect(overlayMovesUntil({ ...still, hops: hopsOf(0) })).toBe(-Infinity);
    const moving = { ...still, hops: hopsOf(3), path: pathOf(3), matches: model5() };
    expect(overlayMovesUntil(moving)).toBeGreaterThan(1000);
    expect(overlayMovesUntil({ ...moving, reduceMotion: true })).toBe(-Infinity);
  });

  it('plays nothing of its own past five seconds, the light along a path in whole runs', () => {
    const signal = overlayMovesUntil({ ...still, hops: hopsOf(2) }) - 1000;
    expect(signal).toBeGreaterThan(3000);
    expect(signal).toBeLessThanOrEqual(5000);
    const pings = overlayMovesUntil({ ...still, matches: model5() }) - 1000;
    expect(pings).toBeGreaterThan(1000);
    expect(pings).toBeLessThanOrEqual(5000);
    for (let edges = 1; edges <= 40; edges++) {
      // At 430 ms an edge, or faster where one run would not fit in five seconds.
      const run = Math.min(430 * edges, 5000);
      const played = overlayMovesUntil({ ...still, path: pathOf(edges) }) - 1000;
      const runs = played / run;
      expect(runs, `${edges} edges`).toBeCloseTo(Math.round(runs), 9);
      expect(runs, `${edges} edges`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(played, `${edges} edges`).toBeLessThanOrEqual(5000 + 1e-9);
      expect(played + run, `${edges} edges: one run more would fit`).toBeGreaterThan(5000);
    }
  });
});

/** Five notes a search found: only how many counts. */
const model5 = () => Array.from({ length: 5 }, () => ({}) as GraphNode);
