import { describe, expect, it } from 'vitest';

import { boundsOf, type Viewport } from '@/lib/graph-camera';
import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { findWalk, walkable, type CrawlResult } from '../crawl-plan';
import { CrawlReplay, walkProgress, walkRamp } from '../crawl-replay';
import { bezelSolid } from '../prompt/bezel-solid';
import {
  PERCH_ID,
  PERCH_RAILS,
  PERCH_RAIL_SET,
  replayPerch,
  withPerch,
} from '../prompt/perch-field';
import {
  DEFAULT_PERCH,
  perchShot,
  type BezelShape,
  type PerchKnobs,
} from '../prompt/perch-geometry';
import { defaultTimes } from '../prompt/transition';
import type { Hold, Lit, Reach, ReplayEvent, ReplayView, Swing, WalkLeg } from '../replay-view';
import { sampleVault } from '../sample-vault';
import { polylineThreadField, type PolylineField } from '../space/polyline-field';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
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
  type ThreadSolid,
} from '../threads';
import { dist, dot, len, type Vec3 } from '../vec';

import {
  BODY_SCALE,
  CLAW_FINGERS,
  EYE,
  GRIP_SLOTS,
  SLOT_TENTACLE,
  TENTACLES,
  TENTACLE_SPECS,
} from './anatomy';
import { SOLID_FIRST } from './chain';
import { clawClearance } from './landing';
import { DEFAULT_MOTION, SentinelMotion } from './motion';
import { SENTINEL_SEED, makeRig } from './rig';
import { segmentsAt, TIER_ORDER, type Tier } from './tiers';

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

