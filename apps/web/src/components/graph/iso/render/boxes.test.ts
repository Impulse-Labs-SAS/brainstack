// The box layer as three holds it, in Node: its buffers, what each call queues for upload, and
// its shaders read as text. Nothing here compiles them — Node has no WebGL — so the shader test
// is a guard against the typos a compile would catch, not a substitute for one.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LINE_ART_COLORS, lineArtRgb, type LineArtTheme } from '@/lib/graph-theme';

import { BoxLayer, EDGE_PX, FLAG, KIND, STATE, runs, unitBox } from './boxes';
import { shaderProblems } from './glsl-check';

/** `n` boxes in a row, each a little different, so a slot read back is that slot's. */
function boxes(n: number) {
  const bounds = new Float32Array(n * 6);
  const kinds = new Uint8Array(n);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    bounds.set([i * 2, i * 3, 0.3, i * 2 + 1.5, i * 3 + 0.5, 0.6 + i / 100], i * 6);
    kinds[i] = i % 5;
    flags[i] = i % 4;
  }
  return { bounds, kinds, flags };
}

const attr = (layer: BoxLayer, name: string) =>
  layer.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
const ranges = (layer: BoxLayer, name: string) => attr(layer, name).updateRanges;
/** What a render does once it has uploaded: the ranges are spent. */
const uploaded = (layer: BoxLayer) => {
  for (const name of ['iMin', 'iMax', 'iKind', 'iState', 'iFlags', 'iLift']) {
    attr(layer, name).clearUpdateRanges();
  }
};
const uniform = (layer: BoxLayer, name: string) => layer.mesh.material.uniforms[name]!.value;
const rgbOf = (v: THREE.Vector3) => [v.x, v.y, v.z];

describe('unitBox', () => {
  it('has a top and four sides, wound counter-clockwise seen from outside, uv across each face', () => {
    const { position, normal, uv, index } = unitBox();
    expect(position.length).toBe(5 * 4 * 3);
    expect(index.length).toBe(5 * 6);
    const p = (v: number) => new THREE.Vector3().fromArray(position, v * 3);
    const n = (v: number) => new THREE.Vector3().fromArray(normal, v * 3);
    const normals = new Set<string>();
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t]!, index[t + 1]!, index[t + 2]!];
      const face = p(b)
        .sub(p(a))
        .cross(p(c).sub(p(a)))
        .normalize();
      expect(face.dot(n(a))).toBeCloseTo(1, 6);
      normals.add(n(a).toArray().join(','));
    }
    // No bottom: nothing above the ground sees it.
    expect([...normals].sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,1', '0,1,0', '1,0,0'].sort());
    for (let v = 0; v < position.length / 3; v++) {
      const [x, y, z] = p(v).toArray();
      const [nx, , nz] = n(v).toArray();
      // The face's own world axes: x, y on the top; x or y, then z, on a side.
      const want = nz === 1 ? [x, y] : nx !== 0 ? [y, z] : [x, z];
      expect([uv[v * 2], uv[v * 2 + 1]]).toEqual(want);
    }
  });
});

describe('runs', () => {
  it('coalesces neighbours, in order, once each', () => {
    expect(runs([9, 3, 4, 4, 5, 12, 11, 0])).toEqual([
      { start: 0, count: 1 },
      { start: 3, count: 3 },
      { start: 9, count: 1 },
      { start: 11, count: 2 },
    ]);
    expect(runs([])).toEqual([]);
  });
});

