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
});
