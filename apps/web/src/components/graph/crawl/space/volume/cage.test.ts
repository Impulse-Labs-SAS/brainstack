import { describe, expect, it } from 'vitest';

import { sampleVault } from '../../sample-vault';
import type { Vec3 } from '../../vec';
import { largeVault } from '../large-vault';

import { cageLines, cageWires } from './cage';
import {
  CAGE_OUT,
  PART_HUB,
  PART_SATELLITE,
  clusterSdf,
  lobePart,
  neckPart,
  type Cluster,
} from './cluster';
import { volumeLayout } from './layout';

const clusters = new Map<string, Cluster>();
const clusterOf = (name: 'sample:7' | 'large:11'): Cluster => {
  let c = clusters.get(name);
  if (!c) {
    const model = name === 'sample:7' ? sampleVault(7).model : largeVault(11, 1600).model;
    c = volumeLayout(model).cluster;
    clusters.set(name, c);
  }
  return c;
};

const segmentsOf = (lines: Float32Array): [Vec3, Vec3][] =>
  Array.from({ length: lines.length / 6 }, (_, s) => [
    [lines[s * 6]!, lines[s * 6 + 1]!, lines[s * 6 + 2]!],
    [lines[s * 6 + 3]!, lines[s * 6 + 4]!, lines[s * 6 + 5]!],
  ]);
const distance = (u: Vec3, v: Vec3) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);

describe('cageLines', () => {
  for (const name of ['sample:7', 'large:11'] as const) {
    it(`drapes ${name}’s cage just outside its surface, part by part`, () => {
      const c = clusterOf(name);
      const a = c.spacing;
      const wires = cageWires(c);
      // Hub, lobes, necks, then the satellite.
      expect(wires.map((w) => w.part)).toEqual([
        PART_HUB,
        ...c.lobes.map((_, i) => lobePart(i)),
        ...c.necks.map((_, i) => neckPart(i)),
        PART_SATELLITE,
      ]);
      // Measured over every endpoint, then checked once.
      let off = 0;
      for (const w of wires) {
        for (const [p, q] of segmentsOf(w.lines)) {
          off = Math.max(off, Math.abs(clusterSdf(c, p) - CAGE_OUT * a));
          off = Math.max(off, Math.abs(clusterSdf(c, q) - CAGE_OUT * a));
        }
      }
      expect(off).toBeLessThanOrEqual(0.1 * a);

      const bulbs = [c.hub, ...c.lobes, c.satellite!];
      const bulbWires = [wires[0]!, ...wires.slice(1, 1 + c.lobes.length), wires.at(-1)!];
      bulbWires.forEach((w, i) => {
        const b = bulbs[i]!;
        const segments = segmentsOf(w.lines);
        // The hub and the big bulbs get the split icosahedron (120 edges), the
        // rest the icosahedron (30): a few corners where a neck joins may go.
        const fine = w.part === PART_HUB || (w.part !== PART_SATELLITE && b.radius >= 3 * a);
        expect(segments.length).toBeGreaterThanOrEqual(fine ? 80 : 20);
        expect(segments.length).toBeLessThanOrEqual(fine ? 120 : 30);
        const longest = Math.max(...segments.map(([p, q]) => distance(p, q)));
        expect(longest).toBeLessThanOrEqual(1.15 * (b.radius + CAGE_OUT * a));
      });
      // The satellite stands apart: its whole icosahedron.
      expect(wires.at(-1)!.lines.length / 6).toBe(30);
      if (name === 'sample:7') expect(wires[0]!.lines.length / 6).toBeGreaterThanOrEqual(100);

      for (const w of wires.slice(1 + c.lobes.length, -1)) {
        const segments = segmentsOf(w.lines);
        expect(segments.length).toBeGreaterThan(0);
        expect(Math.max(...segments.map(([p, q]) => distance(p, q)))).toBeLessThan(c.hub.radius);
      }

      const lines = cageLines(c);
      expect(lines.length).toBe(wires.reduce((sum, w) => sum + w.lines.length, 0));
      expect(lines.length % 6).toBe(0);
    });
  }

  it('gives the same cluster the same cage', () => {
    const c = clusterOf('large:11');
    expect(Array.from(cageLines(c))).toEqual(Array.from(cageLines(c)));
    expect(cageLines(c).length / 6).toBeGreaterThan(500);
  });
});
