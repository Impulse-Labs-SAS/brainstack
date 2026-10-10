import { describe, expect, it } from 'vitest';

import { CrawlReplay } from '../../crawl-replay';
import { sampleVault } from '../../sample-vault';
import { threadEnds, type ThreadKey } from '../../threads';
import { polylineThreadField } from '../polyline-field';
import { volumeLayout } from '../volume/layout';

import { routeChords } from './chords';
import { DormantState, FOUND_CODE, NEVER, STATE_WIDTH, type StateDelta } from './state';

type Crawl = keyof ReturnType<typeof sampleVault>['crawls'];
const CRAWLS: readonly Crawl[] = ['walk', 'gap', 'ask', 'tour'];

const vault = sampleVault(7);
const layout = volumeLayout(vault.model);
const field = polylineThreadField({
  nodes: layout.positions,
  routes: layout.routes,
  adjacency: layout.adjacency,
  cell: layout.unit,
});
const chords = routeChords(layout.routes);
const ids = [...layout.positions.keys()];

function replayOf(crawl: Crawl): CrawlReplay {
  const r = new CrawlReplay(() => {});
  r.load(vault.crawls[crawl], vault.model, { field, unit: layout.unit, pace: 9 * layout.unit });
  return r;
}

const stateOf = (keys: readonly ThreadKey[] = chords.keys) =>
  new DormantState(
    ids,
    keys,
    keys.map((k) => chords.lengths[chords.keys.indexOf(k)]!),
  );

/** Runs a replay to its end at `fps`, the state brought up to it every frame. */
function run(r: CrawlReplay, s: DormantState, fps: number, each?: (d: StateDelta) => void): void {
  let guard = 0;
  const step = () => {
    const d = s.sync(r.view);
    each?.(d);
  };
  step();
  while (r.view.mode !== 'done' && r.view.mode !== 'idle' && guard++ < 100_000) {
    r.update(1 / fps);
    r.drain();
    step();
  }
}

/** The thread texture without the grips, when and where, which depend on which frames saw a grip land. */
function withoutGrips(s: DormantState): number[] {
  return Array.from(s.threads).filter((_, i) => i % 8 !== 3 && i % 8 !== 7);
}

