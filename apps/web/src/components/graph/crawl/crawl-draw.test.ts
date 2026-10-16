import { describe, expect, it } from 'vitest';

import { basis, projector, type Camera } from '@/lib/graph-camera';
import { AA_TEXT, contrast, over, parseColor, type RGB } from '@/lib/contrast';

import { LabelMemory, type Rect } from '../labels/placer';

import { CRAWL_COLORS, hexA } from './crawl-colors';
import {
  FADED,
  MAX_CARDS,
  behindCamera,
  drawCrawl,
  drawSignal,
  freeStage,
  markPlace,
  type CrawlDrawing,
  type Project,
} from './crawl-draw';
import { CrawlReplay, type ReplayLabel } from './crawl-replay';
import type { ReplayView } from './replay-view';
import { sampleVault } from './sample-vault';
import type { Vec3 } from './vec';

interface Op {
  op: string;
  args: unknown[];
}

/**
 * A 2D context that draws nothing and records everything: each call, and
 * each property written (as `set:name`). Gradients record their stops.
 */
function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        ops.push({ op: key, args });
        if (key === 'measureText') return { width: String(args[0]).length * 6 };
        if (key === 'createRadialGradient' || key === 'createLinearGradient') {
          return {
            addColorStop: (...stop: unknown[]) => ops.push({ op: 'addColorStop', args: stop }),
          };
        }
        return undefined;
      };
    },
    set(target, key: string, value: unknown) {
      ops.push({ op: `set:${key}`, args: [value] });
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

const count = (ops: readonly Op[], op: string) => ops.filter((o) => o.op === op).length;
const writes = (ops: readonly Op[], key: string) =>
  ops.filter((o) => o.op === `set:${key}`).map((o) => o.args[0]);

/** Straight down the z axis, into the middle of a stage 100,000px across: every point lands on it. */
const flat: Project = (p) => ({ x: 50_000 + p[0], y: 50_000 + p[1], depth: 1, scale: 1 });
/** Straight down the z axis, as it is: for labels hung at points in screen pixels. */
const screen: Project = (p) => ({ x: p[0], y: p[1], depth: 1, scale: 1 });

/** The sample vault's tour, replayed to its end over the brain: threads lit, notes found, labels hung. */
function finished(): { replay: CrawlReplay; view: ReplayView } {
  const { model, crawls } = sampleVault();
  const replay = new CrawlReplay(() => {});
  replay.load(crawls.tour, model);
  replay.skipToEnd();
  return { replay, view: replay.view };
}

function drawing(replay: CrawlReplay, view: ReplayView, over: Partial<CrawlDrawing> = {}) {
  const d: CrawlDrawing = {
    view,
    labels: replay.labels,
    note: () => ({ radius: 3, phase: 0 }),
    time: 12,
    still: false,
    width: 100_000,
    height: 100_000,
    font: 'mono',
    ...over,
  };
  return d;
}

describe('drawCrawl', () => {
  /** A label as its card writes it: the title, then why in capitals. */
  const lines = (text: string) => {
    const at = text.lastIndexOf(' · ');
    return at < 0 ? [text] : [text.slice(0, at), text.slice(at + 3).toUpperCase()];
  };

  /** Each card's lines as drawn, a card at a time, in no particular order. */
  const cardsOf = (ops: readonly Op[]) => {
    const texts = ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
    const cards: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const why = texts[i + 1];
      // A why is in capitals; a title rarely is all capitals.
      if (why !== undefined && why === why.toUpperCase() && why !== texts[i]!.toUpperCase()) {
        cards.push(`${texts[i]} / ${why}`);
        i++;
      } else cards.push(texts[i]!);
    }
    return cards.sort();
  };
  const cardOf = (text: string) => lines(text).join(' / ');

  it('hangs a card on every note the field places, its title over why, and none on one it cannot', () => {
    const { replay, view } = finished();
    const labels = replay.labels;
    expect(labels.length).toBeGreaterThan(2);
    expect(labels.length).toBeLessThanOrEqual(MAX_CARDS);
    const all = recorder();
    drawCrawl(all.ctx, flat, drawing(replay, view));
    expect(cardsOf(all.ops)).toEqual(labels.map((l) => cardOf(l.text)).sort());

    const lost = labels.find((l) => l.nodeId)!.nodeId!;
    const field = view.field;
    // The same field, but one note in it has no place.
    const unplaced: ReplayView = {
      ...view,
      field: {
        has: (k) => field.has(k),
        point: (k, u, out) => field.point(k, u, out),
        closest: (k, q, a, b) => field.closest(k, q, a, b),
        node: (id, out) => id !== lost && field.node(id, out),
        around: (ids, hops, max) => field.around(ids, hops, max),
        up: (q, out) => field.up(q, out),
      },
    };
    const some = recorder();
    drawCrawl(some.ctx, flat, drawing(replay, unplaced));
    expect(cardsOf(some.ops)).toEqual(
      labels.filter((l) => l.nodeId !== lost).map((l) => cardOf(l.text)).sort(),
    );
  });

  it('draws the lit threads as curves and a halo on each found note, by default', () => {
    const { replay, view } = finished();
    expect(view.lit.size).toBeGreaterThan(0);
    expect(view.found.size).toBeGreaterThan(0);
    const { ctx, ops } = recorder();
    drawCrawl(ctx, flat, drawing(replay, view, { labels: [] }));
    expect(count(ops, 'quadraticCurveTo')).toBe(view.lit.size);
    expect(count(ops, 'createRadialGradient')).toBe(view.found.size);
  });

  it('draws no stroke and no gradient with the threads and the halos off', () => {
    const { replay, view } = finished();
    const { ctx, ops } = recorder();
    drawCrawl(ctx, flat, drawing(replay, view, { labels: [], threads: false, halos: false }));
    expect(count(ops, 'stroke')).toBe(0);
    expect(count(ops, 'quadraticCurveTo')).toBe(0);
    expect(count(ops, 'createRadialGradient')).toBe(0);
    expect(count(ops, 'fill')).toBe(0);
  });

  it('multiplies every opacity it sets by alpha', () => {
    const { replay, view } = finished();
    const whole = recorder();
    drawCrawl(whole.ctx, flat, drawing(replay, view));
    const half = recorder();
    drawCrawl(half.ctx, flat, drawing(replay, view, { alpha: 0.5 }));
    const a = writes(whole.ops, 'globalAlpha') as number[];
    const b = writes(half.ops, 'globalAlpha') as number[];
    expect(b.length).toBe(a.length);
    // All but the last, which puts the canvas back at 1.
    a.slice(0, -1).forEach((x, i) => expect(b[i]).toBeCloseTo(x * 0.5, 12));
  });

  it('leaves the canvas opaque and compositing normally', () => {
    const { replay, view } = finished();
    for (const alpha of [1, 0.3]) {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, flat, drawing(replay, view, { alpha }));
      expect(writes(ops, 'globalAlpha').at(-1)).toBe(1);
      expect(writes(ops, 'globalCompositeOperation').at(-1)).toBe('source-over');
    }
  });
});

