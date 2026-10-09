import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { basis, boundsOf, type Camera, type Viewport } from '@/lib/graph-camera';

import { DEFAULT_PERCH, perchShot, type BezelShape } from '../prompt/perch-geometry';
import { sampleVault } from '../sample-vault';
import { volumeLayout } from '../space/volume/layout';

import { PromptBezel, bezelGeometry } from './bezel';
import { notesReach, overviewCamera } from './overview';

/** A frame 4 × 1 units between its rails, facing +z, somewhere off the origin. */
const FRAME: BezelShape = {
  centre: [3, -2, 5],
  right: [1, 0, 0],
  up: [0, 1, 0],
  normal: [0, 0, 1],
  width: 4,
  height: 1,
  radius: 0.3,
  band: 0.1,
  thickness: 0.08,
};

function boxOf(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

/**
 * A renderer without a GL context: the state withRendererState saves, a
 * compile that settles only when told, and draws that count the meshes they
 * would show — what warmup and render ask of it.
 */
function stubRenderer(): { renderer: THREE.WebGLRenderer; settle: () => void } {
  let target: THREE.WebGLRenderTarget | null = null;
  let settle = () => {};
  const clear = new THREE.Color(0x0a0a0a);
  let alpha = 1;
  const info = { autoReset: true, reset() {}, render: { calls: 0, triangles: 0 } };
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.NoToneMapping as THREE.ToneMapping,
    toneMappingExposure: 1,
    info,
    debug: { onShaderError: null },
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(t: THREE.WebGLRenderTarget | null) {
      target = t;
    },
    getClearColor: (out: THREE.Color) => out.copy(clear),
    getClearAlpha: () => alpha,
    setClearColor(color: THREE.ColorRepresentation, a = 1) {
      clear.set(color);
      alpha = a;
    },
    getScissorTest: () => false,
    setScissorTest() {},
    compileAsync: () => new Promise<void>((resolve) => (settle = resolve)),
    render(scene: THREE.Scene) {
      let shown = 0;
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh) shown++;
      });
      info.render = { calls: shown, triangles: shown };
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, settle: () => settle() };
}

/** Looking straight at FRAME's middle from 9 units out along its normal. */
const FACING: Camera = { tx: 3, ty: -2, tz: 5, yaw: 0, pitch: 0, dist: 9 };

