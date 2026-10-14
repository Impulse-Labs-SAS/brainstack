import { describe, expect, it } from 'vitest';

import { benchParams } from './bench-params';

describe('benchParams', () => {
  it('opens on Territories with the large vault’s own size and seed', () => {
    expect(benchParams('')).toEqual({ notes: 1600, seed: 11, view: 'territories' });
  });

  it('takes the size, seed and view it is given', () => {
    expect(benchParams('?notes=5000&seed=3&view=network')).toEqual({
      notes: 5000,
      seed: 3,
      view: 'network',
    });
  });

  it('keeps the size within what the vault can build, and ignores what it cannot read', () => {
    expect(benchParams('?notes=10').notes).toBe(60);
    expect(benchParams('?notes=999999').notes).toBe(20_000);
    expect(benchParams('?notes=lots&seed=1.5&view=sentinel')).toEqual({
      notes: 1600,
      seed: 11,
      view: 'territories',
    });
  });
});
