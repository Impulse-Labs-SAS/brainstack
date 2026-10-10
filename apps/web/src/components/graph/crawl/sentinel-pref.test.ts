import { describe, expect, it } from 'vitest';

import { readSentinelPref, writeSentinelPref, type PrefStore } from './sentinel-pref';

const KEY = 'brainstack.graph.sentinel';
const OLD = 'brainstack.graph.spider';

function store(entries: Record<string, string> = {}): PrefStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('readSentinelPref', () => {
  it('is on in a browser that never chose', () => {
    const s = store();
    expect(readSentinelPref(s)).toBe(true);
    expect(s.map.size).toBe(0);
  });

  it('keeps the spider switch off, moved under the new key', () => {
    const s = store({ [OLD]: 'off' });
    expect(readSentinelPref(s)).toBe(false);
    expect(s.map.get(KEY)).toBe('off');
    expect(s.map.has(OLD)).toBe(false);
    // Read again, it is the new key that answers.
    expect(readSentinelPref(s)).toBe(false);
  });

  it('keeps the spider switch on, moved under the new key', () => {
    const s = store({ [OLD]: 'on' });
    expect(readSentinelPref(s)).toBe(true);
    expect(s.map.get(KEY)).toBe('on');
    expect(s.map.has(OLD)).toBe(false);
  });

  it('lets the new key win over an old one left behind', () => {
    const s = store({ [KEY]: 'on', [OLD]: 'off' });
    expect(readSentinelPref(s)).toBe(true);
    expect(readSentinelPref(store({ [KEY]: 'off', [OLD]: 'on' }))).toBe(false);
  });

  it('is on when the store throws, or there is none', () => {
    const blocked: PrefStore = {
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
    expect(readSentinelPref(blocked)).toBe(true);
    expect(readSentinelPref(null)).toBe(true);
    expect(() => writeSentinelPref(blocked, false)).not.toThrow();
    expect(() => writeSentinelPref(null, false)).not.toThrow();
  });

  it('reads an old choice a store will not move', () => {
    const s = store({ [OLD]: 'off' });
    const readOnly: PrefStore = {
      ...s,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readSentinelPref(readOnly)).toBe(false);
    expect(s.map.get(OLD)).toBe('off');
  });
});

describe('writeSentinelPref', () => {
  it('writes the choice under the new key, read back as written', () => {
    const s = store();
    writeSentinelPref(s, false);
    expect(s.map.get(KEY)).toBe('off');
    expect(readSentinelPref(s)).toBe(false);
    writeSentinelPref(s, true);
    expect(readSentinelPref(s)).toBe(true);
  });
});
