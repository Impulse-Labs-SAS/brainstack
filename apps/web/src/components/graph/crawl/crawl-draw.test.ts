import { describe, expect, it } from 'vitest';

import { CRAWL_COLORS, hexA } from './crawl-colors';
import { drawCrawl, drawSignal, type CrawlDrawing, type Project } from './crawl-draw';
import { CrawlReplay } from './crawl-replay';
import type { ReplayView } from './replay-view';
import { sampleVault } from './sample-vault';

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

/** Straight down the z axis: every point lands somewhere, nothing is culled. */
const flat: Project = (p) => ({ x: p[0], y: p[1], depth: 1, scale: 1 });

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
    font: 'mono',
    ...over,
  };
  return d;
}

describe('drawCrawl', () => {
  it('hangs a label on every note the field places, in its colour, and none on one it cannot', () => {
    const { replay, view } = finished();
    const labels = replay.labels;
    expect(labels.length).toBeGreaterThan(2);
    const all = recorder();
    drawCrawl(all.ctx, flat, drawing(replay, view));
    expect(all.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0])).toEqual(
      labels.map((l) => l.text),
    );

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
    expect(some.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0])).toEqual(
      labels.filter((l) => l.nodeId !== lost).map((l) => l.text),
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
