import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import type { CrawlResult } from './crawl-plan';
import { CrawlReplay, voidProgress, walkProgress } from './crawl-replay';
import type { ReplayEvent } from './replay-view';
import { sampleVault } from './sample-vault';
import { segmentLength, threadEnds, threadKey, typicalLink } from './threads';
import type { Vec3 } from './vec';

type Crawl = keyof ReturnType<typeof sampleVault>['crawls'];
const CRAWLS: readonly Crawl[] = ['walk', 'gap', 'ask', 'tour'];

/**
 * What the 2D spider's eight feet lit on the sample walk crawl before grips
 * replaced them (CrawlLayer as of 1154471: 22 threads at 24, 60 and 144 fps).
 */
const LEGGED_SPIDER_LIT = 22;

/** Runs a replay to its end at `fps`, draining its events as a view does every frame. */
function run(
  r: CrawlReplay,
  fps: number,
  each?: (events: readonly ReplayEvent[]) => void,
): ReplayEvent[] {
  const all: ReplayEvent[] = [];
  let guard = 0;
  while (r.view.mode !== 'done' && r.view.mode !== 'idle' && guard++ < 200_000) {
    r.update(1 / fps);
    const events = r.drain();
    all.push(...events);
    each?.(events);
  }
  return all;
}

function replayOf(crawl: Crawl, model = sampleVault().model): CrawlReplay {
  const r = new CrawlReplay(() => {});
  r.load(sampleVault().crawls[crawl], model);
  return r;
}

const litKeys = (r: CrawlReplay) => [...r.view.lit.keys()].sort();

