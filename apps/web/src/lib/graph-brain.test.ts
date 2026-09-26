import { describe, expect, it } from 'vitest';

import { brainScaleFor, brainSDF, forceBrain, makeBrainMesh } from './graph-brain';

describe('brainSDF', () => {
  it('is negative inside the brain and positive outside it', () => {
    expect(brainSDF(0, 0, 0.3)).toBeLessThan(0);
    expect(brainSDF(-0.5, 0, 0.2)).toBeLessThan(0);
    expect(brainSDF(0.55, -0.48, 0.2)).toBeLessThan(0); // cerebellum
    expect(brainSDF(2, 0, 0)).toBeGreaterThan(0);
    expect(brainSDF(0, 1.2, 0)).toBeGreaterThan(0);
  });

  it('is symmetric across the hemispheres', () => {
    for (const [x, y, z] of [
      [0.1, 0.2, 0.3],
      [-0.4, -0.1, 0.5],
      [0.6, 0.3, 0.1],
    ]) {
      expect(brainSDF(x!, y!, z!)).toBeCloseTo(brainSDF(x!, y!, -z!), 10);
    }
  });

  it('parts the hemispheres along the top only', () => {
    expect(brainSDF(0, 0.6, 0)).toBeGreaterThan(brainSDF(0, 0.6, 0.2));
    expect(brainSDF(0, -0.2, 0)).toBeLessThan(0);
  });
});

describe('makeBrainMesh', () => {
  const mesh = makeBrainMesh(800);

  it('samples points on the surface', () => {
    expect(mesh.points.length).toBe(800 * 3);
    for (let i = 0; i < mesh.points.length; i += 3) {
      expect(Math.abs(brainSDF(mesh.points[i]!, mesh.points[i + 1]!, mesh.points[i + 2]!))).toBeLessThan(0.05);
    }
  });

  it('joins neighbours into a mesh', () => {
    expect(mesh.segments.length % 6).toBe(0);
    expect(mesh.segments.length / 6).toBeGreaterThan(400);
  });

  it('is the same on every visit', () => {
    expect(makeBrainMesh(800).points).toEqual(mesh.points);
  });
});

describe('brainScaleFor', () => {
  it('grows with the cube root of the notes, so density holds', () => {
    const r = (brainScaleFor(8000) - 60) / (brainScaleFor(1000) - 60);
    expect(r).toBeCloseTo(2, 5);
  });
});

describe('forceBrain', () => {
  it('pushes a node outside the brain back towards it, and leaves one well inside alone', () => {
    const outside = { x: 300, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const inside = { x: 0, y: 0, z: 30, vx: 0, vy: 0, vz: 0 };
    const force = forceBrain(() => 100);
    force.initialize([outside, inside]);
    force();
    expect(outside.vx).toBeLessThan(0);
    expect(inside).toMatchObject({ vx: 0, vy: 0, vz: 0 });
  });
});
