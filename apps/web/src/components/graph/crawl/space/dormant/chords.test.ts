import { describe, expect, it } from 'vitest';

import { sampleVault } from '../../sample-vault';
import type { ThreadKey } from '../../threads';
import type { Vec3 } from '../../vec';
import { polylineThreadField } from '../polyline-field';
import { volumeLayout } from '../volume/layout';

import { routeChords } from './chords';

const layout = volumeLayout(sampleVault(7).model);
const field = polylineThreadField({
  nodes: layout.positions,
  routes: layout.routes,
  adjacency: layout.adjacency,
  cell: layout.unit,
});
const chords = routeChords(layout.routes);

describe('route chords', () => {
  it('cuts every routed thread, each into the chords between its points', () => {
    expect(chords.keys).toEqual([...layout.routes.keys()]);
    chords.keys.forEach((key, t) => {
      const route = layout.routes.get(key)!;
      expect(chords.count[t]).toBe(route.length / 3 - 1);
      for (let k = 0; k < chords.count[t]!; k++) {
        const c = chords.first[t]! + k;
        expect(chords.thread[c]).toBe(t);
        // Copied point for point: the same floats the field walks.
        for (let j = 0; j < 3; j++) {
          expect(chords.a[c * 3 + j]).toBe(route[k * 3 + j]);
          expect(chords.b[c * 3 + j]).toBe(route[(k + 1) * 3 + j]);
        }
      }
    });
  });

  it('measures each thread exactly as the field does, along the chords in order', () => {
    chords.keys.forEach((key, t) => {
      expect(chords.lengths[t]).toBe(field.length(key));
      const first = chords.first[t]!;
      const last = first + chords.count[t]! - 1;
      expect(chords.s[first * 2]).toBe(0);
      expect(chords.s[last * 2 + 1]).toBe(chords.lengths[t]);
      for (let c = first; c <= last; c++) {
        expect(chords.s[c * 2 + 1]!).toBeGreaterThan(chords.s[c * 2]!);
        if (c > first) expect(chords.s[c * 2]).toBe(chords.s[c * 2 - 1]);
      }
    });
  });

  it('draws where the grips close: the field finds every chord on its thread', () => {
    for (let c = 0; c < chords.chords; c++) {
      const key = chords.keys[chords.thread[c]!]!;
      const mid: Vec3 = [0, 1, 2].map(
        (j) => (chords.a[c * 3 + j]! + chords.b[c * 3 + j]!) / 2,
      ) as Vec3;
      const hit = field.closest(key, mid)!;
      expect(hit.d2).toBeLessThan(1e-6);
      // And the length along it the chord says.
      const s = (chords.s[c * 2]! + chords.s[c * 2 + 1]!) / 2;
      expect(Math.abs(hit.u * chords.lengths[chords.thread[c]!]! - s)).toBeLessThan(1e-3);
    }
  });

  it('leaves out a route the field cannot walk, and a chord of no length', () => {
    const routes = new Map<ThreadKey, Float32Array>([
      ['a\u0000b', Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0])],
      ['a\u0000c', Float32Array.from([0, 0, 0, Number.NaN, 0, 0])],
      ['b\u0000c', Float32Array.from([0, 0, 0])],
    ]);
    const r = routeChords(routes);
    expect(r.keys).toEqual(['a\u0000b']);
    expect(r.chords).toBe(2);
    expect(Array.from(r.s)).toEqual([0, 1, 1, 2]);
    expect(r.lengths[0]).toBe(2);
  });
});
