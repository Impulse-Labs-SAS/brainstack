import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { findWalk, walkable, type CrawlResult } from '../crawl-plan';
import { CrawlReplay, walkProgress, walkRamp } from '../crawl-replay';
import type { Hold, Lit, Reach, ReplayEvent, ReplayView, Swing, WalkLeg } from '../replay-view';
import { sampleVault } from '../sample-vault';
import { polylineThreadField, type PolylineField } from '../space/polyline-field';
import {
  graphThreadField,
  legPoint,
  segmentLength,
  threadEnds,
  threadKey,
  typicalLink,
  type LegStretch,
  type ThreadField,
  type ThreadKey,
} from '../threads';
import { dist, dot, len, type Vec3 } from '../vec';

import { GRIP_SLOTS, SLOT_TENTACLE, TENTACLES, TENTACLE_SPECS } from './anatomy';
import { DEFAULT_MOTION, SentinelMotion } from './motion';
import { segmentsAt, TIER_ORDER } from './tiers';

interface Frame {
  view: ReplayView;
  events: ReplayEvent[];
}

const byPath = (m: GraphModel, path: string) => m.nodes.find((n) => n.path === path)!;

/**
 * A replay of a tour of the sample vault, written out by hand rather than by
 * the real replay: a pause reading the first note, a walk along threads with
 * grips swinging from slot to slot, a pause reaching for two links, a
 * crossing of the void to the island, an ask into the void, and the end.
 */
