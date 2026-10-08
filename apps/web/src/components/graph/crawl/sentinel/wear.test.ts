import { describe, expect, it } from 'vitest';

import { WEAR_ROUGHNESS_MEAN, bakeWear } from './wear';

const SIZE = 128;

/** Mean absolute step between texel columns `a` and `b` of one channel, over every row. */
function columnStep(data: Uint8Array, size: number, channel: number, a: number, b: number): number {
  let sum = 0;
  for (let y = 0; y < size; y++) {
    sum += Math.abs(data[(y * size + a) * 4 + channel]! - data[(y * size + b) * 4 + channel]!);
  }
  return sum / size;
}

function rowStep(data: Uint8Array, size: number, channel: number, a: number, b: number): number {
  let sum = 0;
  for (let x = 0; x < size; x++) {
    sum += Math.abs(data[(a * size + x) * 4 + channel]! - data[(b * size + x) * 4 + channel]!);
  }
  return sum / size;
}

/** The typical step between neighbouring columns (or rows) inside the texture. */
function interiorStep(
  data: Uint8Array,
  size: number,
  channel: number,
  step: typeof columnStep,
): number {
  let sum = 0;
  for (let i = 0; i < size - 1; i++) sum += step(data, size, channel, i, i + 1);
  return sum / (size - 1);
}

describe('bakeWear', () => {
  it('bakes the same textures for the same seed', () => {
    const same = (x: Uint8Array, y: Uint8Array) => Buffer.from(x).equals(Buffer.from(y));
    const a = bakeWear(SIZE, 3);
    const b = bakeWear(SIZE, 3);
    expect(same(a.orm, b.orm)).toBe(true);
    expect(same(a.normal, b.normal)).toBe(true);
    expect(same(bakeWear(SIZE, 4).orm, a.orm)).toBe(false);
  });

  it('tiles: the last column and row run on into the first like any two neighbours', () => {
    const { orm, normal } = bakeWear(SIZE, 11);
    for (const [data, channels] of [
      [orm, [0, 1, 2, 3]],
      [normal, [0, 1]],
    ] as const) {
      for (const c of channels) {
        const across = columnStep(data, SIZE, c, SIZE - 1, 0);
        const down = rowStep(data, SIZE, c, SIZE - 1, 0);
        expect(across).toBeLessThan(interiorStep(data, SIZE, c, columnStep) * 1.6 + 0.5);
        expect(down).toBeLessThan(interiorStep(data, SIZE, c, rowStep) * 1.6 + 0.5);
      }
    }
  });

  it('keeps every channel in the range its shader expects', () => {
    const { orm, normal } = bakeWear(SIZE, 5);
    let roughness = 0;
    let minCavity = 255;
    let minMetal = 255;
    let wearLow = 0;
    let wearHigh = 0;
    let minNormalZ = 255;
    let opaque = true;
    for (let k = 0; k < SIZE * SIZE; k++) {
      minCavity = Math.min(minCavity, orm[k * 4]!);
      roughness += orm[k * 4 + 1]!;
      minMetal = Math.min(minMetal, orm[k * 4 + 2]!);
      if (orm[k * 4 + 3]! < 64) wearLow++;
      if (orm[k * 4 + 3]! > 160) wearHigh++;
      minNormalZ = Math.min(minNormalZ, normal[k * 4 + 2]!);
      opaque &&= normal[k * 4 + 3] === 255;
    }
    // Normals lean, but never face into the surface.
    expect(minNormalZ).toBeGreaterThan(160);
    expect(opaque).toBe(true);
    // Pits darken; nothing goes black.
    expect(minCavity).toBeGreaterThan(255 * 0.2);
    expect(minMetal).toBeGreaterThan(255 * 0.55);
    expect(roughness / (SIZE * SIZE) / 255).toBeCloseTo(WEAR_ROUGHNESS_MEAN, 1);
    // The wear mask has both clean and worn areas to pick from.
    expect(wearLow).toBeGreaterThan(SIZE * SIZE * 0.02);
    expect(wearHigh).toBeGreaterThan(SIZE * SIZE * 0.02);
  });
});
