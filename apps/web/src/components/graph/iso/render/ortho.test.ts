// three.js as it is: its cameras and matrices are plain maths and need no WebGL, so what is
// checked here is exactly what the renderer would draw with.

import { OrthographicCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { Viewport } from '@/lib/graph-camera';

import { ISO_EL, PLAN_EL, isoProject, snapAz, type IsoCam } from '../math/camera';

import { applyIsoCamera } from './ortho';

/** A small LCG, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Where three puts a world point, in CSS pixels, and its distance in front of the camera. */
function threeScreen(camera: OrthographicCamera, vp: Viewport, x: number, y: number, z: number) {
  const ndc = new Vector3(x, y, z).project(camera);
  const view = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  return {
    x: ((ndc.x + 1) / 2) * vp.width,
    y: ((1 - ndc.y) / 2) * vp.height,
    ndcZ: ndc.z,
    ahead: -view.z,
  };
}

function randomCase(r: () => number): { cam: IsoCam; vp: Viewport } {
  const els = [ISO_EL, PLAN_EL, 0.1 + r() * (PLAN_EL - 0.1)];
  const azs = [
    snapAz(Math.floor(r() * 8) - 4, false),
    snapAz(Math.floor(r() * 8) - 4, true),
    (r() - 0.5) * 4 * Math.PI,
  ];
  return {
    cam: {
      tx: (r() - 0.5) * 400,
      ty: (r() - 0.5) * 400,
      tz: (r() - 0.5) * 3,
      az: azs[Math.floor(r() * azs.length)]!,
      el: els[Math.floor(r() * els.length)]!,
      ppu: 0.5 + r() * 90,
    },
    vp: { width: 320 + Math.round(r() * 1600), height: 480 + Math.round(r() * 700) },
  };
}

describe('applyIsoCamera', () => {
  it('puts every world point where isoProject does, above and below the target too', () => {
    const r = rng(21);
    const camera = new OrthographicCamera();
    for (let i = 0; i < 60; i++) {
      const { cam, vp } = randomCase(r);
      applyIsoCamera(camera, cam, vp);
      const project = isoProject(cam, vp);
      for (let k = 0; k < 25; k++) {
        const x = cam.tx + (r() - 0.5) * (vp.width / cam.ppu) * 1.5;
        const y = cam.ty + (r() - 0.5) * (vp.height / cam.ppu) * 1.5;
        const z = cam.tz + (r() - 0.5) * 12;
        const want = project(x, y, z);
        const got = threeScreen(camera, vp, x, y, z);
        expect(Math.abs(got.x - want.x)).toBeLessThan(1e-6);
        expect(Math.abs(got.y - want.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('agrees on depth: farther for isoProject is farther for three', () => {
    const r = rng(22);
    const camera = new OrthographicCamera();
    for (let i = 0; i < 30; i++) {
      const { cam, vp } = randomCase(r);
      const reach = 100 + r() * 900;
      applyIsoCamera(camera, cam, vp, reach);
      const project = isoProject(cam, vp);
      for (let k = 0; k < 10; k++) {
        const x = cam.tx + (r() - 0.5) * 80;
        const y = cam.ty + (r() - 0.5) * 80;
        const z = cam.tz + (r() - 0.5) * 12;
        const got = threeScreen(camera, vp, x, y, z);
        // The camera sits `reach` back from the target: a point is that plus its depth ahead.
        expect(got.ahead).toBeCloseTo(reach + project(x, y, z).depth, 6);
        // And it is drawn: inside the clip range.
        expect(got.ndcZ).toBeGreaterThan(-1);
        expect(got.ndcZ).toBeLessThan(1);
      }
    }
  });

  it('sets the frustum from the viewport and ppu, whatever zoom it had', () => {
    const camera = new OrthographicCamera();
    camera.zoom = 3;
    const cam: IsoCam = { tx: 5, ty: -2, tz: 0.3, az: snapAz(1, false), el: ISO_EL, ppu: 20 };
    applyIsoCamera(camera, cam, { width: 800, height: 600 });
    expect(camera).toMatchObject({
      left: -20,
      right: 20,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 1000,
      zoom: 1,
    });
    const target = threeScreen(camera, { width: 800, height: 600 }, 5, -2, 0.3);
    expect(target.x).toBeCloseTo(400, 9);
    expect(target.y).toBeCloseTo(300, 9);
  });
});