function tour(dt: number): { frames: Frame[]; unit: number; field: ThreadField } {
  const { model } = sampleVault();
  const field = graphThreadField(model);
  const unit = typicalLink(model);
  const a = byPath(model, 'Main/Ingest pipeline.md');
  const b = byPath(model, 'Main/Changelog.md');
  const island = byPath(model, 'Island/Field notes.md');
  const path = findWalk(model, a, b)!;
  const along: LegStretch[] = path.slice(1).map((to, i) => {
    const from = path[i]!;
    const edge = model.adjacency.get(from)!.find((nb) => nb.node === to && walkable(nb.edge))!.edge;
    return {
      fromId: from.id,
      toId: to.id,
      key: threadKey(from, to),
      length: segmentLength({ from, to, edge }, unit),
    };
  });
  const across: LegStretch[] = [
    {
      fromId: b.id,
      toId: island.id,
      key: null,
      length: segmentLength({ from: b, to: island, edge: null }, unit),
    },
  ];
  const linkedFrom = (id: string) =>
    model.adjacency
      .get(model.nodes.find((n) => n.id === id)!)!
      .filter((nb) => walkable(nb.edge))
      .slice(0, 2)
      .map((nb) => nb.node.id);

  const frames: Frame[] = [];
  const lit = new Map<ThreadKey, Lit>();
  const found = new Map<string, 'named' | 'linked' | 'decision'>();
  const holds: (Hold | null)[] = GRIP_SLOTS.map(() => null);
  let swings: Swing[] = [];
  let clock = 0;
  let dir: Vec3 = [1, 0, 0];

  const emit = (
    mode: ReplayView['mode'],
    stepIndex: number,
    hereId: string,
    nextId: string | null,
    walk: WalkLeg | null,
    dwell: ReplayView['dwell'],
    reaches: Reach[],
    events: ReplayEvent[],
  ) => {
    for (const l of lit.values()) l.glow = Math.max(l.floor, l.glow - 0.9 * dt);
    frames.push({
      view: {
        mode,
        clock,
        unit,
        stepIndex,
        hereId,
        nextId,
        dir: [...dir],
        walk: walk ? { ...walk } : null,
        dwell: dwell ? { ...dwell } : null,
        holds: holds.map((h) => (h ? { ...h } : null)),
        swings: swings.map((s) => ({ ...s })),
        reaches: reaches.map((r) => ({ ...r })),
        lit: new Map([...lit].map(([k, l]) => [k, { ...l }])),
        found: new Map(found),
        history: { passages: [], reached: new Map(), foundAt: new Map(), epoch: 0 },
        field,
      },
      events,
    });
    clock += dt;
  };

  const pause = (
    stepIndex: number,
    hereId: string,
    nextId: string | null,
    duration: number,
    reaches: Reach[],
  ) => {
    for (let t = 0; t <= duration; t += dt) {
      const events: ReplayEvent[] = [];
      for (const r of reaches) {
        if (!r.reached && clock >= r.start + 0.4) {
          r.reached = true;
          if (r.nodeId && r.kind !== 'ask') {
            found.set(r.nodeId, r.kind);
            events.push({ kind: 'found', clock, nodeId: r.nodeId, reachKind: r.kind });
          }
        }
      }
      emit('dwell', stepIndex, hereId, nextId, null, { t, duration }, reaches, events);
    }
  };

  const walk = (stepIndex: number, segments: LegStretch[], isVoid: boolean) => {
    const total = segments.reduce((s, x) => s + x.length, 0);
    const duration = total / Math.max(unit * 4.5, total / 3.4);
    const hereId = segments[0]!.fromId;
    let nextGrip = 0.33 * unit;
    let order = 0;
    let contact = false;
    const begin: ReplayEvent[] = [{ kind: 'begin', clock, stepIndex, nextId: null }];
    if (isVoid) {
      holds.forEach((h, slot) => {
        if (h) begin.push({ kind: 'release', clock, slot, key: h.key });
        holds[slot] = null;
      });
    }
    for (let t = 0; t <= duration + 1e-9; t += dt) {
      const travelled = walkProgress(t, total, duration, walkRamp(duration));
      const events: ReplayEvent[] = t === 0 ? begin : [];
      const p: Vec3 = [0, 0, 0];
      const heading: Vec3 = [...dir];
      legPoint(segments, travelled, field, -0.25 * unit, p, heading);
      dir = heading;
      // Land swings that are due.
      swings = swings.filter((sw) => {
        if (clock < sw.land) return true;
        holds[sw.slot] = sw.to;
        if (sw.to) {
          const l = lit.get(sw.to.key) ?? { glow: 0, floor: 0, kind: 'walk' as const };
          l.glow = Math.max(l.glow, 1.5);
          l.floor = Math.max(l.floor, 0.32);
          lit.set(sw.to.key, l);
          events.push({ kind: 'grip', clock, slot: sw.slot, key: sw.to.key, u: sw.to.u });
        }
        return false;
      });
      // Threads left behind are let go, as the real planner does.
      holds.forEach((h, slot) => {
        const at: Vec3 = [0, 0, 0];
        if (h && h.since <= clock && field.point(h.key, h.u, at) && dist(at, p) > 1.3 * unit) {
          events.push({ kind: 'release', clock, slot, key: h.key });
          holds[slot] = null;
        }
      });
      // Every third of a unit, the slot furthest behind on the next side swings ahead.
      while (!isVoid && travelled >= nextGrip) {
        nextGrip += 0.33 * unit;
        const slot = [0, 3, 1, 4, 2, 5][order++ % 6]!;
        const at: Vec3 = [0, 0, 0];
        legPoint(segments, Math.min(total, travelled + 0.6 * unit), field, 0, at);
        const ids = segments.flatMap((s) => [s.fromId, s.toId]);
        let best: Hold | null = null;
        let bestD = 0.9 * unit;
        for (const key of field.around(ids, 1, 60)) {
          if (segments.some((s) => s.key === key)) continue;
          const c = field.closest(key, at, 0.08, 0.92);
          if (c && Math.sqrt(c.d2) < bestD) {
            bestD = Math.sqrt(c.d2);
            best = { key, u: c.u, since: clock + 0.12 };
          }
        }
        if (best) {
          const from = holds[slot] ?? null;
          if (from) events.push({ kind: 'release', clock, slot, key: from.key });
          holds[slot] = null;
          swings.push({ slot, from, to: best, start: clock, land: clock + 0.12 });
        }
      }
      const left = total - travelled;
      if (isVoid && !contact && left <= 2.6 * unit) {
        contact = true;
        events.push({ kind: 'contact', clock, nodeId: segments.at(-1)!.toId });
      }
      emit(
        'walk',
        stepIndex,
        hereId,
        null,
        { segments, total, duration, t, travelled, void: isVoid },
        null,
        [],
        events,
      );
    }
    swings = [];
  };

  pause(0, a.id, b.id, 1.25, [
    { nodeId: a.id, point: null, kind: 'named', start: clock + 0.1, reached: false },
  ]);
  walk(1, along, false);
  const links = linkedFrom(b.id);
  pause(
    1,
    b.id,
    island.id,
    0.9 + links.length * 0.35,
    links.map((id, i) => ({
      nodeId: id,
      point: null,
      kind: 'linked' as const,
      start: clock + 0.1 + 0.33 * i,
      reached: false,
    })),
  );
  walk(2, across, true);
  const voidPoint: Vec3 = [island.x + 3 * unit, island.y + 1.4 * unit, island.z];
  pause(2, island.id, null, 1.4, [
    { nodeId: null, point: voidPoint, kind: 'ask', start: clock + 0.1, reached: false },
  ]);
  for (let t = 0; t < 1; t += dt) {
    emit('done', 3, island.id, null, null, null, [], t === 0 ? [{ kind: 'done', clock }] : []);
  }
  return { frames, unit, field };
}

