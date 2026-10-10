import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';

import { dot, sub, type Vec3 } from '../vec';
import { HULL, TENTACLE_SPECS } from './anatomy';
import {
  CUP,
  IRIS,
  buildClawFinger,
  buildHull,
  buildHullParts,
  buildIrisBlade,
  buildVertebra,
  socketFrame,
  writeIrisMatrices,
} from './geometry';
import { PART } from './look';

const HULL_ATTRIBUTES = ['aAO', 'aEdge', 'aPart', 'normal', 'position', 'uv'];
const PART_ATTRIBUTES = [...HULL_ATTRIBUTES, 'aEmit'].sort();

const triangles = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3;
const names = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort();
const point = (g: THREE.BufferGeometry, i: number): Vec3 => {
  const p = g.getAttribute('position');
  return [p.getX(i), p.getY(i), p.getZ(i)];
};

describe('the hull', () => {
  const high = buildHull('high');
  const low = buildHull('low');

  it('builds every part with the same attributes, so they merge into one draw', () => {
    for (const lod of ['high', 'low'] as const) {
      const parts = buildHullParts(lod);
      for (const { geometry } of parts) {
        expect(geometry.index).toBeNull();
        expect(names(geometry)).toEqual(HULL_ATTRIBUTES);
      }
      expect(mergeGeometries(parts.map((p) => p.geometry))).not.toBeNull();
    }
  });

  it('stays within its triangle budgets', () => {
    expect(triangles(high)).toBeGreaterThan(12_000);
    expect(triangles(high)).toBeLessThan(19_000);
    expect(triangles(low)).toBeGreaterThan(4_000);
    expect(triangles(low)).toBeLessThan(8_500);
  });

  it('has the proportions of the body plan', () => {
    for (const g of [high, low]) {
      const size = g.boundingBox!.getSize(new THREE.Vector3());
      expect(size.x / HULL.width).toBeGreaterThan(0.95);
      expect(size.x / HULL.width).toBeLessThan(1.15);
      expect(size.y / HULL.height).toBeGreaterThan(0.95);
      expect(size.y / HULL.height).toBeLessThan(1.15);
      expect(size.z / HULL.length).toBeGreaterThan(0.95);
      expect(size.z / HULL.length).toBeLessThan(1.1);
    }
  });

  it('faces its surfaces outward', () => {
    const n = high.getAttribute('normal');
    let out = 0;
    for (let i = 0; i < n.count; i++) {
      const p = point(high, i);
      // Away from the body's long axis, or forward and back at its ends.
      const radial: Vec3 = [p[0], p[1], Math.abs(p[2]) > 0.3 ? p[2] : 0];
      if (dot([n.getX(i), n.getY(i), n.getZ(i)], radial) > 0) out++;
    }
    expect(out / n.count).toBeGreaterThan(0.8);
  });

  it('opens a socket cup exactly where each tentacle is born', () => {
    const parts = high.getAttribute('aPart');
    for (const spec of TENTACLE_SPECS) {
      const k = spec.rootRadius / 0.06;
      const f = socketFrame(spec);
      let rim = 0;
      for (let i = 0; i < parts.count; i++) {
        if (parts.getX(i) !== PART.hoop) continue;
        const d = sub(point(high, i), spec.socket);
        const along = dot(d, f.y);
        const across = Math.sqrt(Math.max(0, dot(d, d) - along * along));
        if (Math.abs(along) < 1e-4 && Math.abs(across - CUP.rim * k) < 1e-4) rim++;
      }
      // A ring of rim vertices round the socket, in the plane across its axis.
      expect(rim).toBeGreaterThanOrEqual(12);
    }
  });

  it('keeps baked occlusion and edge wear in range, darkest in the seams', () => {
    const ao = high.getAttribute('aAO');
    const edge = high.getAttribute('aEdge');
    const parts = high.getAttribute('aPart');
    let coreAO = 0;
    let coreCount = 0;
    let plateAO = 0;
    let plateCount = 0;
    let outOfRange = 0;
    for (let i = 0; i < ao.count; i++) {
      if (!(ao.getX(i) >= 0 && ao.getX(i) <= 1 && edge.getX(i) >= 0 && edge.getX(i) <= 1)) {
        outOfRange++;
      }
      if (parts.getX(i) === PART.core) {
        coreAO += ao.getX(i);
        coreCount++;
      } else if (parts.getX(i) === PART.plate) {
        plateAO += ao.getX(i);
        plateCount++;
      }
    }
    expect(outOfRange).toBe(0);
    expect(coreAO / coreCount).toBeLessThan(plateAO / plateCount);
  });
});

