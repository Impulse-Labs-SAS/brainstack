import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOK, defaultLook } from './look';

describe('defaultLook', () => {
  it('gives a copy of its own each time, and never changes the shipped look', () => {
    const a = defaultLook();
    const b = defaultLook();
    a.exposure = 3;
    a.parts.plate.roughness = 0.99;
    expect(b.exposure).toBe(DEFAULT_LOOK.exposure);
    expect(b.parts.plate.roughness).toBe(DEFAULT_LOOK.parts.plate.roughness);
    expect(DEFAULT_LOOK.parts.plate.roughness).not.toBe(0.99);
    expect(Object.isFrozen(DEFAULT_LOOK.parts.plate)).toBe(true);
  });
});
