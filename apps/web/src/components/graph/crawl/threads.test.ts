import { describe, expect, it } from 'vitest';

import type { GraphModel, GraphNode } from '@/lib/graph-model';

import { sampleVault } from './sample-vault';
import {
  THREAD_CHORDS,
  closestOnEdge,
  graphThreadField,
  legPoint,
  onChords,
  onEdge,
  threadEnds,
  threadKey,
  type ThreadKey,
} from './threads';
import { dist, type Vec3 } from './vec';

const edgeOf = (m: GraphModel) => m.edges.find((e) => e.kind === 'link')!;

describe('threadKey', () => {
  it('names a thread the same way from either end', () => {
    const a = { id: 'me/a.md' };
    const b = { id: 'me/b.md' };
    expect(threadKey(a, b)).toBe(threadKey(b, a));
    expect(threadEnds(threadKey(b, a))).toEqual(['me/a.md', 'me/b.md']);
  });
});

describe('the drawn line', () => {
  it('puts its chord corners on the curve the scene draws', () => {
    const e = edgeOf(sampleVault().model);
    for (let k = 0; k <= THREAD_CHORDS; k++) {
      expect(dist(onChords(e, k / THREAD_CHORDS), onEdge(e, k / THREAD_CHORDS))).toBeLessThan(1e-9);
    }
  });

  it('finds the closest point on a thread, away from the notes at its ends', () => {
    const e = edgeOf(sampleVault().model);
    const mid = onEdge(e, 0.5);
    expect(closestOnEdge(e, mid).d2).toBeLessThan(1);
    const nearStart = onEdge(e, 0);
    const c = closestOnEdge(e, nearStart, 0.08, 0.92);
    expect(c.u).toBeCloseTo(0.08, 6);
  });
});

describe('graphThreadField', () => {
  it('measures a thread from its key’s first note, whichever way the edge points', () => {
    const { model } = sampleVault();
    const e = edgeOf(model);
    const field = graphThreadField(model);
    const key = threadKey(e.source, e.target);
    const [first] = threadEnds(key);
    const start: Vec3 = [0, 0, 0];
    field.point(key, 0, start);
    const firstNode = first === e.source.id ? e.source : e.target;
    expect(dist(start, [firstNode.x, firstNode.y, firstNode.z])).toBeLessThan(1e-6);
  });

  it('ignores threads whose notes have not appeared, or have no position', () => {
    const { model } = sampleVault();
    const e = edgeOf(model);
    const key = threadKey(e.source, e.target);
    const hidden = (n: GraphNode) => (n === e.source ? 0.3 : 1);
    expect(graphThreadField(model, hidden).has(key)).toBe(false);
    const saved = e.target.x;
    e.target.x = Number.NaN;
    expect(graphThreadField(model).has(key)).toBe(false);
    e.target.x = saved;
    expect(graphThreadField(model).has(key)).toBe(true);
  });

  it('lists the threads around a note, never more than asked', () => {
    const { model } = sampleVault();
    const field = graphThreadField(model);
    const id = model.nodes.find((n) => n.path === 'Main/Ingest pipeline.md')!.id;
    const near = field.around([id], 1, 100);
    const far = field.around([id], 2, 100);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(near.length);
    expect(field.around([id], 2, 3)).toHaveLength(3);
  });
});

describe('legPoint', () => {
  it('walks a thread from the note it leaves, and crosses the void between notes', () => {
    const { model } = sampleVault();
    const field = graphThreadField(model);
    const e = edgeOf(model);
    const key: ThreadKey = threadKey(e.source, e.target);
    const length = dist(onEdge(e, 0), onEdge(e, 1));
    const back = [{ fromId: e.target.id, toId: e.source.id, key, length }];
    const p: Vec3 = [0, 0, 0];
    expect(legPoint(back, 0, field, 0, p)).toBe(true);
    expect(dist(p, [e.target.x, e.target.y, e.target.z])).toBeLessThan(1e-6);

    const gap = [{ fromId: e.source.id, toId: e.target.id, key: null, length }];
    const sagged: Vec3 = [0, 0, 0];
    legPoint(gap, length / 2, field, 10, sagged);
    const straight: Vec3 = [0, 0, 0];
    legPoint(gap, length / 2, field, 0, straight);
    expect(straight[1] - sagged[1]).toBeCloseTo(10, 6);
  });

  it('sets out across the void from the point a stretch names, not from its note, and ends on its far note', () => {
    const { model } = sampleVault();
    const field = graphThreadField(model);
    const e = edgeOf(model);
    const far: Vec3 = [e.target.x, e.target.y, e.target.z];
    const from: Vec3 = [far[0] + 30, far[1] - 12, far[2] + 7];
    const length = dist(from, far);
    // The note it names is nowhere near: only the point counts.
    const gap = [{ fromId: e.source.id, toId: e.target.id, key: null, length, from }];
    const p: Vec3 = [0, 0, 0];
    const heading: Vec3 = [0, 0, 0];
    expect(legPoint(gap, 0, field, 0, p)).toBe(true);
    expect(dist(p, from)).toBeLessThan(1e-9);
    expect(legPoint(gap, length / 2, field, 0, p, heading)).toBe(true);
    expect(
      dist(p, [(from[0] + far[0]) / 2, (from[1] + far[1]) / 2, (from[2] + far[2]) / 2]),
    ).toBeLessThan(1e-9);
    const way: Vec3 = [
      (far[0] - from[0]) / length,
      (far[1] - from[1]) / length,
      (far[2] - from[2]) / length,
    ];
    expect(dist(heading, way)).toBeLessThan(1e-9);
    expect(legPoint(gap, length, field, 0, p)).toBe(true);
    expect(dist(p, far)).toBeLessThan(1e-6);
    // Named at the far end too, it ends there, whatever the note: and the
    // notes themselves need not be placed at all.
    const to: Vec3 = [1, 2, 3];
    const free = [
      { fromId: 'nowhere', toId: 'elsewhere', key: null, length: dist(from, to), from, to },
    ];
    expect(legPoint(free, dist(from, to), field, 0, p)).toBe(true);
    expect(dist(p, to)).toBeLessThan(1e-9);
    // A note it needs and does not name is still needed.
    expect(legPoint([{ ...free[0]!, to: undefined }], 0, field, 0, p)).toBe(false);
  });
});
