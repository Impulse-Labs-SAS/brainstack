import { describe, expect, it } from 'vitest';

import { readBriefFormat, writeBriefFormat, type BriefFormatStore } from './brief-pref';

function memory(): BriefFormatStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const blocked: BriefFormatStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('the prompt format, per browser', () => {
  it('starts on references, and remembers full text once chosen', () => {
    const store = memory();
    expect(readBriefFormat(store)).toBe('refs');
    writeBriefFormat(store, 'full');
    expect(readBriefFormat(store)).toBe('full');
    writeBriefFormat(store, 'refs');
    expect(readBriefFormat(store)).toBe('refs');
  });

  it('reads anything else as references', () => {
    const store = memory();
    store.setItem('brainstack.graph.sentinel.brief', 'everything');
    expect(readBriefFormat(store)).toBe('refs');
  });

  it('falls back to references where storage is blocked or missing, and never throws', () => {
    expect(readBriefFormat(blocked)).toBe('refs');
    expect(readBriefFormat(null)).toBe('refs');
    expect(() => writeBriefFormat(blocked, 'full')).not.toThrow();
  });
});