describe('drawSignal', () => {
  it('is a soft point in the colour of a link, which holds still under reduced motion', () => {
    const radii = [0, 0.4, 1.3].map((time) => {
      const { ctx, ops } = recorder();
      drawSignal(ctx, 10, 20, time, true);
      const stops = ops.filter((o) => o.op === 'addColorStop').map((o) => o.args);
      expect(stops).toEqual([
        [0, hexA(CRAWL_COLORS.linked, 1)],
        [0.3, hexA(CRAWL_COLORS.linked, 0.55)],
        [1, hexA(CRAWL_COLORS.linked, 0)],
      ]);
      const arc = ops.find((o) => o.op === 'arc')!;
      expect(arc.args.slice(0, 2)).toEqual([10, 20]);
      return arc.args[2];
    });
    expect(new Set(radii).size).toBe(1);
  });

  it('breathes otherwise', () => {
    const radius = (time: number) => {
      const { ctx, ops } = recorder();
      drawSignal(ctx, 0, 0, time, false);
      return ops.find((o) => o.op === 'arc')!.args[2];
    };
    expect(radius(0.1)).not.toBe(radius(0.4));
  });
});

// -- Cards: placed or dropped by importance ------------------------------------------------------

/** A found note hung at (x, y) on the screen, found `ago` replay seconds before the view's clock. */
function hung(view: ReplayView, x: number, y: number, title: string, kind: ReplayLabel['kind'], ago: number): ReplayLabel {
  return { nodeId: null, point: [x, y, 0], text: `${title} · ${kind}`, kind, born: view.clock - ago };
}