/** The first and last segments of tentacle `i`: attribute w of each segment is its tentacle. */
function firstSegment(m: SentinelMotion, i: number): number {
  for (let s = 0; s < m.pose.segments; s++) if (m.pose.segmentAttrs[s * 4 + 3] === i) return s;
  return -1;
}
function lastSegment(m: SentinelMotion, i: number): number {
  let last = -1;
  for (let s = 0; s < m.pose.segments; s++) if (m.pose.segmentAttrs[s * 4 + 3] === i) last = s;
  return last;
}

const allFinite = (a: ArrayLike<number>, n = a.length) => {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
};

describe('SentinelMotion', () => {
  it('never goes non-finite over a whole tour, at any frame length', () => {
    for (const dt of [1 / 144, 1 / 60, 0.064]) {
      const { frames } = tour(dt);
      const m = new SentinelMotion();
      m.setTier(3);
      let time = 0;
      for (const f of frames) {
        m.step(f.view, f.events, dt, (time += dt), false);
        const p = m.pose;
        expect(allFinite(p.segmentMatrices, p.segments * 16)).toBe(true);
        expect(allFinite(p.clawMatrices, p.claws * 16)).toBe(true);
        expect(allFinite(p.hull)).toBe(true);
        expect(allFinite(p.bounds)).toBe(true);
        expect(allFinite(p.eye.dir)).toBe(true);
        expect(Number.isFinite(p.eye.intensity)).toBe(true);
        expect(allFinite(m.bodyWorld)).toBe(true);
      }
    }
  });

  it('draws as many segments as its tier carries, and three claw fingers a tentacle', () => {
    const { frames } = tour(1 / 60);
    const m = new SentinelMotion();
    let time = 0;
    for (const tier of [...TIER_ORDER, 3, 1] as const) {
      m.setTier(tier);
      for (const f of frames.slice(200, 230))
        m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
      expect(m.pose.segments).toBe(segmentsAt(tier));
      expect(m.pose.claws).toBe(TENTACLES * 3);
      expect(m.debug.jointCount).toBe(segmentsAt(tier) + TENTACLES);
    }
  });

  it('keeps a held claw on its thread while it walks', () => {
    const { frames, unit, field } = tour(1 / 60);
    const m = new SentinelMotion();
    m.setTier(3);
    let time = 0;
    let checked = 0;
    let worst = 0;
    for (const f of frames) {
      m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
      if (f.view.mode !== 'walk') continue;
      f.view.holds.forEach((h, slot) => {
        // Held a while, not being re-gripped, and within the arm's reach: this
        // hand-written replay never lets go of a thread left behind.
        if (!h || f.view.clock - h.since < 0.15 || f.view.swings.some((s) => s.slot === slot))
          return;
        const at: Vec3 = [0, 0, 0];
        field.point(h.key, h.u, at);
        const i = SLOT_TENTACLE[slot]!;
        const sm = m.pose.segmentMatrices;
        const r = firstSegment(m, i) * 16;
        const root = [0, 1, 2].map((k) => m.pose.anchor[k]! + sm[r + 12 + k]! * unit) as Vec3;
        // Within reach of the shortest arm the seed can grow, fully slid out, with some slack.
        const spec = TENTACLE_SPECS[i]!;
        if (dist(root, at) > 0.95 * 0.9 * spec.length * spec.maxStretch * unit) return;
        // Where the claw is drawn: the end of its tentacle's last segment.
        const o = lastSegment(m, i) * 16;
        const world = [0, 1, 2].map(
          (k) => m.pose.anchor[k]! + (sm[o + 12 + k]! + sm[o + 4 + k]!) * unit,
        );
        worst = Math.max(worst, dist(world as Vec3, at) / unit);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(0.03);
  });

  it('sends its explorers ahead along the walk, one leading and one a beat behind', () => {
    const { frames, unit, field } = tour(1 / 60);
    const m = new SentinelMotion();
    let time = 0;
    let walking = 0;
    let along = 0;
    for (const f of frames) {
      m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
      const w = f.view.walk;
      if (f.view.mode !== 'walk' || !w || w.void || w.travelled < unit) continue;
      walking++;
      const tips = [12, 13].map(
        (i) => [0, 1, 2].map((k) => m.pose.anchor[k]! + m.debug.targets[i * 3 + k]! * unit) as Vec3,
      );
      // Distance from a tip to the walk's path between two cursors ahead.
      const near = (tip: Vec3, from: number, to: number) => {
        let best = Infinity;
        for (let n = 0; n <= 8; n++) {
          const p: Vec3 = [0, 0, 0];
          legPoint(
            w.segments,
            Math.min(w.total, w.travelled + from + ((to - from) * n) / 8),
            field,
            0,
            p,
          );
          best = Math.min(best, dist(p, tip));
        }
        return best / unit;
      };
      const leads = tips.map((t) => near(t, 1.5 * unit, 1.5 * unit));
      const first = leads[0]! < leads[1]! ? 0 : 1;
      // The leader on the thread 1.5 units ahead, within its wander; the
      // other on the thread between 0.6 and 1.5 units ahead, 0.4 off to its side.
      if (leads[first]! < 0.45 && near(tips[1 - first]!, 0.6 * unit, 1.5 * unit) < 0.8) along++;
    }
    expect(walking).toBeGreaterThan(10);
    expect(along / walking).toBeGreaterThan(0.95);
  });

  it('looks where the leading explorer reaches, not where the second one does', () => {
    const { model, crawls } = sampleVault();
    const replay = new CrawlReplay(() => {});
    replay.load(crawls.walk, model);
    const unit = replay.unit;
    const m = new SentinelMotion();
    const toLeader: number[] = [];
    const toOther: number[] = [];
    let time = 0;
    let guard = 0;
    while (replay.view.mode !== 'done' && guard++ < 20_000) {
      replay.update(1 / 60);
      const view = replay.view;
      m.step(view, replay.drain(), 1 / 60, (time += 1 / 60), false);
      const w = view.walk;
      // Out on the leg, well short of its end, where the two explorers part.
      if (!w || w.void || w.travelled < unit || w.total - w.travelled < 2 * unit) continue;
      const p = m.pose;
      const body = [0, 1, 2].map((k) => p.anchor[k]! + p.hull[12 + k]! * unit) as Vec3;
      const [a, b] = [12, 13].map((i) =>
        [0, 1, 2].map((k) => p.anchor[k]! + m.debug.targets[i * 3 + k]! * unit - body[k]!),
      ) as [Vec3, Vec3];
      const angle = (d: Vec3) =>
        Math.acos(Math.max(-1, Math.min(1, dot(d, p.eye.dir) / Math.hypot(...d))));
      // The leader reaches further along the way it walks.
      const [lead, other] = dot(a, view.dir) > dot(b, view.dir) ? [a, b] : [b, a];
      toLeader.push(angle(lead));
      toOther.push(angle(other));
    }
    const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1]!;
    expect(toLeader.length).toBeGreaterThan(20);
    // The eye springs after a target that keeps moving, so it trails it a little.
    expect(median(toLeader)).toBeLessThan((20 * Math.PI) / 180);
    expect(median(toLeader)).toBeLessThan(median(toOther));
  });

  it('lights only what holds fresh light or reaches', () => {
    const { frames } = tour(1 / 60);
    const m = new SentinelMotion();
    let time = 0;
    let lit = 0;
    for (const f of frames) {
      m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
      const glowing = new Set<number>();
      for (let s = 0; s < m.pose.segments; s++) {
        if (m.pose.segmentAttrs[s * 4]! > 0) glowing.add(m.pose.segmentAttrs[s * 4 + 3]!);
      }
      const fresh = (slot: number) => {
        const h = f.view.holds[slot];
        const l = h ? f.view.lit.get(h.key) : undefined;
        return !!l && l.glow > l.floor;
      };
      const reaching = f.view.reaches.some((r) => f.view.clock >= r.start);
      for (const i of glowing) {
        const slot = SLOT_TENTACLE.indexOf(i);
        expect(slot >= 0 ? fresh(slot) || reaching : reaching).toBe(true);
      }
      lit += glowing.size;
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('settles on the same still pose for the same view, whatever came before', () => {
    const { frames } = tour(1 / 60);
    const end = frames.at(-1)!.view;
    const fresh = new SentinelMotion();
    fresh.finalPose(end);
    const used = new SentinelMotion();
    let time = 0;
    for (const f of frames.slice(0, 400))
      used.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
    used.finalPose(end);
    expect(Array.from(used.pose.segmentMatrices)).toEqual(Array.from(fresh.pose.segmentMatrices));
    expect(Array.from(used.pose.hull)).toEqual(Array.from(fresh.pose.hull));
    expect(used.pose.eye).toEqual(fresh.pose.eye);
    // And it holds there under reduced motion: never more than a fraction of a
    // pixel a frame while the last passes settle, then not at all.
    let before = Array.from(fresh.pose.segmentMatrices);
    let moved = 0;
    for (let n = 0; n < 40; n++) {
      fresh.step(end, [], 1 / 60, n / 60, true);
      const after = Array.from(fresh.pose.segmentMatrices);
      moved = 0;
      for (let k = 0; k < after.length; k++)
        moved = Math.max(moved, Math.abs(after[k]! - before[k]!));
      expect(moved).toBeLessThan(0.005);
      before = after;
    }
    expect(moved).toBeLessThan(1e-4);
    expect(fresh.pose.eye.intensity).toBe(DEFAULT_MOTION.eyeStill);
  });

  it('steps fourteen tentacles at the richest tier in well under the frame', () => {
    const { frames } = tour(1 / 60);
    const m = new SentinelMotion();
    m.setTier(3);
    let time = 0;
    const warm = frames.slice(0, 200);
    for (const f of warm) m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
    const timed = frames.slice(200, 600);
    const start = performance.now();
    for (const f of timed) m.step(f.view, f.events, 1 / 60, (time += 1 / 60), false);
    const each = (performance.now() - start) / timed.length;
    // About a millisecond in node; generous, so a busy test machine does not fail it.
    expect(each).toBeLessThan(5);
  });

  it('keeps its claws on the threads the real replay grips, at any frame length', () => {
    const { model, crawls } = sampleVault();
    const off: number[] = [];
    for (const crawl of ['walk', 'gap', 'ask', 'tour'] as const) {
      for (const dt of [1 / 60, 0.064]) {
        const replay = new CrawlReplay(() => {});
        replay.load(crawls[crawl], model);
        const m = new SentinelMotion();
        m.setTier(3);
        let time = 0;
        let guard = 0;
        while (replay.view.mode !== 'done' && replay.view.mode !== 'idle' && guard++ < 20_000) {
          replay.update(dt);
          const view = replay.view;
          m.step(view, replay.drain(), dt, (time += dt), false);
          const p = m.pose;
          expect(allFinite(p.segmentMatrices, p.segments * 16)).toBe(true);
          expect(allFinite(p.clawMatrices, p.claws * 16)).toBe(true);
          expect(allFinite(p.hull)).toBe(true);
          view.holds.forEach((h, slot) => {
            const at: Vec3 = [0, 0, 0];
            // Landed a moment ago, so the arm has had time to settle on it.
            if (!h || view.clock - h.since < 0.15 || !view.field.point(h.key, h.u, at)) return;
            const o = lastSegment(m, SLOT_TENTACLE[slot]!) * 16;
            const sm = p.segmentMatrices;
            const claw = [0, 1, 2].map(
              (k) => p.anchor[k]! + (sm[o + 12 + k]! + sm[o + 4 + k]!) * replay.unit,
            ) as Vec3;
            off.push(dist(claw, at) / replay.unit);
          });
        }
      }
    }
    off.sort((a, b) => a - b);
    const quantile = (q: number) => off[Math.floor(q * (off.length - 1))]!;
    expect(off.length).toBeGreaterThan(1000);
    // Nearly always on its thread. What is left is a grip the body pulls past
    // the arm's reach between two of the planner's events, until the next one
    // lets it go.
    expect(quantile(0.95)).toBeLessThan(0.02);
    expect(quantile(0.99)).toBeLessThan(0.25);
  });
});

/** World units per creature unit in the spaces below, made by hand. */
const WU = 10;

const unitOf = (p: Vec3): Vec3 => {
  const l = len(p);
  return [p[0] / l, p[1] / l, p[2] / l];
};

/** Angle between two unit vectors. */
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/**
 * A space of Crawl's own by hand, with world up: a note at each of `places`
 * (by name, world units), each of `links` a thread drawn straight between its
 * notes. A name starting with `_` is an index, so its threads are structure.
 */
function handSpace(
  places: Record<string, Vec3>,
  links: Array<[string, string]>,
): { model: GraphModel; field: PolylineField } {
  const id = (s: string) => `me/${s}.md`;
  const names = Object.keys(places);
  const nodes: InputNode[] = names.map((s, i) => ({
    id: id(s),
    path: `${s}.md`,
    title: s,
    ownerId: 'me',
    project: { id: 'me|hand', label: 'Hand' },
    createdAt: i,
    updatedAt: i,
  }));
  const edges: InputEdge[] = links.map(([a, b]) => ({ source: id(a), target: id(b), weight: 1 }));
  const model = buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  const positions = new Map(names.map((s) => [id(s), places[s]!]));
  const routes = new Map<ThreadKey, Float32Array>();
  const adjacency = new Map<string, ThreadKey[]>();
  for (const e of model.edges) {
    if (!walkable(e)) continue;
    const key = threadKey(e.source, e.target);
    if (routes.has(key)) continue;
    const [first, second] = threadEnds(key);
    routes.set(key, Float32Array.from([...positions.get(first)!, ...positions.get(second)!]));
    for (const end of [first, second]) adjacency.set(end, [...(adjacency.get(end) ?? []), key]);
  }
  return { model, field: polylineThreadField({ nodes: positions, routes, adjacency, cell: WU }) };
}

const seed = (s: string, kind: 'named' | 'search'): CrawlResult['notes'][number] => ({
  path: `${s}.md`,
  title: s,
  isDecision: false,
  via: kind === 'named' ? { kind, text: s, count: 1 } : { kind, term: s, rank: 0 },
});

/** One frame of the Sentinel walking a space by hand, as the tests below read it. */
interface HandFrame {
  /** The hull's up against the world's. */
  upright: number;
  /** Radians a second the hull's up and forward turned since the last frame. */
  upTurn: number;
  forwardTurn: number;
  /** Every pose matrix, the eye's way and every joint of every tentacle. */
  finite: boolean;
}

/** Walks `crawl` over `space` at its pace, at a frame length, to the end. */
function walkHand(
  space: { model: GraphModel; field: PolylineField },
  crawl: CrawlResult,
  dt: number,
): HandFrame[] {
  const replay = new CrawlReplay(() => {});
  replay.load(crawl, space.model, { field: space.field, unit: WU, pace: 9 * WU });
  const m = new SentinelMotion();
  m.setTier(3);
  const frames: HandFrame[] = [];
  let time = 0;
  let guard = 0;
  let before: { u: Vec3; f: Vec3 } | null = null;
  while (replay.view.mode !== 'done' && guard++ < 20_000) {
    replay.update(dt);
    m.step(replay.view, replay.drain(), dt, (time += dt), false);
    const p = m.pose;
    const h = p.hull;
    const u = unitOf([h[4]!, h[5]!, h[6]!]);
    const f = unitOf([h[8]!, h[9]!, h[10]!]);
    frames.push({
      upright: u[1],
      upTurn: before ? angle(before.u, u) / dt : 0,
      forwardTurn: before ? angle(before.f, f) / dt : 0,
      finite:
        allFinite(p.segmentMatrices, p.segments * 16) &&
        allFinite(p.clawMatrices, p.claws * 16) &&
        allFinite(p.hull) &&
        allFinite(p.eye.dir) &&
        allFinite(m.bodyWorld) &&
        allFinite(m.debug.joints, m.debug.jointCount * 3),
    });
    before = { u, f };
  }
  expect(replay.view.mode).toBe('done');
  return frames;
}

const most = (frames: HandFrame[], pick: (f: HandFrame) => number) =>
  frames.reduce((m, f) => Math.max(m, pick(f)), -Infinity);
const least = (frames: HandFrame[], pick: (f: HandFrame) => number) =>
  frames.reduce((m, f) => Math.min(m, pick(f)), Infinity);

describe('SentinelMotion under world up', () => {
  it('turns round on its feet to walk straight back the way it came, under world up', () => {
    // A row of five notes 1.7 units apart along +x, sinking as it goes, so the
    // walk arrives a touch nose-down and the way back climbs at another
    // angle: the turn whose shortest way round is a pitch over the top.
    const places: Record<string, Vec3> = {};
    for (let i = 0; i < 5; i++) places[`r${i}`] = [i * 1.7 * WU, -0.02 * WU * i * i, 0];
    const links: Array<[string, string]> = [0, 1, 2, 3].map((i) => [`r${i}`, `r${i + 1}`]);
    const space = handSpace(places, links);
    const crawl: CrawlResult = {
      notes: [seed('r0', 'named'), seed('r4', 'search'), seed('r0', 'named')],
      unresolved: [],
      coverage: { resolved: 3, total: 3 },
    };
    for (const dt of [1 / 60, 0.064]) {
      const frames = walkHand(space, crawl, dt);
      expect(frames.every((f) => f.finite)).toBe(true);
      expect(least(frames, (f) => f.upright)).toBeGreaterThan(0.7);
      // A flip turns half a turn in a frame: it never turns faster than its springs let it.
      expect(most(frames, (f) => f.upTurn)).toBeLessThan(8);
      expect(most(frames, (f) => f.forwardTurn)).toBeLessThan(8);
    }
  });

  it('walks a vertical leg up and back without flipping or a NaN, eye and claws included', () => {
    // The glance at a note straight below, the explorers feeling for one
    // straight above, the perch's level back-off: everything that takes a
    // level way from a direction meets one with none.
    const space = handSpace({ _low: [0, 0, 0], high: [0, 10 * WU, 0] }, [['_low', 'high']]);
    expect(space.model.edges.some((e) => e.kind === 'structure')).toBe(true);
    const crawl: CrawlResult = {
      notes: [seed('_low', 'named'), seed('high', 'named'), seed('_low', 'named')],
      unresolved: [],
      coverage: { resolved: 3, total: 3 },
    };
    for (const dt of [1 / 60, 0.064]) {
      const frames = walkHand(space, crawl, dt);
      expect(frames.every((f) => f.finite)).toBe(true);
      expect(least(frames, (f) => f.upright)).toBeGreaterThan(0.9);
      expect(most(frames, (f) => f.upTurn)).toBeLessThan(8);
    }
  });
});