describe('the tentacle parts', () => {
  it('builds a vertebra one unit long along y, within radius 1', () => {
    for (const sides of [6, 8] as const) {
      const g = buildVertebra(sides);
      g.computeBoundingBox();
      expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
      expect(g.boundingBox!.max.y).toBeCloseTo(1, 6);
      let radius = 0;
      for (let i = 0; i < g.getAttribute('position').count; i++) {
        const [x, , z] = point(g, i);
        radius = Math.max(radius, Math.hypot(x, z));
      }
      expect(radius).toBeLessThanOrEqual(1 + 1e-6);
    }
    expect(triangles(buildVertebra(8))).toBeLessThanOrEqual(240);
    expect(triangles(buildVertebra(6))).toBeLessThan(triangles(buildVertebra(8)));
  });

  it('lights only the vertebra groove, near its root', () => {
    const g = buildVertebra(8);
    const emit = g.getAttribute('aEmit');
    let lit = 0;
    for (let i = 0; i < emit.count; i++) {
      if (emit.getX(i) > 0.5) {
        lit++;
        const y = point(g, i)[1];
        expect(y).toBeGreaterThan(0.1);
        expect(y).toBeLessThan(0.25);
      }
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('gives the vertebra, the talon and the iris blade one attribute set, for one material', () => {
    for (const g of [buildVertebra(8), buildVertebra(6), buildClawFinger(), buildIrisBlade()]) {
      expect(g.index).toBeNull();
      expect(names(g)).toEqual(PART_ATTRIBUTES);
    }
  });

  it('hooks the talon inward and lights its tip', () => {
    const g = buildClawFinger();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(g.boundingBox!.max.y).toBeCloseTo(1, 6);
    expect(g.boundingBox!.min.x).toBeLessThan(-1.5);
    const emit = g.getAttribute('aEmit');
    let litLow = 0;
    let litTip = 0;
    for (let i = 0; i < emit.count; i++) {
      if (point(g, i)[1] < 0.5 && emit.getX(i) > 0) litLow++;
      if (point(g, i)[1] > 0.95 && emit.getX(i) > 0.9) litTip++;
    }
    expect(litLow).toBe(0);
    expect(litTip).toBeGreaterThan(0);
    expect(triangles(g)).toBeLessThan(100);
  });

  it('faces every part outward', () => {
    /** Share of vertices whose normal leans away from `centre(p)`. */
    const outward = (g: THREE.BufferGeometry, centre: (p: Vec3) => Vec3) => {
      const n = g.getAttribute('normal');
      let out = 0;
      for (let i = 0; i < n.count; i++) {
        const p = point(g, i);
        if (dot([n.getX(i), n.getY(i), n.getZ(i)], sub(p, centre(p))) > 0) out++;
      }
      return out / n.count;
    };
    // Measured from the axis: the dish under the socket rim and the knuckle's cap look along it.
    expect(outward(buildVertebra(8), (p) => [0, p[1], 0])).toBeGreaterThan(0.75);
    const curl = (y: number) => -0.2 * y - 1.8 * y * y * y;
    expect(outward(buildClawFinger(), (p) => [curl(p[1]), p[1] - 0.05, 0])).toBeGreaterThan(0.8);
    // The blade's face looks out of the eye, along +z; it has no back.
    const blade = buildIrisBlade();
    const n = blade.getAttribute('normal');
    let forward = 0;
    let backward = 0;
    for (let i = 0; i < n.count; i++) {
      if (n.getZ(i) > 0.5) forward++;
      if (n.getZ(i) < -0.5) backward++;
    }
    expect(forward).toBeGreaterThan(0);
    expect(backward).toBe(0);
  });
});

describe('writeIrisMatrices', () => {
  const identity = new THREE.Matrix4().toArray(new Float32Array(16));
  const inner = (out: Float32Array, k: number): number =>
    Math.hypot(out[k * 16 + 12]!, out[k * 16 + 13]! - 0.03);

  it('slides every blade out as the iris opens', () => {
    const shut = new Float32Array(IRIS.blades * 16);
    const open = new Float32Array(IRIS.blades * 16);
    writeIrisMatrices(identity, 0, shut);
    writeIrisMatrices(identity, 1, open);
    for (let k = 0; k < IRIS.blades; k++) {
      expect(inner(shut, k)).toBeCloseTo(IRIS.closed, 6);
      expect(inner(open, k)).toBeCloseTo(IRIS.open, 6);
    }
  });

  it('carries the blades with the hull', () => {
    const hull = new THREE.Matrix4()
      .compose(
        new THREE.Vector3(1, 2, 3),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
        new THREE.Vector3(1, 1, 1),
      )
      .toArray(new Float32Array(16));
    const local = new Float32Array(IRIS.blades * 16);
    const placed = new Float32Array(IRIS.blades * 16);
    writeIrisMatrices(identity, 0.5, local);
    writeIrisMatrices(hull, 0.5, placed);
    const expected = new THREE.Matrix4()
      .fromArray(hull)
      .multiply(new THREE.Matrix4().fromArray(local, 16));
    expected.elements.forEach((v, i) => expect(placed[16 + i]).toBeCloseTo(v, 5));
  });
});