/** The cards drawn, as the rectangles their glass was filled in. */
const cardRects = (ops: readonly Op[]): Rect[] => {
  const out: Rect[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.op !== 'roundRect' || ops[i + 1]?.op !== 'fill') continue;
    const [x, y, w, h] = ops[i]!.args as number[];
    out.push({ x: x!, y: y!, w: w!, h: h! });
  }
  return out;
};
const meet = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const titles = (ops: readonly Op[]) =>
  ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0])).filter((t) => t !== t.toUpperCase());

describe('drawCrawl cards', () => {
  it('never puts a card over another, off the stage, or over what it is told to keep clear', () => {
    const { replay, view } = finished();
    let seed = 3;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const keep: Rect[] = [{ x: 280, y: 180, w: 120, h: 22 }];
    for (let round = 0; round < 20; round++) {
      const kinds = ['named', 'linked', 'decision', 'ask'] as const;
      const labels = Array.from({ length: 30 }, (_, i) =>
        hung(view, 40 + random() * 520, 40 + random() * 320, `Note ${i}`, kinds[i % 4]!, random() * 8),
      );
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 600, height: 400, keep }));
      const cards = cardRects(ops);
      expect(cards.length).toBeGreaterThan(0);
      expect(cards.length).toBeLessThanOrEqual(MAX_CARDS);
      for (const [i, a] of cards.entries()) {
        expect(a.x >= 0 && a.y >= 0 && a.x + a.w <= 600 && a.y + a.h <= 400, `card ${i} on the stage`).toBe(true);
        for (const k of keep) expect(meet(a, k), `card ${i} over what is kept clear`).toBe(false);
        for (const b of cards.slice(i + 1)) expect(meet(a, b), `card ${i} over another`).toBe(false);
      }
    }
  });

  it('keeps every found note’s brackets clear of cards, and draws them for a find with no room for its card', () => {
    const { replay, view } = finished();
    const placed = replay.labels.filter((l) => l.nodeId);
    const at: Vec3 = [0, 0, 0];
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let crowded = false;
    for (let round = 0; round < 30; round++) {
      // Each found note somewhere on a small stage, close enough that cards compete with brackets.
      const where = new Map<string, { x: number; y: number }>();
      for (const l of placed) {
        view.field.node(l.nodeId!, at);
        where.set(at.join(), { x: 40 + random() * 320, y: 40 + random() * 200 });
      }
      const P: Project = (p) => {
        const s = where.get(p.join());
        return s ? { ...s, depth: 1, scale: 1 } : null;
      };
      const { ctx, ops } = recorder();
      drawCrawl(ctx, P, drawing(replay, view, { width: 400, height: 280, threads: false, halos: false }));
      const cards = cardRects(ops);
      for (const c of cards) {
        for (const n of where.values()) {
          // A note's brackets reach 11px round it.
          expect(meet(c, { x: n.x - 11, y: n.y - 11, w: 22, h: 22 })).toBe(false);
        }
      }
      if (cards.length < placed.length) {
        crowded = true;
        // Four corners a note: every find keeps its brackets, card or none.
        expect(count(ops, 'moveTo') - cards.length).toBeGreaterThanOrEqual(placed.length * 4);
      }
    }
    expect(crowded).toBe(true);
  });

  it('gives the room there is to what was just found first, then what to clarify, then what was named', () => {
    const { replay, view } = finished();
    // Five finds on one spot, room for two cards beside it.
    const labels = [
      hung(view, 100, 60, 'Old link', 'linked', 9),
      hung(view, 100, 60, 'Old decision', 'decision', 8),
      hung(view, 100, 60, 'Named', 'named', 7),
      hung(view, 100, 60, 'Ask', 'ask', 6),
      hung(view, 100, 60, 'Just found', 'linked', 1),
    ];
    const { ctx, ops } = recorder();
    drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 400, height: 120 }));
    expect(titles(ops).slice(0, 2)).toEqual(['Just found', 'Ask']);
    const later = recorder();
    drawCrawl(later.ctx, screen, drawing(replay, view, { labels: labels.slice(0, 3), width: 400, height: 120 }));
    expect(titles(later.ops).slice(0, 2)).toEqual(['Named', 'Old decision']);
  });

  it('keeps a card that was up, rather than trade it for a peer', () => {
    const { replay, view } = finished();
    const a = hung(view, 100, 60, 'Found first', 'linked', 9);
    const b = hung(view, 100, 60, 'Found second', 'linked', 8);
    const draw = (labels: ReplayLabel[], memory?: LabelMemory) => {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 400, height: 80, memory }));
      return titles(ops);
    };
    // Room for one card: the earlier find takes it.
    expect(draw([a, b])).toEqual(['Found first']);
    const memory = new LabelMemory();
    draw([b], memory);
    expect(draw([a, b], memory)).toEqual(['Found second']);
  });

  it('writes 12px or larger, and every line of an aging card at 4.5:1 or more on its glass', () => {
    const { replay, view } = finished();
    const labels = (['named', 'linked', 'decision', 'ask'] as const).map((k, i) => hung(view, 100 + i * 300, 200, `Note ${k}`, k, 30));
    const { ctx, ops } = recorder();
    drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 1400, height: 400 }));
    for (const font of writes(ops, 'font') as string[]) {
      expect(Number(/(\d+(?:\.\d+)?)px/.exec(font)![1])).toBeGreaterThanOrEqual(12);
    }
    // Once the fade-in is over, nothing is drawn fainter than FADED.
    for (const a of writes(ops, 'globalAlpha') as number[]) expect(a).toBeGreaterThanOrEqual(FADED);
    // Each card's text as drawn — its colour at its opacity — on its glass as drawn, over the
    // stage's own dark and over the brightest thing that can lie behind a card: a lit thread at
    // full strength, in the brightest of the walk's colours.
    const drawn = inked(ops);
    expect(drawn.glass.length).toBe(4);
    expect(drawn.text.length).toBe(8);
    for (const behind of ['#0a0a0a', CRAWL_COLORS.linked]) {
      for (const g of drawn.glass) {
        const glass = over(g, parseColor(behind)!.rgb);
        for (const t of drawn.text.filter((t) => t.card === g.card)) {
          expect(contrast(over(t, glass), glass), `${t.text} over ${behind}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });

  it('cuts a long title short rather than leave its find without a card, on a phone', () => {
    const { replay, view } = finished();
    const long = 'A note whose title runs on and on, far wider than any card on a phone could hold';
    const labels = [hung(view, 120, 200, long, 'named', 1)];
    const { ctx, ops } = recorder();
    drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 390, height: 400 }));
    expect(cardRects(ops)).toHaveLength(1);
    const [title] = titles(ops);
    expect(title!.endsWith('…')).toBe(true);
    expect(long.startsWith(title!.slice(0, -1).trimEnd())).toBe(true);
    expect(title!.length * 6).toBeLessThanOrEqual(0.45 * 390);
  });
});

describe('drawCrawl and the note the panel points at', () => {
  const mark = (x: number, y: number, free = { x: 0, y: 0, w: 400, h: 240 }) => ({
    x,
    y,
    title: 'Ledger',
    font: 'mono',
    free,
    time: 0,
    still: true,
  });

  it('marks it last: its title where the cards left room, and every card where it was', () => {
    const { replay, view } = finished();
    const labels = [
      hung(view, 120, 100, 'Orbit', 'named', 9),
      hung(view, 250, 160, 'Atlas', 'linked', 9),
      hung(view, 80, 180, 'Erebor', 'decision', 9),
    ];
    const draw = (m?: ReturnType<typeof mark>) => {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 400, height: 240, threads: false, halos: false, mark: m }));
      return ops;
    };
    const without = cardRects(draw());
    for (const [x, y] of [[200, 120], [140, 110], [300, 60]] as const) {
      const ops = draw(mark(x, y));
      const rects = cardRects(ops);
      // The cards come first and are as they were; the mark's title box, if any, is the last.
      expect(rects.slice(0, without.length)).toEqual(without);
      const title = rects.slice(without.length);
      expect(title.length).toBeLessThanOrEqual(1);
      for (const t of title) for (const c of without) expect(meet(t, c)).toBe(false);
      expect(count(ops, 'arc')).toBe(1);
    }
  });

  it('points the way to it off the free stage: an arrow on the edge, its title on the free stage', () => {
    const { replay, view } = finished();
    const free = { x: 120, y: 0, w: 280, h: 240 };
    const { ctx, ops } = recorder();
    drawCrawl(ctx, screen, drawing(replay, view, { labels: [], width: 400, height: 240, threads: false, halos: false, mark: mark(-300, 120, free) }));
    expect(count(ops, 'arc')).toBe(0);
    expect(count(ops, 'closePath')).toBe(1);
    const [title] = cardRects(ops);
    expect(title).toBeDefined();
    expect(title!.x).toBeGreaterThanOrEqual(free.x);
    expect(title!.x + title!.w).toBeLessThanOrEqual(free.x + free.w);
  });
});

describe('the stage left free, and a mark off it', () => {
  it('takes the strip each piece of chrome along an edge stands on, and nothing for what floats or slid away', () => {
    // A wide screen: the panel down the left, the toolbar over it, the zoom on the right, the
    // transport along the bottom; a panel slid away, and something floating mid-stage.
    const panel = { x: 12, y: 64, w: 360, h: 524 };
    const toolbar = { x: 12, y: 12, w: 330, h: 44 };
    const zoom = { x: 1232, y: 300, w: 36, h: 120 };
    const transport = { x: 384, y: 548, w: 300, h: 40 };
    const away = { x: -440, y: 64, w: 360, h: 524 };
    const floating = { x: 700, y: 250, w: 50, h: 50 };
    expect(freeStage(1280, 600, [toolbar, zoom, transport, away, floating, panel])).toEqual({
      x: 372,
      y: 0,
      w: 860,
      h: 548,
    });
    // A phone: the sheet at its peek, the transport over it, the views at the top.
    const sheet = { x: 0, y: 724, w: 390, h: 120 };
    const over = { x: 45, y: 668, w: 300, h: 44 };
    const views = { x: 12, y: 12, w: 340, h: 44 };
    expect(freeStage(390, 844, [views, over, sheet])).toEqual({ x: 0, y: 56, w: 390, h: 612 });
    // The sheet risen past half the stage is still a sheet: it takes the bottom, not a side.
    expect(freeStage(390, 844, [{ x: 0, y: 330, w: 390, h: 514 }])).toEqual({ x: 0, y: 0, w: 390, h: 330 });
  });

  it('marks a note on the free stage where it is, and one off it on the edge, pointing its way', () => {
    const free = { x: 372, y: 0, w: 908, h: 600 };
    expect(markPlace(800, 300, free)).toEqual({ x: 800, y: 300, toward: null });
    for (const [x, y] of [[100, 300], [2000, 300], [826, -900], [826, 5000], [-500, -500]] as const) {
      const at = markPlace(x, y, free);
      expect(at.toward).not.toBeNull();
      // Inside the free stage, by its inset, on the line from the middle toward the note.
      expect(at.x).toBeGreaterThanOrEqual(free.x + 21.9);
      expect(at.x).toBeLessThanOrEqual(free.x + free.w - 21.9);
      expect(at.y).toBeGreaterThanOrEqual(21.9);
      expect(at.y).toBeLessThanOrEqual(free.h - 21.9);
      const [cx, cy] = [free.x + free.w / 2, free.h / 2];
      expect(Math.atan2(at.y - cy, at.x - cx)).toBeCloseTo(Math.atan2(y - cy, x - cx), 9);
      expect(at.toward!).toBeCloseTo(Math.atan2(y - cy, x - cx), 9);
    }
  });

});

/** Every card's glass and every line of its text, as drawn: colour and opacity, and which card. */
function inked(ops: readonly Op[]) {
  let fill = '';
  let alpha = 1;
  let card = -1;
  const glass: { rgb: RGB; alpha: number; card: number }[] = [];
  const text: { rgb: RGB; alpha: number; card: number; text: string }[] = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!;
    if (o.op === 'set:fillStyle') fill = String(o.args[0]);
    else if (o.op === 'set:globalAlpha') alpha = Number(o.args[0]);
    else if (o.op === 'fill' && ops[i - 1]?.op === 'roundRect' && fill.startsWith('rgba(14,15,24')) {
      const c = parseColor(fill)!;
      glass.push({ rgb: c.rgb, alpha: c.alpha * alpha, card: ++card });
    } else if (o.op === 'fillText') {
      const c = parseColor(fill)!;
      text.push({ rgb: c.rgb, alpha: c.alpha * alpha, card, text: String(o.args[0]) });
    }
  }
  return { glass, text };
}

describe('the mark over the cards, cut short, and none on a sliver', () => {
  const mark = (x: number, y: number, free = { x: 0, y: 0, w: 400, h: 240 }, title = 'Ledger') => ({
    x,
    y,
    title,
    font: 'mono',
    free,
    time: 0,
    still: true,
  });

  it('moves no card even with its ring right where a card would go', () => {
    const { replay, view } = finished();
    const labels = [hung(view, 120, 120, 'Orbit', 'named', 9)];
    const draw = (m?: ReturnType<typeof mark>) => {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels, width: 400, height: 240, threads: false, halos: false, mark: m }));
      return cardRects(ops);
    };
    const [card] = draw();
    // The ring on the middle of the card's own first place.
    const rects = draw(mark(card!.x + card!.w / 2, card!.y + card!.h / 2));
    expect(rects[0]).toEqual(card);
  });

  it('cuts its title short to fit the free stage rather than leave it out', () => {
    const { replay, view } = finished();
    const free = { x: 0, y: 56, w: 390, h: 612 };
    const long = 'Decision: the whole of what we agreed about the release, and why it changed twice';
    for (const [x, y] of [[40, 100], [195, 360], [350, 600], [-500, 300], [195, 2000]] as const) {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels: [], width: 390, height: 844, threads: false, halos: false, mark: mark(x, y, free, long) }));
      const [box] = cardRects(ops);
      expect(box, `${x},${y}`).toBeDefined();
      expect(box!.x).toBeGreaterThanOrEqual(free.x);
      expect(box!.x + box!.w).toBeLessThanOrEqual(free.x + free.w);
      const [text] = ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
      expect(text!.endsWith('…')).toBe(true);
    }
  });

  it('draws no mark on a free stage too small to point from', () => {
    const { replay, view } = finished();
    for (const free of [{ x: 0, y: 0, w: 390, h: 12 }, { x: 0, y: 0, w: 30, h: 600 }]) {
      const { ctx, ops } = recorder();
      drawCrawl(ctx, screen, drawing(replay, view, { labels: [], width: 390, height: 844, threads: false, halos: false, mark: mark(100, 400, free) }));
      expect(count(ops, 'arc') + count(ops, 'closePath') + count(ops, 'fillText')).toBe(0);
    }
  });

  it('takes chrome that only comes to an edge once another has been taken, on a later pass', () => {
    // A transport larger than the sheet under it, so it is looked at first, before the sheet
    // brings the free stage's bottom up to it.
    const sheet = { x: 0, y: 744, w: 390, h: 100 };
    const pill = { x: 5, y: 630, w: 380, h: 110 };
    expect(freeStage(390, 844, [pill, sheet])).toEqual({ x: 0, y: 0, w: 390, h: 630 });
  });
});

describe('behindCamera', () => {
  it('points to the side a point behind the camera lies on, as seen from the camera', () => {
    const cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0.4, pitch: 0.3, dist: 200 };
    const vp = { width: 800, height: 600 };
    const { position, right, up, forward } = basis(cam);
    const at = (r: number, u: number): Vec3 =>
      [0, 1, 2].map((i) => position[i]! - forward[i]! * 50 + right[i]! * r + up[i]! * u) as unknown as Vec3;
    for (const [r, u] of [[30, 0], [-30, 0], [0, 30], [0, -30], [20, -40]] as const) {
      const p = at(r, u);
      // Behind: the camera cannot project it.
      expect(projector(cam, vp)(p[0], p[1], p[2])).toBeNull();
      const b = behindCamera(cam, vp, p)!;
      // Right of the middle for a point to the camera's right, above it for one above.
      if (r) expect(Math.sign(b.x - 400)).toBe(Math.sign(r));
      else expect(Math.abs(b.x - 400)).toBeLessThan(1e-6);
      if (u) expect(Math.sign(b.y - 300)).toBe(-Math.sign(u));
      else expect(Math.abs(b.y - 300)).toBeLessThan(1e-6);
      expect(Math.hypot(b.x - 400, b.y - 300)).toBeGreaterThan(1e4);
    }
    // Straight behind, it has no side.
    expect(behindCamera(cam, vp, at(0, 0))).toBeNull();
  });
});
