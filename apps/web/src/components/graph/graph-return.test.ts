import { describe, expect, it } from 'vitest';

import {
  RETURN_KEY,
  RETURN_TRAIL_MAX,
  RETURN_TTL_MS,
  readReturn,
  writeReturn,
  type ReturnEntry,
  type ReturnStore,
} from './graph-return';

function memory(): ReturnStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const blocked: ReturnStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const cam = (dx: number) => ({ dx, dy: -12, dz: 0, yaw: 0, pitch: 0, dist: 420 });

/** Opened from Network: a note, one note and one path before it. Invented names. */
const ENTRY: ReturnEntry = {
  view: 'network',
  node: 'me/Orbit/plan.md',
  cam: cam(160),
  trail: [
    { node: 'me/Ledger/q3.md', cam: cam(150), view: 'network' },
    { path: ['me/Orbit/a.md', 'me/Orbit/b.md', 'me/Atlas/c.md'], cam: cam(40), view: 'brain' },
  ],
};

const NOW = 1_760_000_000_000;

/** What a store holds once `value` is written raw, as another version or a hand might. */
function holding(value: unknown): ReturnType<typeof memory> {
  const store = memory();
  store.setItem(RETURN_KEY, typeof value === 'string' ? value : JSON.stringify(value));
  return store;
}

describe('the way back from a note', () => {
  it('comes back as it was written, once', () => {
    const store = memory();
    writeReturn(store, ENTRY, NOW);
    expect(readReturn(store, 'network', NOW + 1000)).toEqual(ENTRY);
    expect(store.data.has(RETURN_KEY)).toBe(false);
    expect(readReturn(store, 'network', NOW + 1000)).toBeNull();
  });

  it('holds for ten minutes, and not for a clock that ran backwards', () => {
    const store = memory();
    writeReturn(store, ENTRY, NOW);
    expect(readReturn(store, 'network', NOW + RETURN_TTL_MS)).toEqual(ENTRY);
    writeReturn(store, ENTRY, NOW);
    expect(readReturn(store, 'network', NOW + RETURN_TTL_MS + 1)).toBeNull();
    writeReturn(store, ENTRY, NOW);
    expect(readReturn(store, 'network', NOW - 1)).toBeNull();
  });

  it('is for the view it was left in only, and goes when another view comes up', () => {
    const store = memory();
    writeReturn(store, ENTRY, NOW);
    expect(readReturn(store, 'territories', NOW)).toBeNull();
    expect(store.data.has(RETURN_KEY)).toBe(false);
  });

  it('takes nothing that is not JSON, or not this version', () => {
    expect(readReturn(holding('{"v":1,'), 'network', NOW)).toBeNull();
    const written = { ...ENTRY, v: 1, at: NOW };
    expect(readReturn(holding(written), 'network', NOW)).toEqual(ENTRY);
    expect(readReturn(holding({ ...written, v: 2 }), 'network', NOW)).toBeNull();
    expect(readReturn(holding({ ...ENTRY, at: NOW }), 'network', NOW)).toBeNull();
  });

  it('takes nothing whose note or camera is not one, and leaves out a step that is not', () => {
    const written = { ...ENTRY, v: 1, at: NOW };
    for (const bad of [
      { ...written, node: 7 },
      { ...written, cam: { ...cam(1), dist: 0 } },
      { ...written, cam: { ...cam(1), yaw: 'side' } },
      { ...written, trail: null },
      { ...written, at: 'now' },
      [written],
    ]) {
      expect(readReturn(holding(bad), 'network', NOW)).toBeNull();
    }
    const steps = [
      ENTRY.trail[0],
      { node: 'me/Orbit/x.md', cam: cam(1), view: 'globe' },
      { path: ['me/Orbit/a.md'], cam: cam(1), view: 'network' },
      { path: ['me/Orbit/a.md', 3], cam: cam(1), view: 'network' },
      { node: 'me/Orbit/y.md', cam: { dx: 1 }, view: 'network' },
      'me/Orbit/z.md',
      ENTRY.trail[1],
    ];
    expect(readReturn(holding({ ...written, trail: steps }), 'network', NOW)).toEqual(ENTRY);
  });

  it(`keeps the last ${RETURN_TRAIL_MAX} steps of the way back`, () => {
    const store = memory();
    const trail = Array.from({ length: 30 }, (_, i) => ({
      node: `me/Orbit/n${i}.md`,
      cam: cam(i),
      view: 'network' as const,
    }));
    writeReturn(store, { ...ENTRY, trail }, NOW);
    expect(readReturn(store, 'network', NOW)!.trail).toEqual(trail.slice(-RETURN_TRAIL_MAX));
  });

  it('keeps and reads nothing where storage is blocked or missing, and never throws', () => {
    expect(() => writeReturn(blocked, ENTRY, NOW)).not.toThrow();
    expect(readReturn(blocked, 'network', NOW)).toBeNull();
    expect(() => writeReturn(null, ENTRY, NOW)).not.toThrow();
    expect(readReturn(null, 'network', NOW)).toBeNull();
    // Read, but not removed: the entry still comes back, and the TTL ends it.
    const stuck = { ...memory(), removeItem: blocked.removeItem };
    writeReturn(stuck, ENTRY, NOW);
    expect(readReturn(stuck, 'network', NOW)).toEqual(ENTRY);
  });
});