describe('BoxLayer', () => {
  it('holds every box as given, states and lifts at rest', () => {
    const layer = new BoxLayer(LINE_ART_COLORS, 16);
    const { bounds, kinds, flags } = boxes(10);
    layer.setBoxes(bounds, kinds, flags);
    expect(layer.count).toBe(10);
    expect(layer.mesh.geometry.instanceCount).toBe(10);
    const min = attr(layer, 'iMin').array;
    const max = attr(layer, 'iMax').array;
    for (let i = 0; i < 10; i++) {
      expect([min[i * 3], min[i * 3 + 1], min[i * 3 + 2]]).toEqual([
        ...bounds.slice(i * 6, i * 6 + 3),
      ]);
      expect([max[i * 3], max[i * 3 + 1], max[i * 3 + 2]]).toEqual([
        ...bounds.slice(i * 6 + 3, i * 6 + 6),
      ]);
      expect(attr(layer, 'iKind').array[i]).toBe(kinds[i]);
      expect(attr(layer, 'iFlags').array[i]).toBe(flags[i]);
      expect(attr(layer, 'iState').array[i]).toBe(STATE.rest);
      expect(attr(layer, 'iLift').array[i]).toBe(0);
    }
    // All of it queued, once, and the next flush says a frame is due.
    expect(ranges(layer, 'iMin')).toEqual([{ start: 0, count: 30 }]);
    expect(ranges(layer, 'iState')).toEqual([{ start: 0, count: 10 }]);
    expect(layer.flush()).toBe(true);
    expect(layer.flush()).toBe(false);
    layer.dispose();
  });

  it('resets states and lifts when the boxes are set again', () => {
    const layer = new BoxLayer(LINE_ART_COLORS, 16);
    const { bounds, kinds, flags } = boxes(6);
    layer.setBoxes(bounds, kinds, flags);
    layer.setState(2, STATE.selected);
    layer.setLift(2, 0.55);
    layer.flush();
    layer.setBoxes(bounds, kinds, flags);
    expect(attr(layer, 'iState').array[2]).toBe(STATE.rest);
    expect(attr(layer, 'iLift').array[2]).toBe(0);
    layer.dispose();
  });

  it('touches only the slot it is given, and flush queues exactly the runs touched', () => {
    const layer = new BoxLayer(LINE_ART_COLORS, 64);
    const { bounds, kinds, flags } = boxes(40);
    layer.setBoxes(bounds, kinds, flags);
    layer.flush();
    uploaded(layer);
    const before = Float32Array.from(attr(layer, 'iState').array);
    const version = attr(layer, 'iState').version;

    layer.setState(3, STATE.hover);
    layer.setState(4, STATE.linked);
    layer.setState(5, STATE.linked);
    layer.setState(20, STATE.dim);
    layer.setLift(7, 0.36);
    // Nothing uploads before flush…
    expect(ranges(layer, 'iState')).toEqual([]);
    expect(attr(layer, 'iState').version).toBe(version);
    const after = attr(layer, 'iState').array;
    for (let i = 0; i < 40; i++) {
      if (![3, 4, 5, 20].includes(i)) expect(after[i], `slot ${i}`).toBe(before[i]);
    }
    expect([after[3], after[4], after[5], after[20]]).toEqual([
      STATE.hover,
      STATE.linked,
      STATE.linked,
      STATE.dim,
    ]);
    expect(attr(layer, 'iLift').array[7]).toBeCloseTo(0.36, 6);

    // …then exactly the runs touched, and nothing of what was not.
    expect(layer.flush()).toBe(true);
    expect(ranges(layer, 'iState')).toEqual([
      { start: 3, count: 3 },
      { start: 20, count: 1 },
    ]);
    expect(ranges(layer, 'iLift')).toEqual([{ start: 7, count: 1 }]);
    expect(ranges(layer, 'iMin')).toEqual([]);
    expect(attr(layer, 'iState').version).toBeGreaterThan(version);

    // The same values again change nothing, and say so.
    uploaded(layer);
    layer.setState(3, STATE.hover);
    layer.setLift(7, 0.36);
    expect(layer.flush()).toBe(false);
    expect(ranges(layer, 'iState')).toEqual([]);
    layer.dispose();
  });

  it('refuses a slot it does not hold, and bounds that do not match the kinds', () => {
    const layer = new BoxLayer(LINE_ART_COLORS, 4);
    const { bounds, kinds, flags } = boxes(3);
    layer.setBoxes(bounds, kinds, flags);
    expect(() => layer.setState(3, STATE.hover)).toThrow(RangeError);
    expect(() => layer.setLift(-1, 1)).toThrow(RangeError);
    expect(() => layer.setBoxes(bounds.slice(0, 12), kinds, flags)).toThrow(RangeError);
    layer.dispose();
  });

  it('grows past its capacity and keeps every box, in a fresh geometry', () => {
    const layer = new BoxLayer(LINE_ART_COLORS, 4);
    const first = layer.mesh.geometry;
    let disposed = false;
    first.addEventListener('dispose', () => (disposed = true));
    const { bounds, kinds, flags } = boxes(1000);
    layer.setBoxes(bounds, kinds, flags);
    expect(disposed).toBe(true);
    expect(layer.mesh.geometry).not.toBe(first);
    expect(layer.count).toBe(1000);
    expect(layer.mesh.geometry.instanceCount).toBe(1000);
    expect(attr(layer, 'iMin').count).toBeGreaterThanOrEqual(1000);
    const min = attr(layer, 'iMin').array;
    const max = attr(layer, 'iMax').array;
    for (const i of [0, 1, 499, 998, 999]) {
      expect(min[i * 3]).toBe(bounds[i * 6]);
      expect(max[i * 3 + 2]).toBe(bounds[i * 6 + 5]);
      expect(attr(layer, 'iKind').array[i]).toBe(kinds[i]);
      expect(attr(layer, 'iFlags').array[i]).toBe(flags[i]);
    }
    // The state and lift buffers are the ones that change every frame.
    expect(attr(layer, 'iState').usage).toBe(THREE.DynamicDrawUsage);
    expect(attr(layer, 'iLift').usage).toBe(THREE.DynamicDrawUsage);
    layer.setState(999, STATE.selected);
    expect(layer.flush()).toBe(true);
    layer.dispose();
  });

  it('sets the scale, the view and the theme as uniforms', () => {
    const layer = new BoxLayer(LINE_ART_COLORS);
    layer.setScale(32, 2);
    expect(uniform(layer, 'uPpu')).toBe(32);
    expect(uniform(layer, 'uDpr')).toBe(2);
    layer.setScale(32, 0);
    expect(uniform(layer, 'uDpr')).toBe(1);
    layer.setView([-0.6, 0.8]);
    expect(uniform(layer, 'uRight').toArray()).toEqual([-0.6, 0.8]);

    const theme: LineArtTheme = { ...LINE_ART_COLORS, folderSide: '#102030', accent: '#ff0000' };
    layer.setTheme(theme);
    const tops = uniform(layer, 'uTop') as THREE.Vector3[];
    const sides = uniform(layer, 'uSide') as THREE.Vector3[];
    const edges = uniform(layer, 'uEdge') as THREE.Vector3[];
    expect(rgbOf(tops[KIND.vault]!)).toEqual(lineArtRgb(theme.vaultTop));
    expect(rgbOf(tops[KIND.sub]!)).toEqual(lineArtRgb(theme.subTop));
    expect(rgbOf(tops[KIND.note]!)).toEqual(lineArtRgb(theme.blockTop));
    // A sub-folder's sides and edges are a folder's.
    expect(rgbOf(sides[KIND.sub]!)).toEqual(lineArtRgb('#102030'));
    expect(rgbOf(sides[KIND.folder]!)).toEqual(lineArtRgb('#102030'));
    expect(rgbOf(edges[KIND.sub]!)).toEqual(lineArtRgb(theme.folderEdge));
    expect(rgbOf(edges[KIND.project]!)).toEqual(lineArtRgb(theme.projectEdge));
    expect(rgbOf(uniform(layer, 'uAccent'))).toEqual([1, 0, 0]);
    expect(rgbOf(uniform(layer, 'uRoute'))).toEqual(lineArtRgb(theme.route));
    expect(rgbOf(uniform(layer, 'uSelTop'))).toEqual(lineArtRgb(theme.selTop));
    expect(rgbOf(uniform(layer, 'uDim'))).toEqual(lineArtRgb(theme.blockDim));
    expect(rgbOf(uniform(layer, 'uTile'))).toEqual(lineArtRgb(theme.blockTile));
    layer.dispose();
  });

  it('draws opaque, depth-tested and written, front faces only, never culled by the unit box', () => {
    const layer = new BoxLayer(LINE_ART_COLORS);
    const m = layer.mesh.material;
    expect(m.transparent).toBe(false);
    expect(m.blending).toBe(THREE.NoBlending);
    expect(m.depthTest && m.depthWrite).toBe(true);
    expect(m.side).toBe(THREE.FrontSide);
    expect(layer.mesh.frustumCulled).toBe(false);
    layer.dispose();
  });

  it('has shaders that declare what the code sets and the geometry gives', () => {
    const layer = new BoxLayer(LINE_ART_COLORS);
    expect(shaderProblems(layer.mesh.material, layer.mesh.geometry)).toEqual([]);
    const vs = layer.mesh.material.vertexShader;
    const fs = layer.mesh.material.fragmentShader;
    // The constants the shaders are written from, as the shaders have them.
    expect(EDGE_PX).toEqual([1, 1, 1.25, 1.25, 1.25, 1.75]);
    expect(vs).toContain('float[6](1.0, 1.0, 1.25, 1.25, 1.25, 1.75)');
    expect(vs).toContain(`flags & ${FLAG.dashed}`);
    expect(vs).toContain(`flags & ${FLAG.index}`);
    expect(vs).toContain(`kind == ${KIND.note}`);
    expect(fs).toContain('const float DASH_PERIOD = 9.0;');
    expect(fs).toContain('const float INDEX_INSET = 0.17;');
    layer.dispose();
  });
});

