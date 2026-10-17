// The cable layer as three holds it, in Node: its instances, what each call queues for upload,
// its two draws' depth tests and its shaders read as text. Nothing here compiles them — Node has
// no WebGL — so the shader test is a guard against the typos a compile would catch.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LINE_ART_COLORS, lineArtRgb } from '@/lib/graph-theme';

import type { Route, Vec3 } from '../routes';
import {
  CABLE,
  CABLE_DASH_PX,
  CableLayer,
  DEPTH_LIFT,
  HIDDEN_ALPHA,
  HIDDEN_PX,
  LINK_PX,
  SEEN_ALPHA,
  routeWidth,
} from './cables';
import { shaderProblems } from './glsl-check';

/** A cable through these points, its length measured as Module R measures it. */
function route(...points: Vec3[]): Route {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return { points, length };
}

/** Along a street on a folder's top, down its side to the project's top, and on along it. */
const L_SHAPED = route([0, 0, 0.91], [3, 0, 0.91], [3, 0, 0.61], [3, 4, 0.61]);

/** `n` segments in a row, each a little different, so a slot read back is that slot's. */
const long = (n: number) =>
  route(...Array.from({ length: n + 1 }, (_, i): Vec3 => [i, i % 2, 0.31 + i / 1000]));

const attr = (layer: CableLayer, name: string) =>
  layer.visible.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
const slot = (layer: CableLayer, name: string, i: number) => {
  const a = attr(layer, name);
  return [...a.array.slice(i * a.itemSize, (i + 1) * a.itemSize)];
};
const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-5);
const uniform = (mesh: { material: THREE.ShaderMaterial }, name: string) =>
  mesh.material.uniforms[name]!.value;

describe('routeWidth', () => {
  it('is 1 px for one link, 0.6 more for each doubling, and stops at eight', () => {
    expect(routeWidth(1)).toBe(1);
    expect(routeWidth(2)).toBeCloseTo(1.6, 9);
    expect(routeWidth(4)).toBeCloseTo(2.2, 9);
    expect(routeWidth(8)).toBeCloseTo(2.8, 9);
    expect(routeWidth(500)).toBeCloseTo(2.8, 9);
    expect(routeWidth(0)).toBe(1);
    expect(routeWidth(Number.NaN)).toBe(1);
  });
});

