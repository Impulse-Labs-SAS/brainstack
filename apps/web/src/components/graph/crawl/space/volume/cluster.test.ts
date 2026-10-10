import { describe, expect, it } from 'vitest';

import { seededRandom } from '@/lib/graph-brain';

import type { Vec3 } from '../../vec';

import {
  ISLAND_GAP,
  MAX_LOBES,
  NECK_MAX,
  PART_HUB,
  PART_SATELLITE,
  SITE_INSET,
  ballRadius,
  clusterFor,
  clusterSdf,
  formDirection,
  lobeDirections,
  lobePart,
  neckPart,
  probe,
  satelliteDirection,
  type Cluster,
  type ClusterNeeds,
} from './cluster';

/** World units between sites: the layout's 1.7 creature units of 10. */
const A = 17;
/** The site needs a 1,600-note vault comes to: a hub, seven lobes, an island's satellite. */
const LARGE: ClusterNeeds = { hub: 1372, lobes: [293, 168, 123, 98, 90, 70, 58], satellite: 22 };

const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const len = (v: Vec3) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const along = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const angle = (u: Vec3, v: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v)))));
const partAt = (c: Cluster, p: Vec3) => probe(c, p[0], p[1], p[2], { d: 0, part: -1 }).part;

/** The middle of lobe `i`'s neck where it shows: half way between the hub's surface and the lobe's. */
function neckMiddle(c: Cluster, i: number): Vec3 {
  const centre = c.lobes[i]!.centre;
  const span = len(centre);
  return along(centre, (c.hub.radius + span - c.lobes[i]!.radius) / 2 / span);
}

/** Every pair of lobes clears both their radii and two blends. */
function separate(c: Cluster): boolean {
  return c.lobes.every((l, i) =>
    c.lobes.every(
      (m, j) => j <= i || len(sub(l.centre, m.centre)) >= l.radius + m.radius + 2 * c.blend,
    ),
  );
}

describe('lobeDirections', () => {
  it('spreads up to eight lobes evenly, eight on the cube’s diagonals', () => {
    const least = [0, 0, 180, 120, 109.47, 90, 90, 72, 70.53];
    for (let k = 0; k <= MAX_LOBES; k++) {
      const dirs = lobeDirections(k);
      expect(dirs).toHaveLength(k);
      for (const d of dirs) expect(len(d)).toBeCloseTo(1, 12);
      if (k < 2) continue;
      let closest = Infinity;
      dirs.forEach((u, i) =>
        dirs.forEach((v, j) => {
          if (j > i) closest = Math.min(closest, (angle(u, v) * 180) / Math.PI);
        }),
      );
      expect(closest).toBeCloseTo(least[k]!, 1);
      expect(closest).toBeGreaterThanOrEqual(70);
    }
    const diagonals = lobeDirections(8);
    for (const d of diagonals) {
      for (const x of d) expect(Math.abs(x)).toBeCloseTo(1 / Math.sqrt(3), 12);
    }
    expect(new Set(diagonals.map((d) => d.map(Math.sign).join())).size).toBe(8);
    expect(lobeDirections(12)).toHaveLength(MAX_LOBES);
  });
});

describe('satelliteDirection', () => {
  it('takes the widest open sky of the cube’s 26 directions, or the home side with no lobes', () => {
    const home: Vec3 = [0.85, -0.3, -0.45];
    const s = satelliteDirection([]);
    expect(s.map((x, k) => x - home[k]! / len(home)).every((x) => Math.abs(x) < 1e-12)).toBe(true);

    for (let k = 1; k <= MAX_LOBES; k++) {
      const lobes = lobeDirections(k).map(formDirection);
      const chosen = satelliteDirection(lobes);
      const clearance = (d: Vec3) => Math.min(...lobes.map((l) => angle(d, l)));
      let best = 0;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (let m = -1; m <= 1; m++) {
            if (i || j || m) best = Math.max(best, clearance(formDirection([i, j, m])));
          }
        }
      }
      expect(clearance(chosen)).toBeGreaterThanOrEqual(best - 1e-12);
      expect(len(chosen)).toBeCloseTo(1, 12);
    }
  });
});

