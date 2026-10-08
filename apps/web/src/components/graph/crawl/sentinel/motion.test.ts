import { describe, expect, it } from 'vitest';

import type { GraphModel } from '@/lib/graph-model';

import { findWalk, walkable } from '../crawl-plan';
import { CrawlReplay, walkProgress, walkRamp } from '../crawl-replay';
import type { Hold, Lit, Reach, ReplayEvent, ReplayView, Swing, WalkLeg } from '../replay-view';
import { sampleVault } from '../sample-vault';
import {
  graphThreadField,
  legPoint,
  segmentLength,
  threadKey,
  typicalLink,
  type LegStretch,
  type ThreadField,
  type ThreadKey,
} from '../threads';
import { dist, dot, type Vec3 } from '../vec';

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