/** The sample vault laid out as the dormant network lays it out, the frame round the prompt in front of it. */
function perchedCluster(
  vp: Viewport = { width: 1280, height: 800 },
  knobs: Partial<PerchKnobs> = {},
) {
  const { model, crawls } = sampleVault();
  const l = volumeLayout(model);
  const space = polylineThreadField({
    nodes: l.positions,
    routes: l.routes,
    adjacency: l.adjacency,
    cell: l.unit,
  });
  const bounds = boundsOf([...l.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
  const overview = overviewCamera(bounds, vp, 0.5, 0.3);
  const radius = notesReach(l.positions.values(), [overview.tx, overview.ty, overview.tz], l.unit);
  const width = Math.min(560, 0.8 * vp.width);
  const rect = {
    left: (vp.width - width) / 2,
    top: (vp.height - 56) / 2,
    width,
    height: 56,
    radius: 16,
  };
  const shot = perchShot({
    overview,
    vp,
    rect,
    unit: l.unit,
    radius,
    knobs: { ...DEFAULT_PERCH, ...knobs },
  })!;
  const times = defaultTimes();
  return {
    model,
    crawls,
    space,
    field: withPerch(space, shot),
    shot,
    perch: replayPerch(shot, { reach: 1, crossing: times.enter.crossing, release: 0.35 }),
    unit: l.unit,
    pace: 9 * l.unit,
    leave: times.leave.crossing,
  };
}

/** Where the lens is drawn: the hull's frame, body scale included, at the eye. */
function lensOf(m: SentinelMotion): Vec3 {
  const { hull: h, anchor, unit } = m.pose;
  const [x, y, z] = EYE.position;
  return [0, 1, 2].map(
    (i) => anchor[i]! + unit * (h[i]! * x + h[4 + i]! * y + h[8 + i]! * z + h[12 + i]!),
  ) as Vec3;
}

/** Radians between where the eye looks and the way from the lens to `at`. */
function offGaze(m: SentinelMotion, at: Vec3): number {
  const lens = lensOf(m);
  return angle(m.pose.eye.dir, unitOf([at[0] - lens[0], at[1] - lens[1], at[2] - lens[2]]));
}

describe('SentinelMotion on the frame round the prompt', () => {
  it('rests its eye on the gaze it is handed while perched, within its socket, and not while walking', () => {
    const s = perchedCluster();
    // Somewhere the socket lets it look: ahead and to its right. At the
    // defaults the viewer lies as far below as the socket turns, and so does
    // the perch's own node, so both rest the eye at the same place.
    const { body, up, heading } = s.shot.perch;
    const right = [
      up[1] * heading[2] - up[2] * heading[1],
      up[2] * heading[0] - up[0] * heading[2],
      up[0] * heading[1] - up[1] * heading[0],
    ];
    const viewer = [0, 1, 2].map(
      (k) => body[k]! + (heading[k]! * 3 + right[k]! * 1.2) * s.unit,
    ) as Vec3;
    const replay = new CrawlReplay(() => {});
    replay.rest(s.model, { field: s.field, unit: s.unit, perch: s.perch });
    const watching = new SentinelMotion();
    watching.gaze = viewer;
    const plain = new SentinelMotion();
    for (const m of [watching, plain]) m.snap(replay.view);
    let time = 0;
    const frames = (n: number, ms: SentinelMotion[]) => {
      for (let i = 0; i < n; i++) {
        replay.update(1 / 60);
        const events = replay.drain();
        time += 1 / 60;
        for (const m of ms) m.step(replay.view, events, 1 / 60, time, false);
      }
    };
    frames(120, [watching, plain]);
    expect(offGaze(watching, viewer)).toBeLessThan(0.1);
    expect(offGaze(plain, viewer)).toBeGreaterThan(0.5);
    // The socket still bounds it: never past its yaw and pitch from the hull's way.
    const h = watching.pose.hull;
    const forward = unitOf([h[8]!, h[9]!, h[10]!]);
    expect(angle(watching.pose.eye.dir, forward)).toBeLessThanOrEqual(Math.hypot(1.2, 0.9) + 1e-6);

    // Cleared, it looks where it would have: at the perch it stands on.
    watching.gaze = null;
    frames(120, [watching, plain]);
    expect(angle(watching.pose.eye.dir, plain.pose.eye.dir)).toBeLessThan(0.02);
    const node: Vec3 = [0, 0, 0];
    expect(replay.view.field.node(PERCH_ID, node)).toBe(true);
    expect(offGaze(plain, node)).toBeLessThan(offGaze(plain, viewer));

    // The still pose honours it too.
    const still = new SentinelMotion();
    still.gaze = viewer;
    still.finalPose(replay.view);
    const blind = new SentinelMotion();
    blind.finalPose(replay.view);
    expect(offGaze(still, viewer)).toBeLessThan(0.1);
    expect(offGaze(blind, viewer)).toBeGreaterThan(0.5);

    // Walking, it watches the walk, whatever it is handed.
    replay.load(s.crawls.walk, s.model, { field: s.field, unit: s.unit, perch: s.perch });
    for (const m of [watching, plain]) m.snap(replay.view);
    watching.gaze = viewer;
    let walking = 0;
    for (;;) {
      frames(1, [watching, plain]);
      if (replay.view.mode !== 'walk') break;
      expect([...watching.pose.eye.dir]).toEqual([...plain.pose.eye.dir]);
      walking++;
    }
    expect(walking).toBeGreaterThan(60);
    // Arrived, it may rest its eye on what it is handed again: the scene hands it nothing in the crawl.
    expect(replay.view.mode).toBe('dwell');
  });

  it('sets out from the frame and is called back to it without a NaN or a somersault, its claws back on the rails', () => {
    const s = perchedCluster();
    const opts = { field: s.field, unit: s.unit, pace: s.pace, perch: s.perch };
    for (const dt of [1 / 30, 1 / 144]) {
      const replay = new CrawlReplay(() => {});
      replay.rest(s.model, opts);
      const m = new SentinelMotion();
      m.setTier(3);
      m.gaze = s.shot.viewer;
      m.snap(replay.view);
      replay.load(s.crawls.tour, s.model, opts);
      m.gaze = null;
      let time = 0;
      let before: { u: Vec3; f: Vec3 } | null = null;
      let upTurn = 0;
      let forwardTurn = 0;
      // Only to and from the frame: the walk among the notes is the walk's own.
      let watch = true;
      const frame = () => {
        replay.update(dt);
        m.step(replay.view, replay.drain(), dt, (time += dt), false);
        const p = m.pose;
        expect(allFinite(p.segmentMatrices, p.segments * 16)).toBe(true);
        expect(allFinite(p.clawMatrices, p.claws * 16)).toBe(true);
        expect(allFinite(p.hull)).toBe(true);
        expect(allFinite(p.eye.dir)).toBe(true);
        expect(allFinite(m.bodyWorld)).toBe(true);
        const u = unitOf([p.hull[4]!, p.hull[5]!, p.hull[6]!]);
        const f = unitOf([p.hull[8]!, p.hull[9]!, p.hull[10]!]);
        if (before && watch) {
          upTurn = Math.max(upTurn, angle(before.u, u) / dt);
          forwardTurn = Math.max(forwardTurn, angle(before.f, f) / dt);
        }
        before = { u, f };
      };
      // Across to the cluster, and a while along the crawl.
      while (replay.view.hereId === PERCH_ID) frame();
      watch = false;
      while (time < 7) frame();
      expect(replay.recall(s.perch, s.leave)).toBe(true);
      m.gaze = s.shot.viewer;
      watch = true;
      let guard = 0;
      while (!replay.resting && guard++ < 10_000) frame();
      for (let i = 0; i < 1.5 / dt; i++) frame();
      // A flip turns half a turn in a frame: it never turns faster than its springs let it.
      expect(upTurn).toBeLessThan(8);
      expect(forwardTurn).toBeLessThan(8);
      // Back on the frame, clinging to it as before.
      const h = m.pose.hull;
      expect(dot(unitOf([h[4]!, h[5]!, h[6]!]), s.shot.perch.up)).toBeGreaterThan(0.95);
      const held = replay.view.holds.filter((x) => x !== null);
      expect(held.length).toBeGreaterThanOrEqual(5);
      const bar = bezelSolid(s.shot.bezel);
      const rig = makeRig(3, s.unit, SENTINEL_SEED, BODY_SCALE);
      replay.view.holds.forEach((hold, slot) => {
        if (!hold) return;
        expect(PERCH_RAIL_SET.has(hold.key)).toBe(true);
        const at: Vec3 = [0, 0, 0];
        expect(replay.view.field.point(hold.key, hold.u, at)).toBe(true);
        const i = SLOT_TENTACLE[slot]!;
        const o = lastSegment(m, i) * 16;
        const sm = m.pose.segmentMatrices;
        const claw = [0, 1, 2].map(
          (k) => m.pose.anchor[k]! + (sm[o + 12 + k]! + sm[o + 4 + k]!) * s.unit,
        ) as Vec3;
        // On the bar it holds — the rail is its centreline — a claw's clearance out from its surface.
        const target = targetOf(m, i);
        expect(dist(claw, target) / s.unit).toBeLessThan(5e-3);
        expect(dist(target, at) / s.unit).toBeLessThan(0.15);
        const d = bar.distance(target[0], target[1], target[2], [0, 0, 0]);
        expect(Math.abs(d - clawClearance(rig, i)) / s.unit).toBeLessThan(2e-3);
      });
    }
  });
});

/** Where the motion aims tentacle `i`'s tip, world space. */
function targetOf(m: SentinelMotion, i: number): Vec3 {
  const { anchor, unit } = m.pose;
  return [0, 1, 2].map((k) => anchor[k]! + m.debug.targets[i * 3 + k]! * unit) as Vec3;
}

/** Every drawn joint, world space. */
function jointsOf(m: SentinelMotion): Float64Array {
  const { anchor, unit } = m.pose;
  const out = new Float64Array(m.debug.jointCount * 3);
  for (let q = 0; q < out.length; q++) out[q] = anchor[q % 3]! + m.debug.joints[q]! * unit;
  return out;
}

/**
 * How restless the arms are: the RMS of every drawn joint's second difference
 * from one frame to the next, creature units, over the frames `add` counts.
 */
function jitterMeter(unit: number) {
  let a: Float64Array | null = null;
  let b: Float64Array | null = null;
  let sum = 0;
  let count = 0;
  return {
    add(J: Float64Array, counted: boolean) {
      if (counted && a && b) {
        for (let q = 0; q < J.length; q++) {
          const d = (J[q]! - 2 * a[q]! + b[q]!) / unit;
          sum += d * d;
          count++;
        }
      }
      b = a;
      a = J;
    },
    rms: () => Math.sqrt(sum / count),
  };
}

/** The rig the motion makes for a tier at the defaults: the same lengths, radii and claws. */
const rigOf = (tier: Tier, unit: number) => makeRig(tier, unit, SENTINEL_SEED, BODY_SCALE);

/**
 * The grippers the motion pins this frame, each with what it holds: a hold,
 * or a swing landed since, and no swing in flight — as `grippers` reads it.
 */
function pinnedHolds(view: ReplayView): Map<number, Hold> {
  const out = new Map<number, Hold>();
  GRIP_SLOTS.forEach((_, s) => {
    let held: Hold | null = view.holds[s] ?? null;
    let since = held ? held.since : -Infinity;
    let flying = false;
    for (const sw of view.swings) {
      if (sw.slot !== s || view.clock < sw.start) continue;
      if (view.clock < sw.land) flying = true;
      else if (sw.land >= since) {
        held = sw.to;
        since = sw.land;
      }
    }
    if (held && !flying) out.set(SLOT_TENTACLE[s]!, { ...held, since });
  });
  return out;
}

/**
 * A point in the bar's terms: `s` out from the rails' rounded rectangle, `z`
 * toward the viewer, and whether a straight run of the rails is the nearest.
 */
function sectionOf(b: BezelShape, p: ArrayLike<number>) {
  const d = [p[0]! - b.centre[0], p[1]! - b.centre[1], p[2]! - b.centre[2]];
  const along = (v: Vec3) => d[0]! * v[0] + d[1]! * v[1] + d[2]! * v[2];
  const qx = Math.abs(along(b.right)) - (b.width / 2 - b.radius);
  const qy = Math.abs(along(b.up)) - (b.height / 2 - b.radius);
  const s = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.radius;
  return { s, z: along(b.normal), straight: qx <= 0 || qy <= 0 };
}

/** Every matrix the pose draws, its hull and its eye: what two runs that must not differ are compared by. */
function drawnOf(m: SentinelMotion): number[] {
  const p = m.pose;
  return [
    ...p.segmentMatrices.subarray(0, p.segments * 16),
    ...p.clawMatrices.subarray(0, p.claws * 16),
    ...p.hull,
    ...p.eye.dir,
    p.eye.intensity,
    p.eye.aperture,
  ];
}

/** How many numbers two lists hold that are not the same, bit for bit. */
function differences(a: readonly number[], b: readonly number[]): number {
  let n = Math.abs(a.length - b.length);
  for (let k = 0; k < Math.min(a.length, b.length); k++) if (!Object.is(a[k], b[k])) n++;
  return n;
}

/** A ball far from anything: a body no arm ever comes near. */
const FAR: ThreadSolid = {
  across: 2,
  distance(x, y, z, n) {
    const d = [x - 1e6, y - 1e6, z - 1e6];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    for (let k = 0; k < 3; k++) n[k] = d[k]! / l;
    return l - 1;
  },
};

const PHONE: Viewport = { width: 375, height: 812 };
const LAPTOP: Viewport = { width: 1280, height: 800 };
const WIDE: Viewport = { width: 2560, height: 1440 };

/** The Sentinel resting on the frame of `s`, a frame at a time. */
function restOn(s: ReturnType<typeof perchedCluster>, tier: Tier, field: ThreadField = s.field) {
  const replay = new CrawlReplay(() => {});
  replay.rest(s.model, { field, unit: s.unit, perch: s.perch });
  const m = new SentinelMotion();
  m.setTier(tier);
  m.gaze = s.shot.viewer;
  m.snap(replay.view);
  let time = 0;
  return {
    replay,
    m,
    get time() {
      return time;
    },
    frame(dt: number) {
      replay.update(dt);
      m.step(replay.view, replay.drain(), dt, (time += dt), false);
    },
  };
}

describe('SentinelMotion beside threads with a body', () => {
  it('walks bit for bit as it did when no thread near it has a body', () => {
    for (const dt of [1 / 24, 1 / 60, 1 / 144]) {
      const { frames, field } = tour(dt);
      const fields: ThreadField[] = [
        field,
        { ...field, solid: () => null },
        { ...field, solid: () => FAR },
      ];
      const ms = fields.map(() => {
        const m = new SentinelMotion();
        m.setTier(3);
        return m;
      });
      let time = 0;
      let differ = 0;
      for (const f of frames) {
        time += dt;
        ms.forEach((m, k) => m.step({ ...f.view, field: fields[k]! }, f.events, dt, time, false));
        const plain = drawnOf(ms[0]!);
        for (const m of ms.slice(1)) differ += differences(plain, drawnOf(m));
      }
      const end = frames.at(-1)!.view;
      ms.forEach((m, k) => m.finalPose({ ...end, field: fields[k]! }));
      for (const m of ms.slice(1)) differ += differences(drawnOf(ms[0]!), drawnOf(m));
      expect(differ).toBe(0);
    }
  });

  it('walks the cluster bit for bit as it did with the frame in the field, the frame far off', () => {
    const s = perchedCluster();
    for (const [crawl, dt] of [
      ['walk', 1 / 144],
      ['tour', 1 / 24],
    ] as const) {
      const runs = [s.space, s.field].map((field) => {
        const replay = new CrawlReplay(() => {});
        replay.load(s.crawls[crawl], s.model, { field, unit: s.unit, pace: s.pace });
        const m = new SentinelMotion();
        m.setTier(3);
        m.snap(replay.view);
        return { replay, m };
      });
      let time = 0;
      let differ = 0;
      let frames = 0;
      while (runs[0]!.replay.view.mode !== 'done' && frames++ < 20_000) {
        time += dt;
        for (const { replay, m } of runs) {
          replay.update(dt);
          m.step(replay.view, replay.drain(), dt, time, false);
        }
        differ += differences(drawnOf(runs[0]!.m), drawnOf(runs[1]!.m));
      }
      expect(frames).toBeGreaterThan(100);
      expect(differ).toBe(0);
    }
  });

  it('rests on the frame with no joint inside the bar and every segment its length, at any lean, viewport and frame rate', () => {
    const runs: Array<[Viewport, number, number, Tier]> = [];
    for (const vp of [PHONE, LAPTOP, WIDE])
      for (const tilt of [45, 75, 90]) runs.push([vp, tilt, 60, 3]);
    runs.push([LAPTOP, 75, 24, 3], [LAPTOP, 75, 144, 3], [LAPTOP, 75, 60, 0]);
    for (const [vp, tilt, fps, tier] of runs) {
      const s = perchedCluster(vp, { tilt });
      const bar = bezelSolid(s.shot.bezel);
      const rig = rigOf(tier, s.unit);
      const at = restOn(s, tier);
      const n: Vec3 = [0, 0, 0];
      // Shares of each joint's tube out of the bar, and of each segment's length off its arm's.
      let out = Infinity;
      let length = 0;
      let finite = true;
      // Six seconds, a fidget included: the first is at 3 s.
      for (let f = 0; f < 6 * fps; f++) {
        at.frame(1 / fps);
        const J = jointsOf(at.m);
        finite &&= J.every(Number.isFinite) && allFinite(at.m.pose.clawMatrices);
        const pinned = pinnedHolds(at.replay.view);
        for (let i = 0; i < TENTACLES; i++) {
          const M = rig.segments[i]!;
          const j0 = rig.jointStart[i]!;
          const sg0 = rig.segStart[i]!;
          // A pinned claw's last segment wraps the bar.
          const last = pinned.has(i) ? M - 2 : M;
          const ratios: number[] = [];
          for (let j = 1; j <= M; j++) {
            const q = (j0 + j) * 3;
            const p = q - 3;
            const r = rig.segRadius[sg0 + j - 1]!;
            if (j >= SOLID_FIRST && j <= last) {
              out = Math.min(out, bar.distance(J[q]!, J[q + 1]!, J[q + 2]!, n) / r);
            }
            const l = Math.hypot(J[q]! - J[p]!, J[q + 1]! - J[p + 1]!, J[q + 2]! - J[p + 2]!);
            ratios.push(l / rig.segLength[sg0 + j - 1]!);
          }
          // Every segment of an arm telescopes alike: each against the arm's middle one.
          const middle = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)]!;
          for (const r of ratios) length = Math.max(length, Math.abs(r / middle - 1));
        }
      }
      const label = `${vp.width}x${vp.height} tilt ${tilt} at ${fps} fps, tier ${tier}`;
      expect(finite, label).toBe(true);
      expect(out, label).toBeGreaterThan(0.8);
      expect(length, label).toBeLessThan(0.01);
    }
  }, 60_000);

  it('rests each claw on the bar’s surface, from the side it reaches it, its talons never through it', () => {
    for (const vp of [PHONE, LAPTOP]) {
      for (const tier of [2, 3] as Tier[]) {
        const s = perchedCluster(vp);
        const b = s.shot.bezel;
        const bar = bezelSolid(b);
        const rig = rigOf(tier, s.unit);
        const at = restOn(s, tier);
        const n: Vec3 = [0, 0, 0];
        const u = s.unit;
        let tip = 0;
        let clear = 0;
        let before = Infinity;
        let through = 0;
        let held = 0;
        // Five seconds after the first fidget.
        while (at.time < 8) {
          at.frame(1 / 60);
          if (at.time < 3) continue;
          const view = at.replay.view;
          const J = jointsOf(at.m);
          const c = at.m.pose.clawMatrices;
          const anchor = at.m.pose.anchor;
          for (const [i, hold] of pinnedHolds(view)) {
            // Landed a moment ago, so the arm has had time to settle on it.
            if (view.clock - hold.since < 0.15) continue;
            held++;
            const rail = PERCH_RAILS.indexOf(hold.key);
            expect(rail).toBeGreaterThanOrEqual(0);
            const M = rig.segments[i]!;
            const q = (rig.jointStart[i]! + M) * 3;
            const target = targetOf(at.m, i);
            tip = Math.max(
              tip,
              Math.hypot(J[q]! - target[0], J[q + 1]! - target[1], J[q + 2]! - target[2]) / u,
            );
            const d = bar.distance(target[0], target[1], target[2], n);
            clear = Math.max(clear, Math.abs(d - clawClearance(rig, i)) / u);
            // The face it is reached from: the top rail's top, the bottom rail's upper edge, behind the sides.
            const sec = sectionOf(b, target);
            const on: Vec3 = [0, 0, 0];
            view.field.point(hold.key, hold.u, on);
            if (rail === 0) expect(sec.s).toBeGreaterThan(b.band / 2);
            if (rail === 2) expect(sec.s).toBeLessThan(-b.band / 2);
            if ((rail === 1 || rail === 3) && sectionOf(b, on).straight) {
              expect(sec.z).toBeLessThan(-b.thickness / 2);
            }
            // The joint before the claw: its centre at most half a tip's radius into the bar.
            const r = rig.segRadius[rig.segStart[i]! + M - 1]!;
            before = Math.min(
              before,
              (bar.distance(J[q - 3]!, J[q - 2]!, J[q - 1]!, n) + r / 2) / u,
            );
            // No talon into the bar and out again: once a point along it is in, every later one is.
            for (let k = 0; k < CLAW_FINGERS; k++) {
              const o = (i * CLAW_FINGERS + k) * 16;
              let inside = false;
              for (let step = 0; step <= 8; step++) {
                const t = step / 8;
                const x = -0.2 * t - 1.8 * t * t * t;
                const p = [0, 1, 2].map(
                  (e) => anchor[e]! + (c[o + 12 + e]! + c[o + 4 + e]! * t + c[o + e]! * x) * u,
                );
                const sd = bar.distance(p[0]!, p[1]!, p[2]!, n) / u;
                if (sd < -2e-3) inside = true;
                else if (inside && sd > 2e-3) through++;
              }
            }
          }
        }
        const label = `${vp.width}x${vp.height}, tier ${tier}`;
        expect(held, label).toBeGreaterThan(5 * 60);
        expect(tip, label).toBeLessThan(1e-3);
        expect(clear, label).toBeLessThan(2e-3);
        expect(before, label).toBeGreaterThanOrEqual(0);
        expect(through, label).toBe(0);
      }
    }
  }, 30_000);

  it('rests on the bar within 5% as calm as through it, at 24, 60 and 144 fps', () => {
    // Not "no less calm": the same rest with and without the bar differs by a
    // few per cent either way from one run to the next — fidgets land a
    // little differently — and 5% is the noise the two runs are compared at.
    const jitter = (
      s: ReturnType<typeof perchedCluster>,
      tier: Tier,
      field: ThreadField,
      fps: number,
    ) => {
      const at = restOn(s, tier, field);
      const shake = jitterMeter(s.unit);
      for (let f = 0; f < 20 * fps; f++) {
        at.frame(1 / fps);
        shake.add(jointsOf(at.m), f >= 2 * fps);
      }
      return shake.rms();
    };
    for (const [vp, tier, tilt, fps] of [
      [PHONE, 2, 75, 60],
      [PHONE, 3, 75, 60],
      [LAPTOP, 2, 75, 60],
      [LAPTOP, 3, 75, 60],
      [LAPTOP, 0, 75, 60],
      [LAPTOP, 3, 90, 60],
      [PHONE, 3, 75, 24],
      [LAPTOP, 2, 75, 24],
      [PHONE, 3, 75, 144],
      [LAPTOP, 2, 75, 144],
    ] as const) {
      const s = perchedCluster(vp, { tilt });
      // The same field with no body to it: the claws on the rails inside the bar, as before.
      const through = jitter(s, tier, { ...s.field, solid: undefined }, fps);
      const on = jitter(s, tier, s.field, fps);
      expect(
        on / through,
        `${vp.width}x${vp.height} tier ${tier} tilt ${tilt} at ${fps} fps`,
      ).toBeLessThan(1.05);
    }
  }, 180_000);

  it('comes back to the frame from a crawl as calm as through it, no arm left caught round the bar', () => {
    // Called back, it crosses the void from behind the frame and its arms
    // reach through the frame's hole; then the body rises over the top rail
    // to its perch. Held out of the bar the shortest way, arms threaded
    // through the hole stayed hooked round the top rail for seconds,
    // thrashing — every return to the prompt, many times as restless as
    // without the bar. Rested by `snap`, as every test above is, it never
    // comes in that way.
    const s = perchedCluster();
    const b = s.shot.bezel;
    const bar = bezelSolid(b);
    const rig = rigOf(3, s.unit);
    const n: Vec3 = [0, 0, 0];
    const back = (field: ThreadField, fps: number) => {
      const opts = { field, unit: s.unit, pace: s.pace, perch: s.perch };
      const replay = new CrawlReplay(() => {});
      replay.rest(s.model, opts);
      const m = new SentinelMotion();
      m.setTier(3);
      m.gaze = s.shot.viewer;
      m.snap(replay.view);
      replay.load(s.crawls.tour, s.model, opts);
      m.gaze = null;
      let time = 0;
      const frame = () => {
        replay.update(1 / fps);
        m.step(replay.view, replay.drain(), 1 / fps, (time += 1 / fps), false);
      };
      while (time < 7) frame();
      expect(replay.recall(s.perch, s.leave)).toBe(true);
      m.gaze = s.shot.viewer;
      let guard = 0;
      while (!replay.resting && guard++ < 10_000) frame();
      const rested = time;
      // Ten seconds on the frame: how restless, and in how many frames,
      // after the first second, a joint lies in the bar.
      const shake = jitterMeter(s.unit);
      let inside = 0;
      let finite = true;
      while (time < rested + 10) {
        frame();
        const J = jointsOf(m);
        finite &&= J.every(Number.isFinite);
        shake.add(J, true);
        if (time < rested + 1) continue;
        const pinned = pinnedHolds(replay.view);
        let any = false;
        for (let i = 0; i < TENTACLES && !any; i++) {
          const M = rig.segments[i]!;
          const j0 = rig.jointStart[i]!;
          for (let j = SOLID_FIRST; j <= (pinned.has(i) ? M - 2 : M) && !any; j++) {
            const q = (j0 + j) * 3;
            any = bar.distance(J[q]!, J[q + 1]!, J[q + 2]!, n) < 0;
          }
        }
        if (any) inside++;
      }
      return { jitter: shake.rms(), inside, finite };
    };
    for (const fps of [24, 60, 144]) {
      const through = back({ ...s.field, solid: undefined }, fps);
      const on = back(s.field, fps);
      expect(on.finite, `${fps} fps`).toBe(true);
      expect(on.inside, `${fps} fps`).toBe(0);
      expect(on.jitter / through.jitter, `${fps} fps`).toBeLessThan(1.2);
    }
  }, 120_000);

  it('steps at the prompt in well under the frame', () => {
    const at = restOn(perchedCluster(), 3);
    for (let f = 0; f < 200; f++) at.frame(1 / 60);
    const start = performance.now();
    for (let f = 0; f < 400; f++) at.frame(1 / 60);
    // About two milliseconds in node; generous, so a busy test machine does not fail it.
    expect((performance.now() - start) / 400).toBeLessThan(5);
  });
});