/** The same vault built again, as a layer toggle does: the same note objects, new edge objects. */
function rebuild(model: GraphModel): GraphModel {
  return buildGraphModel({
    nodes: model.nodes.map((n) => ({
      id: n.id,
      path: n.path,
      title: n.title,
      ownerId: n.ownerId,
      project: n.project!,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
    edges: model.edges.map((e) => ({ source: e.source.id, target: e.target.id, weight: e.weight })),
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(model.nodes.map((n) => [n.id, n])),
  });
}

describe('CrawlReplay', () => {
  it('lights the same threads at 24, 60 and 144 frames a second', () => {
    for (const crawl of CRAWLS) {
      const lit = [24, 60, 144].map((fps) => {
        const r = replayOf(crawl);
        run(r, fps);
        expect(r.snapshot.threads).toBe(r.view.lit.size);
        return { keys: litKeys(r), found: [...r.view.found].sort() };
      });
      expect(lit[0]!.keys.length).toBeGreaterThan(0);
      expect(lit[1]).toEqual(lit[0]);
      expect(lit[2]).toEqual(lit[0]);
    }
  });

  it('jumping to the end lights exactly what the animated replay lights, and ends in the same place', () => {
    for (const crawl of CRAWLS) {
      const animated = replayOf(crawl);
      run(animated, 60);
      const jumped = replayOf(crawl);
      jumped.skipToEnd();
      expect(jumped.view.mode).toBe('done');
      expect(litKeys(jumped)).toEqual(litKeys(animated));
      expect(jumped.view.hereId).toBe(animated.view.hereId);
      expect([...jumped.view.found].sort()).toEqual([...animated.view.found].sort());
      expect(jumped.snapshot.found).toEqual(animated.snapshot.found);
      expect(jumped.snapshot.asks).toEqual(animated.snapshot.asks);
      expect(jumped.snapshot.threads).toBe(animated.snapshot.threads);
    }
  });

  it('keeps the threads count when the model is rebuilt mid-crawl', () => {
    const reference = replayOf('tour');
    run(reference, 60);

    let model = sampleVault().model;
    const r = replayOf('tour', model);
    let frame = 0;
    run(r, 60, () => {
      if (++frame % 37 !== 0) return;
      const next = rebuild(model);
      expect(next.edges[0]).not.toBe(model.edges[0]);
      model = next;
      r.rebind(model);
      expect(r.snapshot.threads).toBe(r.view.lit.size);
    });
    expect(litKeys(r)).toEqual(litKeys(reference));
    expect(r.snapshot.threads).toBe(reference.snapshot.threads);
  });

  it('still prefers threads it walked after a rebuild', () => {
    // A diamond: a → b → d is a little longer than a → c → d, so only the
    // threads it walked can bring it home through b. A crowd of short links
    // far away keeps the typical link — and the grips' reach — small, so no
    // grip ever touches the way through c.
    const notes: Array<[string, [number, number, number]]> = [
      ['a', [0, 0, 0]],
      ['b', [28, 28, 0]],
      ['d', [56, 0, 0]],
      ['c', [28, -26, 0]],
    ];
    const links: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'd'],
      ['a', 'c'],
      ['c', 'd'],
    ];
    for (let i = 0; i < 12; i++) {
      notes.push([`p${i}`, [500 + 10 * i, 0, 0]], [`q${i}`, [500 + 10 * i, 2, 0]]);
      links.push([`p${i}`, `q${i}`]);
    }
    const nodes: InputNode[] = notes.map(([name], i) => ({
      id: `me/${name}.md`,
      path: `${name}.md`,
      title: name,
      ownerId: 'me',
      project: { id: 'me|p', label: 'P' },
      createdAt: i,
      updatedAt: i,
    }));
    const edges: InputEdge[] = links.map(([a, b]) => ({
      source: `me/${a}.md`,
      target: `me/${b}.md`,
      weight: 1,
    }));
    let model = buildGraphModel({
      nodes,
      edges,
      affinity: null,
      layers: DEFAULT_LAYERS,
      viewerId: 'me',
      vaultNames: new Map(),
      cache: new Map(),
    });
    for (const n of model.nodes) {
      const p = notes.find(([name]) => n.id === `me/${name}.md`)![1];
      Object.assign(n, { x: p[0], y: p[1], z: p[2] });
    }
    const seed = (name: string, kind: 'named' | 'search'): CrawlResult['notes'][number] => ({
      path: `${name}.md`,
      title: name,
      isDecision: false,
      via: kind === 'named' ? { kind, text: name, count: 1 } : { kind, term: name, rank: 0 },
    });
    const result: CrawlResult = {
      notes: [seed('a', 'named'), seed('b', 'search'), seed('d', 'search'), seed('a', 'named')],
      unresolved: [],
      coverage: { resolved: 3, total: 3 },
    };
    const viaC = [
      threadKey({ id: 'me/a.md' }, { id: 'me/c.md' }),
      threadKey({ id: 'me/c.md' }, { id: 'me/d.md' }),
    ];

    const r = new CrawlReplay(() => {});
    r.load(result, model);
    let rebuilt = false;
    const legs: string[][] = [];
    run(r, 60, (events) => {
      for (const e of events) {
        if (e.kind === 'begin' && r.view.walk?.segments.length) {
          legs.push(r.view.walk.segments.map((s) => s.toId));
        }
        // Rebuilt while it reads d, before it heads home.
        if (e.kind === 'arrive' && e.nodeId === 'me/d.md' && !rebuilt) {
          model = rebuild(model);
          r.rebind(model);
          rebuilt = true;
        }
      }
    });
    expect(rebuilt).toBe(true);
    expect(legs.at(-1)).toEqual(['me/b.md', 'me/a.md']);
    for (const key of viaC) expect(r.view.lit.has(key)).toBe(false);
  });

  it('crosses a gap between unlinked notes in the time silk took, lighting nothing on the way', () => {
    const { model, crawls } = sampleVault();
    const unit = typicalLink(model);
    const r = new CrawlReplay(() => {});
    r.load(crawls.gap, model);
    const seen: {
      crossing?: { start: number; duration: number; lit: string[]; to: string };
      arrived?: number;
      grips: number;
      contacts: Array<{ clock: number; nodeId: string }>;
    } = { grips: 0, contacts: [] };
    run(r, 60, (events) => {
      for (const e of events) {
        if (e.kind === 'begin' && r.view.walk?.void) {
          const seg = r.view.walk.segments[0]!;
          const from = model.nodes.find((n) => n.id === seg.fromId)!;
          const to = model.nodes.find((n) => n.id === seg.toId)!;
          // The silk the trail spins: same length, same speed rule as before.
          const silk = segmentLength({ from, to, edge: null }, unit);
          expect(r.view.walk.total).toBeCloseTo(silk, 9);
          expect(r.view.walk.duration).toBeCloseTo(silk / Math.max(unit * 4.5, silk / 3.4), 9);
          seen.crossing = {
            start: e.clock,
            duration: r.view.walk.duration,
            lit: litKeys(r),
            to: to.id,
          };
        }
        if (!seen.crossing || seen.arrived !== undefined) continue;
        if (e.kind === 'grip') seen.grips++;
        if (e.kind === 'contact') seen.contacts.push(e);
        if (e.kind === 'arrive') {
          seen.arrived = e.clock;
          expect(litKeys(r)).toEqual(seen.crossing.lit);
        }
      }
      // Setting out across the void, it lets go of the threads it held.
      if (seen.crossing && seen.arrived === undefined && r.view.walk && r.view.walk.t > 0.5) {
        expect(r.view.holds.every((h) => h === null)).toBe(true);
      }
    });
    const { crossing, arrived } = seen;
    expect(crossing).toBeDefined();
    expect(arrived).toBeDefined();
    expect(arrived! - crossing!.start).toBeGreaterThanOrEqual(crossing!.duration - 1e-9);
    expect(arrived! - crossing!.start).toBeLessThan(crossing!.duration + 1 / 60 + 1e-9);
    expect(seen.grips).toBe(0);
    expect(seen.contacts).toHaveLength(1);
    expect(seen.contacts[0]!.nodeId).toBe(crossing!.to);
    expect(seen.contacts[0]!.clock - crossing!.start).toBeGreaterThanOrEqual(
      0.2 * crossing!.duration,
    );
  });

  it('keeps the reach timings the panel shows', () => {
    const dt = 1 / 240;
    const r = replayOf('walk');
    const arrivals: number[] = [];
    const begins: number[] = [];
    const found: number[][] = [];
    run(r, 240, (events) => {
      for (const e of events) {
        if (e.kind === 'arrive') {
          arrivals.push(e.clock);
          found.push([]);
        }
        if (e.kind === 'begin') begins.push(e.clock);
        if (e.kind === 'found') found.at(-1)!.push(e.clock - arrivals.at(-1)!);
      }
    });
    // Named start, then the search hit, then three links out of the start.
    expect(found.map((f) => f.length)).toEqual([1, 1, 3]);
    const reaches = [1, 1, 3];
    reaches.forEach((n, step) => {
      found[step]!.forEach((t, i) => {
        expect(t).toBeGreaterThanOrEqual(0.1 + 0.33 * i + 0.4 - 1e-9);
        expect(t).toBeLessThan(0.1 + 0.33 * i + 0.4 + dt + 1e-9);
      });
      // Each dwell lasts 0.9 s plus 0.35 s a reach, then the next step begins.
      const dwell = begins[step + 1]! - arrivals[step]!;
      expect(dwell).toBeGreaterThanOrEqual(0.9 + 0.35 * n - 1e-9);
      expect(dwell).toBeLessThan(0.9 + 0.35 * n + dt + 1e-9);
    });

    const ask = replayOf('ask');
    const reachStarts: number[][] = [];
    run(ask, 240, (events) => {
      for (const e of events) {
        if (e.kind === 'arrive') reachStarts.push(ask.view.reaches.map((x) => x.start - e.clock));
      }
    });
    // The named note, then the reference nobody wrote, then the one two notes could mean.
    expect(reachStarts[1]).toHaveLength(1);
    expect(reachStarts[1]![0]).toBeCloseTo(0.1, 9);
    expect(reachStarts[2]![0]).toBeCloseTo(0.1, 9);
    expect(reachStarts[2]![1]).toBeCloseTo(0.4, 9);
  });

  it('lights about as many threads as the legged spider did, and at least every thread it walked', () => {
    const r = replayOf('walk');
    const walked = new Set<string>();
    run(r, 60, () => {
      for (const s of r.view.walk?.segments ?? []) if (s.key) walked.add(s.key);
    });
    for (const key of walked) expect(r.view.lit.has(key)).toBe(true);
    expect(r.view.lit.size).toBeGreaterThanOrEqual(LEGGED_SPIDER_LIT * 0.75);
    expect(r.view.lit.size).toBeLessThanOrEqual(LEGGED_SPIDER_LIT * 1.5);
  });

  it('reaches into the void away from the vault, wherever the vault sits', () => {
    const askInto = (shift: [number, number, number]) => {
      const { model, crawls } = sampleVault();
      for (const n of model.nodes) {
        n.x += shift[0];
        n.y += shift[1];
        n.z += shift[2];
      }
      const r = new CrawlReplay(() => {});
      r.load(crawls.ask, model);
      run(r, 60);
      const label = r.labels.find((l) => l.text.startsWith('? the Q3 roadmap'))!;
      const here = model.nodes.find((n) => n.id === r.view.hereId)!;
      const own = model.nodes.filter((n) => n.kind === 'note' && !n.foreign);
      const centre = [0, 1, 2].map(
        (i) => own.reduce((s, n) => s + [n.x, n.y, n.z][i]!, 0) / own.length,
      );
      const out = [label.point![0] - here.x, label.point![1] - here.y, label.point![2] - here.z];
      return { out, away: [here.x - centre[0]!, here.z - centre[2]!] };
    };
    const home = askInto([0, 0, 0]);
    const far = askInto([5000, -300, 2000]);
    for (let i = 0; i < 3; i++) expect(far.out[i]).toBeCloseTo(home.out[i]!, 6);
    // Level, and away from the middle of the vault.
    expect(home.out[0]! * home.away[0]! + home.out[2]! * home.away[1]!).toBeGreaterThan(0);
  });

  it('follows the walk, lets go when the camera is taken, and frames what it found at the end', () => {
    const { model, crawls } = sampleVault();
    const unit = typicalLink(model);
    const r = new CrawlReplay(() => {});
    r.load(crawls.walk, model);
    // Past the first note's reading, out on a thread.
    const onThread = () => !!r.view.walk && r.view.walk.segments.length > 0 && r.view.walk.t > 0.2;
    for (let i = 0; i < 10_000 && !onThread(); i++) r.update(1 / 60);
    expect(onThread()).toBe(true);
    expect(r.follow()?.dist).toBeCloseTo(unit * 12, 9);
    r.onUserCamera();
    expect(r.follow()).toBeNull();
    expect(r.snapshot.following).toBe(false);
    r.followAgain();
    expect(r.snapshot.following).toBe(true);
    r.skipToEnd();
    const found = [...r.view.found.keys()].map((id) => model.nodes.find((n) => n.id === id)!);
    const c = [0, 1, 2].map(
      (i) => found.reduce((s, n) => s + [n.x, n.y, n.z][i]!, 0) / found.length,
    );
    const radius = Math.max(...found.map((n) => Math.hypot(n.x - c[0]!, n.y - c[1]!, n.z - c[2]!)));
    const f = r.follow()!;
    expect([f.x, f.y, f.z].map((v, i) => v - c[i]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);
    expect(f.dist).toBeCloseTo(radius * 3 + unit * 8, 6);
  });

  it('replays from the start the way it played the first time', () => {
    const r = replayOf('tour');
    run(r, 60);
    const first = litKeys(r);
    r.replay();
    expect(r.view.lit.size).toBe(0);
    expect(r.view.clock).toBe(0);
    run(r, 60);
    expect(litKeys(r)).toEqual(first);
  });

  it('lets go of a thread the graph stops drawing', () => {
    const { model } = sampleVault();
    const r = replayOf('walk', model);
    run(r, 60);
    // Perched on its last note, it holds threads around it; one of them goes.
    const slot = r.view.holds.findIndex((h) => h !== null);
    expect(slot).toBeGreaterThanOrEqual(0);
    const key = r.view.holds[slot]!.key;
    const [end] = threadEnds(key);
    r.rebind(model, (n) => (n.id === end ? 0 : 1));
    expect(r.view.holds[slot]).toBeNull();
    expect(r.view.holds.some((h) => h?.key === key)).toBe(false);
    expect(r.drain()).toContainEqual(expect.objectContaining({ kind: 'release', slot, key }));
  });

  it('hops to a note the layout has not placed yet, instead of walking there forever', () => {
    const { model, crawls } = sampleVault();
    // The first layout and a growth replay start every note at NaN.
    const far = model.nodes.find((n) => n.path === crawls.walk.notes[1]!.path)!;
    far.x = Number.NaN;
    const animated = new CrawlReplay(() => {});
    animated.load(crawls.walk, model);
    const events = run(animated, 60);
    expect(animated.view.mode).toBe('done');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'arrive', nodeId: far.id }));
    expect(animated.silk).toEqual([]);
    const jumped = new CrawlReplay(() => {});
    jumped.load(crawls.walk, model);
    jumped.skipToEnd();
    expect(jumped.view.mode).toBe('done');
  });

  it('sees a note fade in through the appear it is handed each frame, without a rebuild', () => {
    const { model, crawls } = sampleVault();
    const r = new CrawlReplay(() => {});
    r.load(crawls.walk, model, () => 0);
    const field = r.view.field;
    const id = model.nodes[0]!.id;
    const out: Vec3 = [0, 0, 0];
    expect(field.node(id, out)).toBe(false);
    r.setAppear(() => 1);
    expect(r.view.field).toBe(field);
    expect(field.node(id, out)).toBe(true);
  });
});

