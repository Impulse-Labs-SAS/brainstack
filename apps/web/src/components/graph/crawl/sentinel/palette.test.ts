import { describe, expect, it } from 'vitest';

import { SENTINEL_LINEAR, SENTINEL_PALETTE, linear } from './palette';

describe('linear', () => {
  it('turns sRGB hex into linear light', () => {
    expect(linear('#000000')).toEqual([0, 0, 0]);
    expect(linear('#ffffff')).toEqual([1, 1, 1]);
    // Mid grey is about a fifth as bright in linear light.
    for (const v of linear('#808080')) expect(v).toBeCloseTo(0.2158605, 6);
    expect(SENTINEL_LINEAR.accent).toEqual(linear(SENTINEL_PALETTE.accent));
  });
});