describe('PromptBezel', () => {
  it('spans the rails’ rectangle grown by half the band, the thickness deep, centred on the box’s plane', () => {
    const box = boxOf(bezelGeometry(FRAME));
    expect(box.min.x).toBeCloseTo(-(2 + 0.05), 6);
    expect(box.max.x).toBeCloseTo(2 + 0.05, 6);
    expect(box.min.y).toBeCloseTo(-(0.5 + 0.05), 6);
    expect(box.max.y).toBeCloseTo(0.5 + 0.05, 6);
    expect(box.min.z).toBeCloseTo(-0.04, 6);
    expect(box.max.z).toBeCloseTo(0.04, 6);
  });

  it('leaves the box open: nothing of the bar further in than the band’s rounded inner edge and its bevel', () => {
    const p = bezelGeometry(FRAME).getAttribute('position');
    const bevel = Math.min(FRAME.band, FRAME.thickness) / 4;
    // The opening, its rounded corners concentric with the rails'.
    const hw = FRAME.width / 2 - FRAME.band / 2 - bevel;
    const hh = FRAME.height / 2 - FRAME.band / 2 - bevel;
    const r = FRAME.radius - FRAME.band / 2 - bevel;
    // Signed distance from the opening's edge: negative inside it.
    const outside = (x: number, y: number) => {
      const qx = Math.abs(x) - hw + r;
      const qy = Math.abs(y) - hh + r;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    for (let i = 0; i < p.count; i++) expect(outside(p.getX(i), p.getY(i))).toBeGreaterThan(-1e-6);
  });

  it('keeps its geometry for a frame of the same size, and disposes the old one for a new size', () => {
    const bezel = new PromptBezel();
    expect(bezel.geometry).toBeNull();
    bezel.shape(FRAME);
    const first = bezel.geometry!;
    expect(first).not.toBeNull();
    let disposed = 0;
    first.addEventListener('dispose', () => disposed++);

    // Moved and turned, the same size: only the matrix changes.
    bezel.shape({ ...FRAME, centre: [0, 0, 0], right: [0, 0, -1], normal: [1, 0, 0] });
    expect(bezel.geometry).toBe(first);
    expect(disposed).toBe(0);

    bezel.shape({ ...FRAME, width: 3.5 });
    expect(bezel.geometry).not.toBe(first);
    expect(disposed).toBe(1);

    const second = bezel.geometry!;
    let gone = 0;
    second.addEventListener('dispose', () => gone++);
    bezel.dispose();
    expect(gone).toBe(1);
  });

  it('picks planes round the frame for the creature perched behind it, its claws in front', () => {
    const bezel = new PromptBezel();
    const cam = FACING;
    expect(basis(cam).forward[2]).toBe(-1);
    expect(bezel.planes(cam, 1)).toBeNull();
    bezel.shape(FRAME);
    const unit = 2;
    const p = bezel.planes(cam, unit)!;
    expect(p.near).toBeCloseTo(9 - 4 * unit, 9);
    expect(p.far).toBeCloseTo(9 + 6 * unit, 9);
    // Up close the near plane never reaches the camera.
    const near = bezel.planes({ ...cam, dist: 1 }, unit)!;
    expect(near.near).toBeCloseTo(0.02 * unit, 9);
    expect(near.far).toBeGreaterThan(near.near);
    // Behind the camera, nothing.
    expect(bezel.planes({ ...cam, tz: 0, dist: 1 }, unit)).toBeNull();
  });

  it('widens its planes to hold the creature wherever its crossing has taken it', () => {
    const bezel = new PromptBezel();
    const unit = 2;
    expect(bezel.planes(FACING, unit, { centre: [3, -2, 0], radius: 1 })).toBeNull();
    bezel.shape(FRAME);
    const own = bezel.planes(FACING, unit)!;
    const holds = (p: { near: number; far: number }, depth: number, radius: number) => {
      expect(p.near).toBeLessThanOrEqual(Math.max(0.02 * unit, depth - radius));
      expect(p.far).toBeGreaterThanOrEqual(depth + radius);
    };
    // Clinging to the frame it is within them already: they stay as they were.
    expect(bezel.planes(FACING, unit, { centre: [3, -2, 4], radius: 3 })).toEqual(own);
    // Thirty units past the frame, on its way into the cluster: the far plane goes with it.
    const deep = bezel.planes(FACING, unit, { centre: [3, -2, -25], radius: 6 })!;
    expect(deep.near).toBe(own.near);
    holds(deep, 39, 6);
    // Between the camera and the frame, coming back past the camera's nose: the near plane too.
    const close = bezel.planes(FACING, unit, { centre: [4, -2, 12], radius: 3 })!;
    expect(close.far).toBe(own.far);
    expect(close.near).toBe(0.02 * unit);
    holds(close, 2, 3);
    // The camera past the frame, the creature ahead of it: its own room alone.
    const past: Camera = { ...FACING, tz: 0, dist: 1 };
    holds(bezel.planes(past, unit, { centre: [3, -2, -20], radius: 2 })!, 21, 2);
    // Nothing in front of the camera to hold.
    expect(bezel.planes(past, unit, { centre: [3, -2, 30], radius: 2 })).toBeNull();
    bezel.dispose();
  });

  it('draws a frame shaped while its compile was still polling', async () => {
    const { renderer, settle } = stubRenderer();
    const bezel = new PromptBezel();
    // As the lab does it: warmed up as it is made, shaped as the page hands the prompt in.
    const warming = bezel.warmup(renderer);
    bezel.shape(FRAME);
    settle();
    await warming;
    const frame = {
      cam: FACING,
      vp: { width: 800, height: 600 },
      level: 1,
      unit: 1,
      depth: null,
      eye: null,
    };
    bezel.render(renderer, frame);
    expect(bezel.info.calls).toBe(1);
    // Taken away and shaped again, as a vault switch does: drawn all the same.
    bezel.shape(null);
    bezel.render(renderer, frame);
    expect(bezel.info.calls).toBe(0);
    bezel.shape(FRAME);
    bezel.render(renderer, frame);
    expect(bezel.info.calls).toBe(1);
    bezel.dispose();
  });

  it('shapes to a real perch shot on a phone and a wide screen, the bar clear of the box', () => {
    const vault = sampleVault();
    const l = volumeLayout(vault.model);
    const bounds = boundsOf([...l.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
    for (const vp of [
      { width: 375, height: 812 },
      { width: 2560, height: 1440 },
    ] satisfies Viewport[]) {
      const overview = overviewCamera(bounds, vp, 0.5, 0.3);
      const width = Math.min(560, 0.8 * vp.width);
      const shot = perchShot({
        overview,
        vp,
        rect: {
          left: (vp.width - width) / 2,
          top: (vp.height - 56) / 2,
          width,
          height: 56,
          radius: 16,
        },
        unit: l.unit,
        radius: notesReach(l.positions.values(), [overview.tx, overview.ty, overview.tz], l.unit),
        knobs: DEFAULT_PERCH,
      })!;
      const bezel = new PromptBezel();
      bezel.shape(shot.bezel);
      const box = boxOf(bezel.geometry!);
      // The bar's inner edge lies outside the DOM box: the band never covers the text.
      const boxHalfW = width / (2 * shot.pixels);
      const boxHalfH = 56 / (2 * shot.pixels);
      const innerW = shot.bezel.width / 2 - shot.bezel.band / 2;
      const innerH = shot.bezel.height / 2 - shot.bezel.band / 2;
      expect(innerW).toBeGreaterThan(boxHalfW);
      expect(innerH).toBeGreaterThan(boxHalfH);
      // Float32 positions: to a millionth of the bar's size.
      const across = shot.bezel.width / 2 + shot.bezel.band / 2;
      expect(Math.abs(box.max.x - across)).toBeLessThan(1e-6 * across);
      bezel.dispose();
    }
  });
});