describe('walkProgress', () => {
  it('starts and stops at rest yet arrives exactly when the walk ends', () => {
    for (const duration of [0.37, 1.2, 3.4]) {
      const total = 100;
      const ramp = Math.min(0.3, duration / 4);
      const h = 1e-4;
      expect(walkProgress(0, total, duration, ramp)).toBe(0);
      expect(walkProgress(duration, total, duration, ramp)).toBe(total);
      expect(walkProgress(duration + 1, total, duration, ramp)).toBe(total);
      expect(walkProgress(h, total, duration, ramp) / h).toBeLessThan(0.01 * (total / duration));
      expect((total - walkProgress(duration - h, total, duration, ramp)) / h).toBeLessThan(
        0.01 * (total / duration),
      );
      let prev = 0;
      let prevSpeed = 0;
      for (let i = 1; i <= 1000; i++) {
        const t = (duration * i) / 1000;
        const s = walkProgress(t, total, duration, ramp);
        const speed = (s - prev) / (duration / 1000);
        expect(s).toBeGreaterThanOrEqual(prev);
        // No jump in speed: a body with weight.
        expect(Math.abs(speed - prevSpeed)).toBeLessThan(0.05 * (total / duration));
        prev = s;
        prevSpeed = speed;
      }
    }
  });
});

describe('voidProgress', () => {
  it('feels its way for the first 40 % of the time, then crosses, without a jump in speed', () => {
    for (const duration of [0.6, 1.5, 3.4]) {
      const total = 50;
      expect(voidProgress(0, total, duration)).toBe(0);
      expect(voidProgress(duration, total, duration)).toBe(total);
      expect(voidProgress(0.4 * duration, total, duration)).toBeCloseTo(0.25 * total, 9);
      let prev = 0;
      let prevSpeed = 0;
      const n = 2000;
      for (let i = 1; i <= n; i++) {
        const t = (duration * i) / n;
        const s = voidProgress(t, total, duration);
        const speed = (s - prev) / (duration / n);
        expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(Math.abs(speed - prevSpeed)).toBeLessThan(0.05 * (total / duration));
        prev = s;
        prevSpeed = speed;
      }
      // At rest at both ends.
      const h = duration * 1e-4;
      expect(voidProgress(h, total, duration) / h).toBeLessThan(0.01 * (total / duration));
      expect((total - voidProgress(duration - h, total, duration)) / h).toBeLessThan(
        0.01 * (total / duration),
      );
    }
  });
});
