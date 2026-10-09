import { describe, expect, it } from 'vitest';

import type { GraphModel, GraphNode } from '@/lib/graph-model';

import { findWalk, walkable } from '../crawl-plan';
import { walkProgress, walkRamp } from '../crawl-replay';
import type { ReplayView } from '../replay-view';
import { sampleVault } from '../sample-vault';
import {
  graphThreadField,
  legPoint,
  segmentLength,
  threadKey,
  typicalLink,
  type LegStretch,
  type ThreadField,
} from '../threads';
import { dist, dot, len, type Vec3 } from '../vec';

import {
  bodyGoal,
  createBody,
  createGoal,
  stepBody,
  trackCursor,
  type BodyParams,
  type BodyState,
} from './body';

const PARAMS: BodyParams = {
  hover: 0.45,
  omegaPos: 12,
  omegaTurn: 7,
  bankLimit: 0.42,
  surge: 0.03,
  leadMax: 0.9,
  perchUp: 0.5,
  perchBack: 0.6,
  voidLift: 0.25,
};

function stretchesAlong(model: GraphModel, path: GraphNode[], unit: number): LegStretch[] {
  const out: LegStretch[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const edge = model.adjacency.get(from)!.find((nb) => nb.node === to && walkable(nb.edge))!.edge;
    out.push({
      fromId: from.id,
      toId: to.id,
      key: threadKey(from, to),
      length: segmentLength({ from, to, edge }, unit),
    });
  }
  return out;
}

function view(
  field: ThreadField,
  unit: number,
  segments: LegStretch[],
  travelled: number,
  t: number,
): ReplayView {
  const total = segments.reduce((s, x) => s + x.length, 0);
  return {
    mode: 'walk',
    clock: t,
    unit,
    stepIndex: 1,
    hereId: segments[0]!.fromId,
    nextId: null,
    dir: [0, 0, 1],
    walk: { segments, total, duration: 1, t, travelled, void: false },
    dwell: null,
    holds: [],
    swings: [],
    reaches: [],
    lit: new Map(),
    found: new Map(),
    history: { passages: [], reached: new Map(), foundAt: new Map(), epoch: 0 },
    field,
  };
}

interface Run {
  frames: Array<{ p: Vec3; v: Vec3; bank: number; f: Vec3; u: Vec3 }>;
  end: Vec3;
  endHeading: Vec3;
  vmax: number;
  unit: number;
}

/** Walk a leg on the replay's own profile at a fixed frame length, then hold at its end. */
function run(
  model: GraphModel,
  path: GraphNode[],
  dt: number,
  duration?: number,
  params = PARAMS,
): Run {
  const unit = typicalLink(model);
  const field = graphThreadField(model);
  const segments = stretchesAlong(model, path, unit);
  const total = segments.reduce((s, x) => s + x.length, 0);
  const D = duration ?? total / Math.max(unit * 4.5, total / 3.4);
  const b: BodyState = createBody();
  const goal = createGoal();
  const frames: Run['frames'] = [];
  for (let t = 0; t <= D + 1.2; t += dt) {
    const v = view(field, unit, segments, walkProgress(t, total, D, walkRamp(D)), t);
    trackCursor(b, v, dt);
    bodyGoal(v, b, params, goal);
    stepBody(b, goal, unit, dt, params, false);
    frames.push({ p: [...b.p], v: [...b.v], bank: b.bank, f: [...b.f], u: [...b.u] });
  }
  const end: Vec3 = [0, 0, 0];
  const endHeading: Vec3 = [0, 0, 0];
  legPoint(segments, total, field, 0, end, endHeading);
  end[1] += params.hover * unit;
  const ramp = walkRamp(D);
  return { frames, end, endHeading, vmax: total / (D - ramp), unit };
}

const byPath = (m: GraphModel, path: string) => m.nodes.find((n) => n.path === path)!;

function legs(model: GraphModel) {
  const a = byPath(model, 'Main/Ingest pipeline.md');
  const long = findWalk(model, a, byPath(model, 'Main/Changelog.md'))!;
  const short = long.slice(0, 2);
  return { short, long };
}