describe('CableLayer', () => {
  it('has a segment per pair of points, where along its cable each starts, and its length', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 16);
    layer.set([{ routes: [L_SHAPED], kind: CABLE.link }]);
    expect(layer.count).toBe(3);
    expect(layer.visible.geometry.instanceCount).toBe(3);
    const pts = L_SHAPED.points;
    for (let i = 0; i < 3; i++) {
      expect(close(slot(layer, 'iStart', i), pts[i]!), `segment ${i} start`).toBe(true);
      expect(close(slot(layer, 'iEnd', i), pts[i + 1]!), `segment ${i} end`).toBe(true);
      expect(slot(layer, 'iKind', i)).toEqual([CABLE.link]);
      expect(slot(layer, 'iWidth', i)[0]).toBeCloseTo(LINK_PX, 6);
    }
    // 3 along the folder, 0.3 down its side, 4 along the project: 7.3 in all, the drop included.
    expect(close(slot(layer, 'iAlong', 0), [0, 7.3])).toBe(true);
    expect(close(slot(layer, 'iAlong', 1), [3, 7.3])).toBe(true);
    expect(close(slot(layer, 'iAlong', 2), [3.3, 7.3])).toBe(true);
    // All of it queued, once; both draws show it.
    expect(attr(layer, 'iStart').updateRanges).toEqual([{ start: 0, count: 9 }]);
    expect(attr(layer, 'iAlong').updateRanges).toEqual([{ start: 0, count: 6 }]);
    expect(attr(layer, 'iKind').version).toBeGreaterThan(0);
    expect(layer.visible.visible && layer.hidden.visible).toBe(true);
    // The next selection queues only what it draws, not the last one's ranges as well.
    layer.set([{ routes: [route([0, 0, 0.31], [1, 0, 0.31])], kind: CABLE.link }]);
    expect(attr(layer, 'iStart').updateRanges).toEqual([{ start: 0, count: 3 }]);
    expect(attr(layer, 'iAlong').updateRanges).toEqual([{ start: 0, count: 2 }]);
    layer.dispose();
  });

  it('measures each cable from its start, and skips a repeated point and a cable of one', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 16);
    const twice = route([0, 0, 0.31], [2, 0, 0.31], [2, 0, 0.31], [2, 5, 0.31]);
    const lone = route([9, 9, 0.31]);
    layer.set([{ routes: [L_SHAPED, lone, twice], kind: CABLE.link }]);
    expect(layer.count).toBe(5);
    expect(close(slot(layer, 'iAlong', 3), [0, 7])).toBe(true);
    expect(close(slot(layer, 'iAlong', 4), [2, 7])).toBe(true);
    expect(close(slot(layer, 'iStart', 4), [2, 0, 0.31])).toBe(true);
    expect(close(slot(layer, 'iEnd', 4), [2, 5, 0.31])).toBe(true);
    layer.dispose();
  });

  it('draws nothing, and shows nothing, when there is nothing to draw', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 16);
    // Nothing set yet.
    expect(layer.visible.visible || layer.hidden.visible).toBe(false);
    layer.set([{ routes: [L_SHAPED], kind: CABLE.link }]);
    layer.set([]);
    expect(layer.count).toBe(0);
    expect(layer.visible.geometry.instanceCount).toBe(0);
    expect(layer.visible.visible || layer.hidden.visible).toBe(false);
    layer.set([{ routes: [route([1, 1, 0.31])], kind: CABLE.route }]);
    expect(layer.count).toBe(0);
    expect(layer.visible.visible).toBe(false);
    layer.dispose();
  });

  it('puts project routes first and links last, each with its width', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 16);
    const a = route([0, 0, 0.31], [4, 0, 0.31]);
    const b = route([0, 2, 0.31], [0, 6, 0.31], [5, 6, 0.31]);
    const c = route([8, 0, 0.31], [8, 3, 0.31]);
    layer.set([
      { routes: [L_SHAPED], kind: CABLE.link },
      { routes: [a, b, c], kind: CABLE.route, widths: [routeWidth(8), Number.NaN, 0] },
    ]);
    expect(layer.count).toBe(4 + 3);
    const kinds = Array.from({ length: 7 }, (_, i) => slot(layer, 'iKind', i)[0]);
    const { route: R, link: K } = CABLE;
    expect(kinds).toEqual([R, R, R, R, K, K, K]);
    const widths = Array.from({ length: 7 }, (_, i) => slot(layer, 'iWidth', i)[0]!);
    // A width that is not one falls back to a single link's route.
    const want = [routeWidth(8), 1, 1, 1, LINK_PX, LINK_PX, LINK_PX];
    widths.forEach((w, i) => expect(w, `segment ${i}`).toBeCloseTo(want[i]!, 6));
    expect(close(slot(layer, 'iStart', 0), [0, 0, 0.31])).toBe(true);
    expect(close(slot(layer, 'iStart', 4), L_SHAPED.points[0]!)).toBe(true);
    layer.dispose();
  });

  it('refuses a kind it does not draw, and widths that do not match the routes', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 16);
    expect(() => layer.set([{ routes: [L_SHAPED], kind: 7 }])).toThrow(RangeError);
    expect(() =>
      layer.set([{ routes: [L_SHAPED, L_SHAPED], kind: CABLE.route, widths: [2] }]),
    ).toThrow(RangeError);
    layer.dispose();
  });

  it('fades every cable by a share of its strength, both passes alike', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    expect(uniform(layer.visible, 'uFade')).toBe(1);
    for (const [f, want] of [
      [0.32, 0.32],
      [0, 0],
      [-1, 0],
      [2, 1],
      [Number.NaN, 1],
    ] as const) {
      layer.setFade(f);
      expect(uniform(layer.visible, 'uFade'), `fade ${f}`).toBe(want);
      expect(uniform(layer.hidden, 'uFade'), `fade ${f}, hidden`).toBe(want);
    }
    layer.dispose();
  });

  it('grows the links in by a share of each one’s length, from none to whole', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    // Whole until told otherwise: a layer turned on mid-selection shows what it has.
    expect(uniform(layer.visible, 'uProgress')).toBe(1);
    for (const [t, want] of [
      [0, 0],
      [0.25, 0.25],
      [1, 1],
      [-1, 0],
      [3, 1],
      [Number.NaN, 1],
    ] as const) {
      layer.setProgress(t);
      expect(uniform(layer.visible, 'uProgress'), `progress ${t}`).toBe(want);
      expect(uniform(layer.hidden, 'uProgress'), `progress ${t}, hidden`).toBe(want);
    }
    // The shaders cut a link there, measured along it, and never a project route.
    const vs = layer.visible.material.vertexShader;
    expect(vs).toContain(`bool link = kind == ${CABLE.link};`);
    expect(vs).toContain('(link && uProgress < 1.0) ? uProgress * iAlong.y : 1e30');
    expect(layer.visible.material.fragmentShader).toContain('if (vAlong > vCut) discard;');
    layer.dispose();
  });

  it('grows past its capacity, keeping every segment, in a new geometry both draws share', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 4);
    const first = layer.visible.geometry;
    let disposed = 0;
    first.addEventListener('dispose', () => disposed++);
    const cable = long(1000);
    layer.set([{ routes: [cable], kind: CABLE.link }]);
    expect(disposed).toBe(1);
    expect(layer.visible.geometry).not.toBe(first);
    expect(layer.hidden.geometry).toBe(layer.visible.geometry);
    expect(layer.count).toBe(1000);
    expect(layer.visible.geometry.instanceCount).toBe(1000);
    expect(attr(layer, 'iStart').count).toBeGreaterThanOrEqual(1000);
    for (const i of [0, 1, 499, 998, 999]) {
      expect(close(slot(layer, 'iStart', i), cable.points[i]!), `segment ${i}`).toBe(true);
      expect(close(slot(layer, 'iEnd', i), cable.points[i + 1]!), `segment ${i}`).toBe(true);
      expect(slot(layer, 'iAlong', i)[1]).toBeCloseTo(cable.length, 2);
    }
    // Rewritten at every new selection.
    expect(attr(layer, 'iStart').usage).toBe(THREE.DynamicDrawUsage);
    // Fewer again: the room stays, the count follows.
    layer.set([{ routes: [L_SHAPED], kind: CABLE.link }]);
    expect(layer.count).toBe(3);
    expect(attr(layer, 'iStart').count).toBeGreaterThanOrEqual(1000);
    layer.dispose();
  });

  it('grows at one segment past its capacity, and not at exactly it', () => {
    const layer = new CableLayer(LINE_ART_COLORS, 3);
    const first = layer.visible.geometry;
    layer.set([{ routes: [L_SHAPED], kind: CABLE.link }]);
    expect(layer.visible.geometry).toBe(first);
    layer.set([{ routes: [long(4)], kind: CABLE.link }]);
    expect(layer.visible.geometry).not.toBe(first);
    expect(layer.count).toBe(4);
    expect(close(slot(layer, 'iEnd', 3), [4, 0, 0.314])).toBe(true);
    layer.dispose();
  });

  it('sets the scale and theme once for both draws, and tells them apart by one uniform', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    layer.setScale(24, 2, { width: 1280, height: 720 });
    for (const mesh of [layer.visible, layer.hidden]) {
      expect(uniform(mesh, 'uViewport').toArray()).toEqual([1280, 720]);
      expect(uniform(mesh, 'uDpr')).toBe(2);
    }
    layer.setScale(24, 0, { width: 0, height: Number.NaN });
    expect(uniform(layer.hidden, 'uDpr')).toBe(1);
    expect(uniform(layer.hidden, 'uViewport').toArray()).toEqual([1, 1]);

    expect(uniform(layer.visible, 'uAccent').toArray()).toEqual(lineArtRgb(LINE_ART_COLORS.accent));
    expect(uniform(layer.visible, 'uRoute').toArray()).toEqual(lineArtRgb(LINE_ART_COLORS.route));
    layer.setTheme({ ...LINE_ART_COLORS, accent: '#ff0000', route: '#00ff00' });
    for (const mesh of [layer.visible, layer.hidden]) {
      expect(uniform(mesh, 'uAccent').toArray()).toEqual([1, 0, 0]);
      expect(uniform(mesh, 'uRoute').toArray()).toEqual([0, 1, 0]);
    }
    expect(uniform(layer.visible, 'uHidden')).toBe(0);
    expect(uniform(layer.hidden, 'uHidden')).toBe(1);
    layer.dispose();
  });

  it('shows the seen stretches over the boxes and the hidden ones only behind them', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    const seen = layer.visible.material;
    const hidden = layer.hidden.material;
    expect(seen.depthFunc).toBe(THREE.LessEqualDepth);
    expect(hidden.depthFunc).toBe(THREE.GreaterDepth);
    for (const m of [seen, hidden]) {
      expect(m.depthTest).toBe(true);
      // Neither writes depth: a cable never hides another, nor a block.
      expect(m.depthWrite).toBe(false);
      expect(m.transparent).toBe(true);
      expect(m.side).toBe(THREE.DoubleSide);
    }
    // After the opaque boxes and lift marks (renderOrder 1), the dashes under the solid.
    expect(layer.hidden.renderOrder).toBeGreaterThan(1);
    expect(layer.visible.renderOrder).toBeGreaterThan(layer.hidden.renderOrder);
    expect(layer.visible.frustumCulled || layer.hidden.frustumCulled).toBe(false);
    layer.dispose();
  });

  it('lets the quality governor turn the dashed stretches off and on', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    layer.set([{ routes: [L_SHAPED], kind: CABLE.link }]);
    layer.setHiddenVisible(false);
    expect(layer.hidden.visible).toBe(false);
    expect(layer.visible.visible).toBe(true);
    // Off stays off through a new selection…
    layer.set([{ routes: [L_SHAPED, L_SHAPED], kind: CABLE.link }]);
    expect(layer.hidden.visible).toBe(false);
    // …and on again shows them only while there is something to show.
    layer.setHiddenVisible(true);
    expect(layer.hidden.visible).toBe(true);
    layer.set([]);
    layer.setHiddenVisible(true);
    expect(layer.hidden.visible).toBe(false);
    layer.dispose();
  });

  it('frees its one geometry and both materials', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    const freed: string[] = [];
    layer.visible.geometry.addEventListener('dispose', () => freed.push('geometry'));
    layer.visible.material.addEventListener('dispose', () => freed.push('seen'));
    layer.hidden.material.addEventListener('dispose', () => freed.push('hidden'));
    layer.dispose();
    expect(freed.sort()).toEqual(['geometry', 'hidden', 'seen']);
  });

  it('has shaders that declare what the code sets and the geometry gives', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    for (const mesh of [layer.visible, layer.hidden]) {
      expect(shaderProblems(mesh.material, mesh.geometry)).toEqual([]);
    }
    const vs = layer.visible.material.vertexShader;
    const fs = layer.visible.material.fragmentShader;
    // The constants the shaders are written from, as the shaders have them.
    expect(HIDDEN_PX).toEqual([1.2, 1]);
    expect(HIDDEN_ALPHA).toEqual([0.55, 0.35]);
    expect(SEEN_ALPHA).toEqual([1, 0.9]);
    expect(vs).toContain('const float HIDDEN_PX[2] = float[2](1.2, 1.0);');
    expect(vs).toContain('const float HIDDEN_ALPHA[2] = float[2](0.55, 0.35);');
    expect(vs).toContain('const float SEEN_ALPHA[2] = float[2](1.0, 0.9);');
    expect(vs).toContain(`const float DEPTH_LIFT = ${DEPTH_LIFT};`);
    expect(CABLE_DASH_PX).toEqual({ on: 3, off: 3 });
    expect(fs).toContain('const float DASH_ON = 3.0;');
    expect(fs).toContain('const float DASH_PERIOD = 6.0;');
    // Both draws run the same shaders: one depth for a fragment, whichever test it meets.
    expect(layer.hidden.material.vertexShader).toBe(vs);
    expect(layer.hidden.material.fragmentShader).toBe(fs);
    layer.dispose();
  });

  // Node cannot run the shaders: the next two read, as text, the lines that decide what is drawn.
  it('keeps a cable on the plate it runs on, beside it and past its ends, in both draws', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    const vs = layer.visible.material.vertexShader;
    // A level segment's corners move in depth with the ground they are moved across: at one
    // depth, the lower half of a cable sinks under its plate and shows dashed.
    expect(vs).toContain('vec2 groundSlope(vec2 toPx)');
    expect(vs).toContain('clip.z += dot(ground, offset) * clip.w;');
    // A drop is lifted by the visible draw's width, whichever draw it is in.
    expect(vs).toContain('length(ground) * (max(iWidth, HIDDEN_PX[kind]) + aa)');
    layer.dispose();
  });

  it('draws the hidden stretches thinner, fainter, dashed and without caps', () => {
    const layer = new CableLayer(LINE_ART_COLORS);
    const vs = layer.visible.material.vertexShader;
    const fs = layer.visible.material.fragmentShader;
    expect(vs).toContain('vAlpha = (hidden ? HIDDEN_ALPHA[kind] : SEEN_ALPHA[kind]) * uFade;');
    expect(vs).toContain('vWidth = hidden ? HIDDEN_PX[kind] : iWidth;');
    expect(vs).toContain('float cap = hidden ? 0.0 : 0.5 * vWidth;');
    expect(vs).toContain('vColor = link ? uAccent : uRoute;');
    // Not grown that far: the whole segment is dropped before it is drawn.
    expect(vs).toContain('if (iAlong.x >= cut) {');
    expect(fs).toMatch(/if \(uHidden > 0\.5\) \{[^}]*DASH_PERIOD/);
    layer.dispose();
  });
});