describe('clusterFor', () => {
  const c = clusterFor(LARGE, { spacing: A, neck: 2 });

  it('sizes the hub as the ball that holds its sites, plus the inset', () => {
    expect(c.centre).toEqual([0, 0, 0]);
    expect(c.hub.centre).toEqual([0, 0, 0]);
    expect(c.hub.radius - SITE_INSET * A).toBeCloseTo(ballRadius(LARGE.hub, A), 9);
    // A ball of radius r holds 4πr³/3 over the site's volume, a³/√2.
    const r = ballRadius(1000, A);
    expect(((4 / 3) * Math.PI * r ** 3) / (A ** 3 / Math.SQRT2)).toBeCloseTo(1000, 9);
    expect(ballRadius(0, A)).toBe(0);
  });

  it('puts each lobe a little more than its radius out past the hub, on the neck’s gap', () => {
    expect(c.lobes).toHaveLength(LARGE.lobes.length);
    const gap = Math.max(0.5 * A, 0.36 * c.hub.radius);
    c.lobes.forEach((l, i) => {
      expect(l.radius - SITE_INSET * A).toBeCloseTo(ballRadius(LARGE.lobes[i]!, A), 9);
      const reach = c.hub.radius + 0.7 * l.radius + gap;
      // Snapped to its site: no further off than a site's rounding.
      expect(Math.abs(len(l.centre) - reach)).toBeLessThanOrEqual(A / Math.SQRT2 + 1e-9);
      expect(c.necks[i]!.to).toEqual(l.centre);
      expect(c.necks[i]!.from).toEqual([0, 0, 0]);
    });
  });

  it('keeps the lobes clearly separate bulbs', () => {
    expect(separate(c)).toBe(true);
    // Half way between two lobes' facing surfaces is open space, unless the
    // way between them runs through the hub.
    let checked = 0;
    c.lobes.forEach((l, i) =>
      c.lobes.forEach((m, j) => {
        if (j <= i) return;
        const towards = along(sub(m.centre, l.centre), 1 / len(sub(m.centre, l.centre)));
        const near = [0, 1, 2].map((k) => l.centre[k]! + towards[k]! * l.radius);
        const far = [0, 1, 2].map((k) => m.centre[k]! - towards[k]! * m.radius);
        const mid: Vec3 = [
          (near[0]! + far[0]!) / 2,
          (near[1]! + far[1]!) / 2,
          (near[2]! + far[2]!) / 2,
        ];
        if (len(mid) < c.hub.radius + c.blend) return;
        checked++;
        expect(clusterSdf(c, mid)).toBeGreaterThan(0);
      }),
    );
    expect(checked).toBeGreaterThan(0);
  });

  it('makes every neck at least the neck width across, unless that would swallow its lobe', () => {
    c.necks.forEach((n, i) => {
      const cap = NECK_MAX * Math.min(c.lobes[i]!.radius, c.hub.radius);
      expect(n.radius).toBeLessThanOrEqual(cap + 1e-9);
      if (n.radius < cap - 1e-9) expect(2 * n.radius).toBeGreaterThanOrEqual(2 * A - 1e-9);
    });
    const wide = clusterFor(LARGE, { spacing: A, neck: 3.5 });
    wide.necks.forEach((n, i) => {
      expect(n.radius).toBeGreaterThanOrEqual(c.necks[i]!.radius);
      const cap = NECK_MAX * Math.min(wide.lobes[i]!.radius, wide.hub.radius);
      if (n.radius < cap - 1e-9) expect(2 * n.radius).toBeGreaterThanOrEqual(3.5 * A - 1e-9);
    });
  });

  it('floats the satellite apart, the island’s gap clear of every other bulb', () => {
    const s = c.satellite!;
    expect(s).not.toBeNull();
    expect(len(s.centre) - s.radius - c.hub.radius).toBeGreaterThanOrEqual(ISLAND_GAP * A);
    for (const l of c.lobes) {
      expect(len(sub(s.centre, l.centre)) - s.radius - l.radius).toBeGreaterThanOrEqual(
        ISLAND_GAP * A,
      );
    }
    // Necks and their flares too: the whole form but the satellite is that far off its surface.
    const rest: Cluster = { ...c, satellite: null };
    expect(clusterSdf(rest, s.centre) - s.radius).toBeGreaterThanOrEqual(ISLAND_GAP * A);
    expect(clusterFor({ ...LARGE, satellite: 0 }, { spacing: A, neck: 2 }).satellite).toBeNull();
  });

  it('bounds every bulb within its radius', () => {
    for (const b of [c.hub, ...c.lobes, c.satellite!]) {
      expect(len(b.centre) + b.radius).toBeLessThanOrEqual(c.radius);
    }
  });

  it('draws a part bigger when the layout asks it to', () => {
    const boost = new Float64Array(18).fill(1);
    boost[PART_HUB] = 1.1;
    boost[lobePart(2)] = 1.2;
    const grown = clusterFor(LARGE, { spacing: A, neck: 2, boost });
    expect(grown.hub.radius).toBeCloseTo(c.hub.radius * 1.1, 9);
    expect(grown.lobes[2]!.radius).toBeCloseTo(c.lobes[2]!.radius * 1.2, 9);
    expect(grown.lobes[1]!.radius).toBeCloseTo(c.lobes[1]!.radius, 9);
  });

  it('keeps the hub bigger than a lobe holding more than it does', () => {
    const big = clusterFor({ hub: 60, lobes: [400], satellite: 0 }, { spacing: A, neck: 2 });
    expect(big.hub.radius).toBeGreaterThanOrEqual(1.1 * big.lobes[0]!.radius - 1e-9);
    const bare = clusterFor({ hub: 0, lobes: [], satellite: 0 }, { spacing: A, neck: 2 });
    expect(bare.hub.radius).toBeCloseTo((1.5 + SITE_INSET) * A, 9);
    expect(bare.lobes).toEqual([]);
    expect(bare.radius).toBeGreaterThan(bare.hub.radius);
  });
});