describe('shaderProblems', () => {
  // The guard itself: each mistake it is there for, made on purpose.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1));
  const material = (vertexShader: string, fragmentShader: string, uniforms = {}) =>
    new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader, uniforms });
  const VS =
    'in float aSize;\nout float vSize;\nvoid main() { vSize = aSize; gl_Position = vec4(position, 1.0); }';
  const FS =
    'uniform float uK;\nin float vSize;\nlayout(location = 0) out highp vec4 c;\nvoid main() { c = vec4(vSize * uK); }';

  it('passes shaders that agree', () => {
    expect(shaderProblems(material(VS, FS, { uK: { value: 1 } }), geometry)).toEqual([]);
  });

  it('names a uniform set but never declared, or declared with another type', () => {
    expect(
      shaderProblems(material(VS, FS, { uK: { value: 1 }, uX: { value: 2 } }), geometry),
    ).toEqual(['uniform uX is set but never declared']);
    expect(
      shaderProblems(material(VS, FS, { uK: { value: new THREE.Vector3() } }), geometry),
    ).toEqual(['uniform uK: declared float, set as vec3']);
  });

  it('names varyings and attributes that disagree, reserved words and int maths', () => {
    const vs = VS.replace('out float vSize', 'flat out float vSize');
    expect(shaderProblems(material(vs, FS, { uK: { value: 1 } }), geometry)).toEqual([
      'varying vSize differs between the shaders',
    ]);
    const fs = FS.replace('vSize * uK', 'vSize * 2 + uK').replace('vec4 c', 'vec4 half');
    expect(
      shaderProblems(material(VS, fs.replace('c = ', 'half = '), { uK: { value: 1 } }), geometry),
    ).toEqual(
      expect.arrayContaining([
        'fragment: reserved word half',
        expect.stringMatching(/^fragment: int literal in float maths/),
      ]),
    );
    const noSize = VS.replace('in float aSize;', 'in vec2 aSize;');
    expect(shaderProblems(material(noSize, FS, { uK: { value: 1 } }), geometry)).toContain(
      'attribute aSize: declared vec2, given 1 floats',
    );
  });
});