describe('the Sentinel’s body', () => {
  it('starts and stops at rest yet arrives on the note', () => {
    const { model } = sampleVault();
    for (const path of Object.values(legs(model))) {
      for (const dt of [1 / 144, 1 / 60, 1 / 30]) {
        const r = run(model, path, dt);
        const first = r.frames[0]!;
        const last = r.frames.at(-1)!;
        expect(len(first.v)).toBeLessThan(0.3 * r.vmax);
        expect(len(last.v)).toBeLessThan(0.02 * r.unit);
        expect(dist(last.p, r.end)).toBeLessThan(0.01 * r.unit);
      }
    }
  });

  it('never runs past the note by more than a twentieth of a unit, for any frame up to 64 ms', () => {
    const { model } = sampleVault();
    for (const path of Object.values(legs(model))) {
      for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.05, 0.064]) {
        const r = run(model, path, dt);
        let worst = -Infinity;
        for (const fr of r.frames) {
          const past: Vec3 = [fr.p[0] - r.end[0], fr.p[1] - r.end[1], fr.p[2] - r.end[2]];
          worst = Math.max(worst, dot(past, r.endHeading));
        }
        expect(worst).toBeLessThanOrEqual(0.05 * r.unit);
      }
    }
  });

  it('banks into turns and never past the limit', () => {
    const { model } = sampleVault();
    const { long } = legs(model);
    let most = 0;
    for (const dt of [1 / 60, 0.064]) {
      // Hurried to a third of its time, so every turn asks for more bank than allowed.
      const r = run(model, long, dt, 1.2);
      for (const fr of r.frames) most = Math.max(most, Math.abs(fr.bank));
    }
    expect(most).toBeGreaterThan(0.05);
    expect(most).toBeLessThanOrEqual(PARAMS.bankLimit + 1e-9);
  });

  it('keeps its heading when the thread goes straight up', () => {
    const unit = 20;
    // One thread rising straight up from a to b.
    const A: Vec3 = [0, 0, 0];
    const B: Vec3 = [0, 10 * unit, 0];
    const field: ThreadField = {
      has: () => true,
      point(_key, u, out) {
        out[0] = A[0];
        out[1] = A[1] + (B[1] - A[1]) * u;
        out[2] = A[2];
        return true;
      },
      closest: () => null,
      node(id, out) {
        const p = id === 'a' ? A : B;
        out[0] = p[0];
        out[1] = p[1];
        out[2] = p[2];
        return true;
      },
      around: () => [],
      up(_p, out) {
        out[0] = 0;
        out[1] = 1;
        out[2] = 0;
      },
    };
    const segments: LegStretch[] = [
      { fromId: 'a', toId: 'b', key: threadKey({ id: 'a' }, { id: 'b' }), length: 10 * unit },
    ];
    const b = createBody();
    const goal = createGoal();
    const D = 3;
    const yaw0: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
    for (let t = 0; t <= D; t += 1 / 60) {
      const v = view(field, unit, segments, walkProgress(t, 10 * unit, D, walkRamp(D)), t);
      v.dir = yaw0;
      trackCursor(b, v, 1 / 60);
      bodyGoal(v, b, PARAMS, goal);
      if (t === 0) goal.heading = [...yaw0];
      stepBody(b, goal, unit, 1 / 60, PARAMS, false);
      // Facing the same way round, upright, never flipped.
      const level = Math.hypot(b.f[0], b.f[2]);
      expect(Math.abs(b.f[0] / level - yaw0[0])).toBeLessThan(1e-3);
      expect(Math.abs(b.f[2] / level - yaw0[2])).toBeLessThan(1e-3);
      expect(b.u[1]).toBeGreaterThan(0.5);
      expect(Math.abs(dot(b.u, b.f))).toBeLessThan(1e-6);
    }
  });

  it('perches above and behind the note it reads, and keeps the last goal when the note is gone', () => {
    const { model } = sampleVault();
    const unit = typicalLink(model);
    const field = graphThreadField(model);
    const note = byPath(model, 'Main/Ingest pipeline.md');
    const v = view(field, unit, [{ fromId: note.id, toId: note.id, key: null, length: 1 }], 0, 0);
    v.mode = 'dwell';
    v.walk = null;
    v.dir = [1, 0, 0];
    const b = createBody();
    const goal = createGoal();
    expect(bodyGoal(v, b, PARAMS, goal)).toBe(true);
    expect(goal.p[0]).toBeCloseTo(note.x - PARAMS.perchBack * unit, 6);
    expect(goal.p[1]).toBeCloseTo(note.y + PARAMS.perchUp * unit, 6);
    stepBody(b, goal, unit, 1 / 60, PARAMS, false);
    goal.p = [Number.NaN, 0, 0];
    stepBody(b, goal, unit, 1 / 60, PARAMS, false);
    expect(b.p.every(Number.isFinite)).toBe(true);
  });
});