describe('probe', () => {
  const c = clusterFor(LARGE, { spacing: A, neck: 2 });

  it('is negative in every part, with the part it is deepest in, and positive far out', () => {
    expect(clusterSdf(c, [0, 0, 0])).toBeLessThan(0);
    expect(partAt(c, [0, 0, 0])).toBe(PART_HUB);
    c.lobes.forEach((l, i) => {
      expect(clusterSdf(c, l.centre)).toBeLessThan(0);
      expect(partAt(c, l.centre)).toBe(lobePart(i));
      const mid = neckMiddle(c, i);
      expect(clusterSdf(c, mid)).toBeLessThan(0);
      expect(partAt(c, mid)).toBe(neckPart(i));
    });
    expect(clusterSdf(c, c.satellite!.centre)).toBeLessThan(0);
    expect(partAt(c, c.satellite!.centre)).toBe(PART_SATELLITE);
    for (const d of lobeDirections(8))
      expect(clusterSdf(c, along(d, 2 * c.radius))).toBeGreaterThan(0);
  });

  it('gives clusterSdf the same distance', () => {
    const rnd = seededRandom(3);
    for (let k = 0; k < 200; k++) {
      const p: Vec3 = [0, 1, 2].map(() => (rnd() - 0.5) * 2 * c.radius) as Vec3;
      const out = probe(c, p[0], p[1], p[2], { d: 0, part: 0 });
      expect(clusterSdf(c, p)).toBe(out.d);
    }
  });
});

describe('clusterFor over any vault', () => {
  it('keeps lobes apart and every neck open, whatever the needs', () => {
    const rnd = seededRandom(17);
    const pick = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
    for (let k = 0; k < 200; k++) {
      const lobes = Array.from({ length: pick(0, 8) }, () => pick(18, 400)).sort((x, y) => y - x);
      const needs: ClusterNeeds = {
        hub: pick(24, 3000),
        lobes,
        satellite: rnd() < 0.5 ? 0 : pick(5, 60),
      };
      const c = clusterFor(needs, { spacing: A, neck: 1 + rnd() * 3 });
      expect(separate(c)).toBe(true);
      c.lobes.forEach((_, i) => expect(partAt(c, neckMiddle(c, i))).toBe(neckPart(i)));
      if (c.satellite) {
        const rest: Cluster = { ...c, satellite: null };
        expect(clusterSdf(rest, c.satellite.centre) - c.satellite.radius).toBeGreaterThanOrEqual(
          ISLAND_GAP * A,
        );
      }
    }
  });

  it('pushes lobes out when a small hub has too many to keep apart', () => {
    // Eight lobes of twelve notes round a hub of twenty-four, which the lobe
    // rule allows: placed by the sketch alone, neighbours would touch.
    const needs: ClusterNeeds = { hub: 35, lobes: new Array(8).fill(18), satellite: 0 };
    const c = clusterFor(needs, { spacing: A, neck: 2 });
    expect(separate(c)).toBe(true);
    const gap = Math.max(0.5 * A, 0.36 * c.hub.radius);
    const sketch = c.hub.radius + 0.7 * c.lobes[0]!.radius + gap;
    expect(len(c.lobes[0]!.centre)).toBeGreaterThan(sketch + A / Math.SQRT2);
  });
});