describe('the dormant state', () => {
  it('starts dark, and sends both textures up whole once', () => {
    const s = stateOf();
    expect(s.nodes.length).toBe(STATE_WIDTH * s.nodeRows * 4);
    expect(s.threads.length).toBe(STATE_WIDTH * s.threadRows * 4);
    const d = s.sync(null);
    expect(d.nodes.full).toBe(true);
    expect(d.threads.full).toBe(true);
    expect(d.reset).toBe(false);
    for (let n = 0; n < ids.length; n++) {
      expect(s.nodes[n * 4]).toBe(NEVER);
      expect(s.nodes[n * 4 + 1]).toBe(NEVER);
      expect(s.nodes[n * 4 + 2]).toBe(0);
    }
    chords.keys.forEach((_, t) => {
      expect(s.threads[t * 8]).toBe(NEVER);
      expect(s.threads[t * 8 + 2]).toBe(0);
      expect(s.threads[t * 8 + 3]).toBe(NEVER);
      expect(s.threads[t * 8 + 5]).toBe(chords.lengths[t]);
    });
    const again = s.sync(null);
    expect(again.nodes.full || again.threads.full).toBe(false);
    expect(s.uploads).toBe(2);
  });

  it('stamps what the crawl did with the replay’s own times', () => {
    let reachedAll = 0;
    let foundAll = 0;
    let passedAll = 0;
    for (const crawl of CRAWLS) {
      const r = replayOf(crawl);
      const s = stateOf();
      run(r, s, 60);
      const { reached, foundAt, passages } = r.view.history;
      reachedAll += reached.size;
      foundAll += foundAt.size;
      for (const [id, at] of reached) {
        expect(s.nodes[s.nodeIndex(id) * 4]).toBe(Math.fround(at));
      }
      for (const [id, at] of foundAt) {
        const n = s.nodeIndex(id);
        expect(s.nodes[n * 4 + 1]).toBe(Math.fround(at));
        expect(s.nodes[n * 4 + 2]).toBe(FOUND_CODE[r.view.found.get(id)!]);
      }
      for (const id of ids) {
        if (!reached.has(id)) expect(s.nodes[s.nodeIndex(id) * 4]).toBe(NEVER);
        if (!foundAt.has(id)) expect(s.nodes[s.nodeIndex(id) * 4 + 1]).toBe(NEVER);
      }
      // Each thread holds its latest passage, the way it went, and the trail walked before it.
      let trail = 0;
      const latest = new Map<
        ThreadKey,
        { enter: number; leave: number; way: number; offset: number }
      >();
      const count = new Map<ThreadKey, number>();
      for (const p of passages) {
        const t = s.threadIndex(p.key);
        const length = t >= 0 ? chords.lengths[t]! : 0;
        const sign = threadEnds(p.key)[0] === p.fromId ? 1 : -1;
        const way = sign * (p.kind === 'walk' ? 1 : 1 + FOUND_CODE[p.kind]);
        latest.set(p.key, {
          enter: p.enter,
          leave: p.leave,
          way,
          offset: p.kind === 'walk' ? trail : 0,
        });
        count.set(p.key, (count.get(p.key) ?? 0) + 1);
        if (p.kind === 'walk') trail = Math.fround(trail + length);
      }
      passedAll += latest.size;
      for (const [key, p] of latest) {
        const t = s.threadIndex(key);
        if (t < 0) continue;
        expect(s.threads[t * 8]).toBe(Math.fround(p.enter));
        expect(s.threads[t * 8 + 1]).toBe(Math.fround(p.leave));
        expect(s.threads[t * 8 + 2]).toBe(p.way);
        expect(s.threads[t * 8 + 4]).toBeCloseTo(p.offset, 2);
        expect(s.threads[t * 8 + 6]).toBe(count.get(key)! > 1 ? 1 : 0);
      }
    }
    expect(reachedAll).toBeGreaterThan(10);
    expect(foundAll).toBeGreaterThan(3);
    expect(passedAll).toBeGreaterThan(5);
  });

  it('uploads nothing at rest', () => {
    const r = replayOf('tour');
    const s = stateOf();
    run(r, s, 60);
    const uploads = s.uploads;
    for (let i = 0; i < 120; i++) {
      r.update(1 / 60);
      const d = s.sync(r.view);
      expect(d.nodes.full || d.threads.full).toBe(false);
      expect(d.nodes.ranges).toHaveLength(0);
      expect(d.threads.ranges).toHaveLength(0);
      expect(d.opened).toHaveLength(0);
    }
    expect(s.uploads).toBe(uploads);
  });

  it('sends only whole texels, each span inside one row', () => {
    const r = replayOf('tour');
    const s = stateOf();
    let spans = 0;
    run(r, s, 60, (d) => {
      for (const u of [d.nodes, d.threads]) {
        if (u.full) continue;
        for (let i = 0; i < u.ranges.length; i += 2) {
          const start = u.ranges[i]!;
          const count = u.ranges[i + 1]!;
          spans++;
          expect(start % 4).toBe(0);
          expect(count % 4).toBe(0);
          const row = (f: number) => Math.floor(f / 4 / STATE_WIDTH);
          expect(row(start + count - 1)).toBe(row(start));
        }
      }
    });
    expect(spans).toBeGreaterThan(10);
  });

  it('lights the same at 24, 60 and 144 frames a second, and after a jump to the end', () => {
    for (const crawl of CRAWLS) {
      const results = [24, 60, 144].map((fps) => {
        const r = replayOf(crawl);
        const s = stateOf();
        run(r, s, fps);
        return s;
      });
      const r = replayOf(crawl);
      const jumped = stateOf();
      jumped.sync(r.view);
      r.skipToEnd();
      jumped.sync(r.view);
      for (const s of [...results.slice(1), jumped]) {
        expect(Array.from(s.nodes)).toEqual(Array.from(results[0]!.nodes));
        expect(withoutGrips(s)).toEqual(withoutGrips(results[0]!));
      }
    }
  });

  it('opens each thread once, in the order it was first gone along', () => {
    const r = replayOf('tour');
    const s = stateOf();
    const opened: number[] = [];
    run(r, s, 60, (d) => opened.push(...d.opened));
    const firsts: number[] = [];
    for (const p of r.view.history.passages) {
      const t = s.threadIndex(p.key);
      if (t >= 0 && !firsts.includes(t)) firsts.push(t);
    }
    expect(opened).toEqual(firsts);
    expect(new Set(opened).size).toBe(opened.length);
  });

  it('puts everything out when the crawl starts over, or goes', () => {
    const r = replayOf('walk');
    const s = stateOf();
    run(r, s, 60);
    r.replay();
    const d = s.sync(r.view);
    expect(d.reset).toBe(true);
    expect(d.nodes.full && d.threads.full).toBe(true);
    const first = r.view.hereId!;
    for (const id of ids) {
      expect(s.nodes[s.nodeIndex(id) * 4]).toBe(id === first ? 0 : NEVER);
      expect(s.nodes[s.nodeIndex(id) * 4 + 1]).toBe(NEVER);
    }
    for (let t = 0; t < chords.keys.length; t++) expect(s.threads[t * 8 + 2]).toBe(0);

    run(r, s, 60);
    const gone = s.sync(null);
    expect(gone.reset).toBe(true);
    expect(s.nodes[s.nodeIndex(first) * 4]).toBe(NEVER);
    // Dark already: nothing more to put out.
    expect(s.sync(null).reset).toBe(false);
  });

  it('puts the last crawl out when another is loaded and jumped to its end, as reduced motion does', () => {
    // The replay keeps one history and empties it to start over; a crawl that
    // is already over by the next sync can end later than the last one did,
    // with no fewer passages or notes.
    const pairs: ReadonlyArray<readonly [Crawl, Crawl]> = [
      ['ask', 'walk'],
      ['ask', 'gap'],
      ['ask', 'tour'],
      ['gap', 'walk'],
      ['gap', 'tour'],
    ];
    for (const [from, to] of pairs) {
      const r = replayOf(from);
      const s = stateOf();
      run(r, s, 60);
      r.load(vault.crawls[to], vault.model, {
        field,
        unit: layout.unit,
        pace: 9 * layout.unit,
      });
      r.skipToEnd();
      expect(s.sync(r.view).reset).toBe(true);
      const fresh = stateOf();
      fresh.sync(r.view);
      expect(Array.from(s.nodes)).toEqual(Array.from(fresh.nodes));
      expect(Array.from(s.threads)).toEqual(Array.from(fresh.threads));
    }
  });

  it('leaves alone a passage along a pair it draws no thread for', () => {
    const r = replayOf('tour');
    // Every other thread kept: the rest are passages with nowhere to go.
    const kept = chords.keys.filter((_, i) => i % 2 === 0);
    const s = stateOf(kept);
    const opened: number[] = [];
    expect(() => run(r, s, 60, (d) => opened.push(...d.opened))).not.toThrow();
    const passed = new Set(r.view.history.passages.map((p) => p.key));
    expect([...passed].some((k) => s.threadIndex(k) < 0)).toBe(true);
    expect(opened.every((t) => t >= 0 && t < kept.length)).toBe(true);
    expect(opened.length).toBe([...passed].filter((k) => s.threadIndex(k) >= 0).length);
  });

  it('follows the walk along its thread, and the note it reads, without writing either', () => {
    const r = replayOf('tour');
    const s = stateOf();
    let walking = 0;
    let reading = 0;
    let last = { stretch: null as object | null, u: 0 };
    run(r, s, 60, () => {
      const v = r.view;
      if (v.mode === 'walk' && s.head[0] >= 0) {
        walking++;
        const w = v.walk!;
        // The stretch the walk is on, as the replay counts it.
        let k = 0;
        let d = w.travelled;
        while (k < w.segments.length - 1 && d > w.segments[k]!.length) d -= w.segments[k++]!.length;
        const stretch = w.segments[k]!;
        expect(s.threadIndex(stretch.key!)).toBe(s.head[0]);
        expect(s.head[1]).toBeCloseTo(Math.min(1, d / stretch.length), 9);
        if (last.stretch === stretch) expect(s.head[1]).toBeGreaterThanOrEqual(last.u - 1e-9);
        last = { stretch, u: s.head[1] };
      }
      if (v.mode === 'dwell' && v.dwell) {
        reading++;
        expect(s.read[0]).toBe(s.nodeIndex(v.hereId!));
        expect(s.read[2] - s.read[1]).toBeCloseTo(v.dwell.duration, 9);
        expect(s.read[1]).toBeCloseTo(v.clock - v.dwell.t, 9);
      }
    });
    expect(walking).toBeGreaterThan(30);
    expect(reading).toBeGreaterThan(30);
    expect(s.head[0]).toBe(-1);
  });

  it('stamps a thread when and where a grip lands on it', () => {
    const r = replayOf('tour');
    const s = stateOf();
    let grips = 0;
    // Every grip seen on each thread, when and where.
    const seen = new Map<ThreadKey, Set<string>>();
    const pair = (since: number, u: number) => `${Math.fround(since)}@${Math.fround(u)}`;
    run(r, s, 60, () => {
      for (const h of r.view.holds) {
        if (!h) continue;
        const set = seen.get(h.key) ?? new Set<string>();
        set.add(pair(h.since, h.u));
        seen.set(h.key, set);
      }
      for (const h of r.view.holds) {
        if (!h) continue;
        const t = s.threadIndex(h.key);
        if (t < 0) continue;
        grips++;
        // Two slots may hold one thread: the stamp is the latest of them, and
        // when and where come from one and the same grip.
        expect(s.threads[t * 8 + 3]).toBeGreaterThanOrEqual(Math.fround(h.since));
        expect(seen.get(h.key)!.has(pair(s.threads[t * 8 + 3]!, s.threads[t * 8 + 7]!))).toBe(true);
      }
    });
    expect(grips).toBeGreaterThan(20);
  });
});
