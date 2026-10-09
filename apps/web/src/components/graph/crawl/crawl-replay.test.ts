import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { walkable, type CrawlResult } from './crawl-plan';
import {
  CrawlReplay,
  pacedDuration,
  voidProgress,
  walkProgress,
  walkRamp,
  type ReplayOptions,
} from './crawl-replay';
import type { ReplayEvent } from './replay-view';
import { sampleVault } from './sample-vault';
import { polylineThreadField, type PolylineField } from './space/polyline-field';
import {
  at,
  segmentLength,
  threadEnds,
  threadKey,
  typicalLink,
  type ThreadField,
  type ThreadKey,
} from './threads';
import { dist, type Vec3 } from './vec';

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

  it('reaches into the void away from the vault even from a note almost over its middle', () => {
    const { model, crawls } = sampleVault();
    const first = new CrawlReplay(() => {});
    first.load(crawls.ask, model);
    run(first, 60);
    // The note it asks from, put high over the middle of the others and just
    // off it: the level way from the middle is short, but it is still a way.
    const here = model.nodes.find((n) => n.id === first.view.hereId)!;
    const others = model.nodes.filter((n) => n.kind === 'note' && !n.foreign && n !== here);
    const mid = [0, 1, 2].map(
      (i) => others.reduce((s, n) => s + [n.x, n.y, n.z][i]!, 0) / others.length,
    );
    here.x = mid[0]! + 6;
    here.y = mid[1]! + 400;
    here.z = mid[2]! - 4;
    const r = new CrawlReplay(() => {});
    r.load(crawls.ask, model);
    run(r, 60);
    expect(r.view.hereId).toBe(here.id);
    const label = r.labels.find((l) => l.text.startsWith('? the Q3 roadmap'))!;
    const out = [label.point![0] - here.x, label.point![2] - here.z];
    const l = Math.hypot(out[0]!, out[1]!);
    expect(out[0]! / l).toBeCloseTo(6 / Math.hypot(6, 4), 9);
    expect(out[1]! / l).toBeCloseTo(-4 / Math.hypot(6, 4), 9);
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

/**
 * The vault as a space of its own might draw it: each note where the brain
 * has it, moved by `shift`, and each thread a pipe with one elbow — level
 * first, then straight up or down to the far note. Lines detour through
 * `detours` on the threads named there.
 */
function pipesOf(
  model: GraphModel,
  shift: Vec3 = [0, 0, 0],
  detours = new Map<ThreadKey, Vec3>(),
): PolylineField {
  const nodes = new Map<string, Vec3>();
  for (const n of model.nodes) {
    const p = at(n);
    nodes.set(n.id, [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
  }
  const routes = new Map<ThreadKey, Float32Array>();
  const adjacency = new Map<string, ThreadKey[]>();
  for (const e of model.edges) {
    if (!walkable(e)) continue;
    const key = threadKey(e.source, e.target);
    const [first, second] = threadEnds(key);
    const a = nodes.get(first)!;
    const b = nodes.get(second)!;
    const via = detours.get(key);
    const corners: Vec3[] = via ? [[a[0], via[1], a[2]], via, [b[0], via[1], b[2]]] : [];
    routes.set(key, Float32Array.from([...a, ...corners.flat(), b[0], a[1], b[2], ...b]));
    for (const id of [first, second]) adjacency.set(id, [...(adjacency.get(id) ?? []), key]);
  }
  return polylineThreadField({ nodes, routes, adjacency, cell: typicalLink(model) });
}

function pipedReplay(crawl: Crawl, opts: ReplayOptions = {}, shift?: Vec3) {
  const { model, crawls } = sampleVault();
  const field = pipesOf(model, shift);
  const r = new CrawlReplay(() => {});
  r.load(crawls[crawl], model, { field, unit: typicalLink(model), ...opts });
  return { r, model, field };
}

/** Every leg a replay walks, as it begins. */
function legsOf(r: CrawlReplay, fps = 60) {
  const legs: Array<{
    segments: LegSegmentCopy[];
    total: number;
    duration: number;
    void: boolean;
  }> = [];
  run(r, fps, (events) => {
    const w = r.view.walk;
    if (!events.some((e) => e.kind === 'begin') || !w || w.segments.length === 0) return;
    legs.push({
      segments: w.segments.map((s) => ({ ...s })),
      total: w.total,
      duration: w.duration,
      void: w.void,
    });
  });
  return legs;
}

type LegSegmentCopy = { fromId: string; toId: string; key: ThreadKey | null; length: number };

describe('CrawlReplay over a field of its own', () => {
  it('measures every stretch as the field draws it: pipes by their length, gaps straight across', () => {
    let pipes = 0;
    let gaps = 0;
    for (const crawl of CRAWLS) {
      const { r, field } = pipedReplay(crawl);
      expect(r.view.field).toBe(field);
      for (const leg of legsOf(r)) {
        let total = 0;
        for (const s of leg.segments) {
          total += s.length;
          if (s.key) {
            pipes++;
            expect(field.has(s.key)).toBe(true);
            expect(s.length).toBe(field.length(s.key));
            continue;
          }
          gaps++;
          const a: Vec3 = [0, 0, 0];
          const b: Vec3 = [0, 0, 0];
          expect(field.node(s.fromId, a) && field.node(s.toId, b)).toBe(true);
          expect(s.length).toBeCloseTo(dist(a, b), 9);
        }
        expect(leg.total).toBeCloseTo(total, 9);
      }
    }
    expect(pipes).toBeGreaterThan(10);
    expect(gaps).toBeGreaterThan(0);
  });

  it('lights the same threads at 24, 60 and 144 frames a second', () => {
    for (const crawl of CRAWLS) {
      const lit = [24, 60, 144].map((fps) => {
        const { r } = pipedReplay(crawl);
        run(r, fps);
        expect(r.snapshot.threads).toBe(r.view.lit.size);
        return { keys: litKeys(r), found: [...r.view.found].sort() };
      });
      expect(lit[0]!.keys.length).toBeGreaterThan(0);
      expect(lit[1]).toEqual(lit[0]);
      expect(lit[2]).toEqual(lit[0]);
    }
  });

  it('jumping to the end lights exactly what the animated replay lights', () => {
    for (const crawl of CRAWLS) {
      const animated = pipedReplay(crawl).r;
      run(animated, 60);
      const jumped = pipedReplay(crawl).r;
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

  it('never walks faster than the pace it is handed, and lights the same threads at any pace', () => {
    const unit = typicalLink(sampleVault().model);
    const brisk = (total: number) => Math.max(unit * 4.5, total / 3.4);
    const free = pipedReplay('tour');
    const freeLegs = legsOf(free.r);
    for (const leg of freeLegs) expect(leg.duration).toBeCloseTo(leg.total / brisk(leg.total), 9);

    // The speed a leg cruises at, between easing in and easing out.
    const cruise = (leg: { total: number; duration: number }) =>
      leg.total / (leg.duration - walkRamp(leg.duration));
    // Paces that bind on short legs, where the ramps are a quarter of the
    // time each, and on long ones, where they are 0.3 s.
    for (const pace of [unit * 2, unit * 5]) {
      const slow = pipedReplay('tour', { pace });
      const slowLegs = legsOf(slow.r);
      expect(slowLegs.map((l) => l.total)).toEqual(freeLegs.map((l) => l.total));
      let bound = 0;
      slowLegs.forEach((leg, i) => {
        expect(cruise(leg)).toBeLessThanOrEqual(pace * (1 + 1e-9));
        expect(leg.duration).toBeGreaterThanOrEqual(freeLegs[i]!.duration);
        // Where the cap slows it, it cruises at the cap exactly.
        if (leg.duration > freeLegs[i]!.duration + 1e-9) {
          bound++;
          expect(cruise(leg)).toBeCloseTo(pace, 6);
        }
      });
      expect(bound).toBeGreaterThan(0);
      expect(slow.r.view.clock).toBeGreaterThan(free.r.view.clock);
      expect(litKeys(slow.r)).toEqual(litKeys(free.r));
    }

    // A pace it never reaches, or none at all, changes nothing.
    for (const opts of [{ pace: unit * 1e6 }, { pace: null }]) {
      expect(legsOf(pipedReplay('tour', opts).r)).toEqual(freeLegs);
    }
  });

  it('walks the brain as it always has when handed no field, however the options are put', () => {
    const { model, crawls } = sampleVault();
    const trace = (opts?: ReplayOptions | (() => number)) => {
      const r = new CrawlReplay(() => {});
      r.load(crawls.tour, model, opts);
      return { events: run(r, 60), lit: litKeys(r), snapshot: r.snapshot };
    };
    const plain = trace();
    for (const opts of [{}, () => 1, { appear: () => 1 }, { pace: null }, { unit: Number.NaN }]) {
      expect(trace(opts)).toEqual(plain);
    }
  });

  it('leaves what is shown to the field: appear changes nothing over it', () => {
    const { model, crawls } = sampleVault();
    const field = pipesOf(model);
    const reference = pipedReplay('walk').r;
    run(reference, 60);
    const r = new CrawlReplay(() => {});
    r.load(crawls.walk, model, { field, appear: () => 0 });
    const out: Vec3 = [0, 0, 0];
    expect(r.view.field).toBe(field);
    expect(field.node(model.nodes[0]!.id, out)).toBe(true);
    r.setAppear(() => 0);
    expect(r.view.field).toBe(field);
    run(r, 60);
    expect(litKeys(r)).toEqual(litKeys(reference));
  });

  it('keeps the field it was handed when the model is rebuilt mid-crawl', () => {
    const reference = pipedReplay('tour').r;
    run(reference, 60);

    let model = sampleVault().model;
    const field = pipesOf(model);
    const r = new CrawlReplay(() => {});
    r.load(sampleVault().crawls.tour, model, { field, unit: typicalLink(model) });
    let frame = 0;
    run(r, 60, () => {
      if (++frame % 37 !== 0) return;
      model = rebuild(model);
      r.rebind(model);
      expect(r.view.field).toBe(field);
    });
    expect(litKeys(r)).toEqual(litKeys(reference));
  });

  it("takes the way that is shortest along the field's pipes, not across the brain", () => {
    // A diamond: through c is shorter as the brain draws it, but the space
    // routes c's pipes far out of the way.
    const notes: Array<[string, Vec3]> = [
      ['a', [0, 0, 0]],
      ['b', [28, 28, 0]],
      ['c', [28, -20, 0]],
      ['d', [56, 0, 0]],
    ];
    const nodes: InputNode[] = notes.map(([name], i) => ({
      id: `me/${name}.md`,
      path: `${name}.md`,
      title: name,
      ownerId: 'me',
      project: { id: 'me|p', label: 'P' },
      createdAt: i,
      updatedAt: i,
    }));
    const edges: InputEdge[] = [
      ['a', 'b'],
      ['b', 'd'],
      ['a', 'c'],
      ['c', 'd'],
    ].map(([a, b]) => ({ source: `me/${a}.md`, target: `me/${b}.md`, weight: 1 }));
    const model = buildGraphModel({
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
      notes: [seed('a', 'named'), seed('d', 'search')],
      unresolved: [],
      coverage: { resolved: 2, total: 2 },
    };
    const way = (opts?: ReplayOptions) => {
      const r = new CrawlReplay(() => {});
      r.load(result, model, opts);
      return legsOf(r).map((leg) => leg.segments.map((s) => s.toId));
    };
    const far: Vec3 = [28, -400, 0];
    const detours = new Map([
      [threadKey({ id: 'me/a.md' }, { id: 'me/c.md' }), far],
      [threadKey({ id: 'me/c.md' }, { id: 'me/d.md' }), far],
    ]);
    expect(way()).toEqual([['me/c.md', 'me/d.md']]);
    expect(way({ field: pipesOf(model, [0, 0, 0], detours), unit: 10 })).toEqual([
      ['me/b.md', 'me/d.md'],
    ]);
  });

  it('follows and frames the notes where the space puts them, not where the brain does', () => {
    const shift: Vec3 = [5000, -300, 2000];
    const { r, field } = pipedReplay('walk', {}, shift);
    const unit = r.unit;
    let followed = 0;
    run(r, 60, () => {
      const f = r.follow();
      if (!f || r.view.mode !== 'walk') return;
      // On the pipe it walks, where the space is: the brain sits around the origin.
      expect(f.x).toBeGreaterThan(4000);
      expect(f.z).toBeGreaterThan(1500);
      followed++;
    });
    expect(followed).toBeGreaterThan(0);
    const pts = [...r.view.found.keys()].map((id) => {
      const p: Vec3 = [0, 0, 0];
      expect(field.node(id, p)).toBe(true);
      return p;
    });
    const c = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i]!, 0) / pts.length);
    const f = r.follow()!;
    expect(Math.abs(f.x - c[0]!) + Math.abs(f.y - c[1]!) + Math.abs(f.z - c[2]!)).toBeLessThan(
      1e-6,
    );

    // A reference nothing settled hangs off the note where the space has it.
    const asked = pipedReplay('ask', {}, shift);
    run(asked.r, 60);
    const label = asked.r.labels.find((l) => l.text.startsWith('? the Q3 roadmap'))!;
    const here: Vec3 = [0, 0, 0];
    asked.field.node(asked.r.view.hereId!, here);
    expect(dist(label.point!, here)).toBeLessThan(unit * 5);
  });
});

/** A field that only says what it holds: no lengths of its own, nothing nearby. */
function bare(field: ThreadField): ThreadField {
  return {
    has: (k) => field.has(k),
    point: (k, u, out) => field.point(k, u, out),
    closest: (k, q, uMin, uMax) => field.closest(k, q, uMin, uMax),
    node: (id, out) => field.node(id, out),
    around: (ids, hops, max) => field.around(ids, hops, max),
    up: (p, out) => field.up(p, out),
  };
}

describe('CrawlReplay over a field without lengths', () => {
  it('measures each thread along the field itself', () => {
    const { model, crawls } = sampleVault();
    const pipes = pipesOf(model);
    const r = new CrawlReplay(() => {});
    r.load(crawls.walk, model, { field: bare(pipes), unit: typicalLink(model) });
    const legs = legsOf(r);
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      for (const s of leg.segments) {
        // Eight chords of a pipe with one elbow: a little short of it, never longer.
        if (!s.key) continue;
        expect(s.length).toBeLessThanOrEqual(pipes.length(s.key) + 1e-6);
        expect(s.length).toBeGreaterThan(pipes.length(s.key) * 0.85);
      }
    }
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

describe('pacedDuration', () => {
  it('lets a walk cruise at its pace and no faster, short or long', () => {
    // Short walks ease in and out over a quarter of their time each; long ones over 0.3 s.
    for (const [total, pace] of [
      [0.5, 2],
      [1.7, 2],
      [1.8, 2],
      [6, 2],
      [40, 7],
    ] as const) {
      const duration = pacedDuration(total, pace);
      const ramp = walkRamp(duration);
      let fastest = 0;
      const h = duration / 4000;
      for (let t = 0; t < duration; t += h) {
        const v =
          (walkProgress(t + h, total, duration, ramp) - walkProgress(t, total, duration, ramp)) / h;
        fastest = Math.max(fastest, v);
      }
      expect(fastest, `${total} at ${pace}`).toBeLessThanOrEqual(pace * (1 + 1e-6));
      expect(fastest, `${total} at ${pace}`).toBeGreaterThan(pace * 0.999);
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

/** The level part of `v` square to unit `up`, unit length. */
function levelOf(v: Vec3, up: Vec3): Vec3 {
  const k = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  const x = v[0] - k * up[0];
  const y = v[1] - k * up[1];
  const z = v[2] - k * up[2];
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** Where a replay's second step walks to, in its field: the first is a pause where it starts. */
function secondNote(r: CrawlReplay, field: ThreadField, crawl: Crawl): Vec3 {
  const { crawls } = sampleVault();
  const p: Vec3 = [0, 0, 0];
  expect(field.node(`me/${crawls[crawl].notes[1]!.path}`, p)).toBe(true);
  expect(r.view.hereId).not.toBe(`me/${crawls[crawl].notes[1]!.path}`);
  return p;
}

describe('CrawlReplay setting out', () => {
  it('sets out facing +z on the brain, and level toward its first note in a space of its own, even where up is +z', () => {
    // The brain faces +z as it always has: its first grips never move.
    expect([...replayOf('walk').view.dir]).toEqual([0, 0, 1]);

    // A space of its own faces the first note it walks to, level with where it stands.
    const piped = pipedReplay('walk');
    const here: Vec3 = [0, 0, 0];
    expect(piped.field.node(piped.r.view.hereId!, here)).toBe(true);
    const next = secondNote(piped.r, piped.field, 'walk');
    const dir = piped.r.view.dir;
    expect(dir[1]).toBe(0);
    const toward = levelOf([next[0] - here[0], next[1] - here[1], next[2] - here[2]], [0, 1, 0]);
    expect(dist(dir, toward)).toBeLessThan(1e-9);

    // Where up is +z itself, +z is no way to face: still the first note's way, square to it.
    const { model, crawls } = sampleVault();
    const sky: ThreadField = {
      ...pipesOf(model),
      up: (_p, o) => {
        o[0] = 0;
        o[1] = 0;
        o[2] = 1;
      },
    };
    const r = new CrawlReplay(() => {});
    r.load(crawls.walk, model, { field: sky, unit: typicalLink(model) });
    const from: Vec3 = [0, 0, 0];
    expect(sky.node(r.view.hereId!, from)).toBe(true);
    const to = secondNote(r, sky, 'walk');
    expect(Math.abs(r.view.dir[2])).toBeLessThan(1e-12);
    const level = levelOf([to[0] - from[0], to[1] - from[1], to[2] - from[2]], [0, 0, 1]);
    expect(dist(r.view.dir, level)).toBeLessThan(1e-9);
  });
});

/** A replay's history, as plain values to compare. */
const historyOf = (r: CrawlReplay) => ({
  passages: r.view.history.passages.map((p) => ({ ...p })),
  reached: [...r.view.history.reached],
  foundAt: [...r.view.history.foundAt],
});

describe("CrawlReplay's history", () => {
  const replays: Array<[string, (crawl: Crawl) => CrawlReplay]> = [
    ['the brain', (crawl) => replayOf(crawl)],
    ['a field of its own', (crawl) => pipedReplay(crawl).r],
  ];

  it('is the same at 24, 60 and 144 frames a second, and after a jump to the end', () => {
    for (const [, make] of replays) {
      let passages = 0;
      for (const crawl of CRAWLS) {
        const histories = [24, 60, 144].map((fps) => {
          const r = make(crawl);
          run(r, fps);
          return historyOf(r);
        });
        const jumped = make(crawl);
        jumped.skipToEnd();
        passages += histories[0]!.passages.length;
        expect(histories[0]!.reached.length).toBeGreaterThan(0);
        expect(histories[1]).toEqual(histories[0]);
        expect(histories[2]).toEqual(histories[0]);
        expect(historyOf(jumped)).toEqual(histories[0]);
      }
      expect(passages).toBeGreaterThan(10);
    }
  });

  it('stamps each thread it walks the way it went, in order, from the profile of each leg', () => {
    for (const [, make] of replays) {
      for (const crawl of CRAWLS) {
        const r = make(crawl);
        const legs: Array<{ begin: number; arrive?: number; stretches: LegSegmentCopy[] }> = [];
        run(r, 60, (events) => {
          for (const e of events) {
            const w = r.view.walk;
            if (e.kind === 'begin' && w && w.segments.length > 0) {
              legs.push({ begin: e.clock, stretches: w.segments.map((s) => ({ ...s })) });
            }
            if (e.kind === 'arrive' && legs.length > 0 && legs.at(-1)!.arrive === undefined) {
              legs.at(-1)!.arrive = e.clock;
            }
          }
        });
        const { passages, reached } = r.view.history;
        const walked = passages.filter((p) => p.kind === 'walk');
        // Exactly the stretches along threads, in the order and the way they were walked.
        const stretches = legs.flatMap((l) => l.stretches.filter((s) => s.key));
        expect(walked.map((p) => [p.key, p.fromId, p.toId])).toEqual(
          stretches.map((s) => [s.key, s.fromId, s.toId]),
        );
        let i = 0;
        for (const leg of legs) {
          const along = leg.stretches.filter((s) => s.key).length;
          const mine = walked.slice(i, i + along);
          i += along;
          if (along === 0) continue;
          // From the leg's start to its arrival, each stretch leaving where the next one enters.
          expect(mine[0]!.enter).toBe(leg.begin);
          expect(mine.at(-1)!.leave).toBe(leg.arrive);
          mine.forEach((p, k) => {
            expect(p.leave).toBeGreaterThan(p.enter);
            if (k > 0) expect(p.enter).toBe(mine[k - 1]!.leave);
            // Reached when it got there, unless it had been there before.
            expect(reached.get(p.toId)).toBeLessThanOrEqual(p.leave);
          });
        }
        expect(i).toBe(walked.length);
        // Order of setting out, whatever the kind.
        for (let k = 1; k < passages.length; k++) {
          expect(passages[k]!.enter).toBeGreaterThanOrEqual(passages[k - 1]!.enter);
        }
        // The note it starts on, at the start.
        const first = [...reached].sort((a, b) => a[1] - b[1])[0]!;
        expect(first[1]).toBe(0);
      }
    }
  });

  it('stamps each note found when its reach touches it, and the thread it reached along', () => {
    const r = replayOf('walk');
    const starts = new Map<string, number>();
    const foundEvents = new Map<string, number>();
    run(r, 60, (events) => {
      for (const reach of r.view.reaches) {
        if (reach.nodeId && reach.kind !== 'ask' && !starts.has(reach.nodeId)) {
          starts.set(reach.nodeId, reach.start);
        }
      }
      for (const e of events) if (e.kind === 'found') foundEvents.set(e.nodeId, e.clock);
    });
    const { foundAt, passages } = r.view.history;
    expect([...foundAt.keys()].sort()).toEqual([...r.view.found.keys()].sort());
    for (const [id, at] of foundAt) {
      expect(at).toBe(starts.get(id)! + 0.4);
      expect(foundEvents.get(id)).toBe(at);
    }
    const reachedAlong = passages.filter((p) => p.kind !== 'walk');
    // Every thread a reach lit, and nothing else: the ones it lit in the colour of why.
    expect(reachedAlong.map((p) => p.key).sort()).toEqual(
      [...r.view.lit]
        .filter(([, l]) => l.kind !== 'walk')
        .map(([key]) => key)
        .sort(),
    );
    expect(reachedAlong.length).toBeGreaterThan(0);
    for (const p of reachedAlong) {
      expect(p.kind).toBe(r.view.found.get(p.toId));
      expect(p.enter).toBe(starts.get(p.toId));
      expect(p.leave).toBe(foundAt.get(p.toId));
      expect(r.view.lit.get(p.key)?.kind).toBe(p.kind);
    }
  });

  it('lights what its grips hold, but counts only what it walked and reached along as passages', () => {
    for (const crawl of CRAWLS) {
      const r = replayOf(crawl);
      const gripped = new Set<ThreadKey>();
      run(r, 60, (events) => {
        for (const e of events) if (e.kind === 'grip') gripped.add(e.key);
      });
      const passed = new Set(r.view.history.passages.map((p) => p.key));
      for (const key of passed) expect(r.view.lit.has(key)).toBe(true);
      const onlyHeld = [...gripped].filter((k) => !passed.has(k));
      expect(onlyHeld.length).toBeGreaterThan(0);
      for (const key of onlyHeld) expect(r.view.lit.has(key)).toBe(true);
      expect(r.view.lit.size).toBeGreaterThan(passed.size);
    }
  });

  it('starts over when it replays or loads again', () => {
    const r = replayOf('tour');
    run(r, 60);
    const first = historyOf(r);
    const history = r.view.history;
    const epoch = history.epoch;
    r.replay();
    expect(r.view.history).toBe(history);
    expect(history.epoch).toBe(epoch + 1);
    expect(history.passages).toHaveLength(0);
    expect(history.foundAt.size).toBe(0);
    expect([...history.reached.values()]).toEqual([0]);
    run(r, 60);
    expect(historyOf(r)).toEqual(first);
    expect(history.epoch).toBe(epoch + 1);
    r.load(sampleVault().crawls.gap, sampleVault().model);
    expect(history.epoch).toBe(epoch + 2);
    expect(r.view.history.passages.length).toBeLessThanOrEqual(1);
    expect(r.view.history.foundAt.size).toBe(0);
  });
});
