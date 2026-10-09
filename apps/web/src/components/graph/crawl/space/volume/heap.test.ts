import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import { MinHeap } from './heap';

describe('MinHeap', () => {
  it('hands sites back nearest first, a tie to the smaller site, whatever order they went in', () => {
    const rnd = seededRandom(2);
    const entries = Array.from({ length: 300 }, (_, i) => [Math.floor(rnd() * 20), i] as const);
    const heap = new MinHeap(4);
    for (const [key, item] of [...entries].sort(() => rnd() - 0.5)) heap.push(key, item);
    expect(heap.size).toBe(300);
    const out: number[] = [];
    for (let item = heap.pop(); item >= 0; item = heap.pop()) out.push(item);
    const expected = [...entries]
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      .map(([, item]) => item);
    expect(out).toEqual(expected);
    expect(heap.pop()).toBe(-1);
  });
});
