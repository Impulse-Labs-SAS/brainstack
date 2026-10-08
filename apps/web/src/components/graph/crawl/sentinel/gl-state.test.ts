import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { assertRendererState, withRendererState } from './gl-state';

/**
 * The renderer state the Sentinel may touch, without a GL context: what
 * withRendererState saves and restores is all plain JavaScript on the renderer.
 */
function stubRenderer(): THREE.WebGLRenderer {
  let target: THREE.WebGLRenderTarget | null = null;
  let face = 0;
  let mip = 0;
  const clear = new THREE.Color(0x0a0a0a);
  let alpha = 1;
  let scissor = false;
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.NoToneMapping as THREE.ToneMapping,
    toneMappingExposure: 1,
    info: { autoReset: true },
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    setRenderTarget(t: THREE.WebGLRenderTarget | null, f = 0, m = 0) {
      target = t;
      face = f;
      mip = m;
    },
    getClearColor: (out: THREE.Color) => out.copy(clear),
    getClearAlpha: () => alpha,
    setClearColor(color: THREE.ColorRepresentation, a = 1) {
      clear.set(color);
      alpha = a;
    },
    getScissorTest: () => scissor,
    setScissorTest(on: boolean) {
      scissor = on;
    },
  };
  return renderer as unknown as THREE.WebGLRenderer;
}

/** Everything a Sentinel pass might change, changed. */
function mess(r: THREE.WebGLRenderer): void {
  r.setRenderTarget(new THREE.WebGLRenderTarget<THREE.Texture>(4, 4), 0, 1);
  r.autoClear = false;
  r.autoClearColor = false;
  r.autoClearDepth = false;
  r.autoClearStencil = false;
  r.setClearColor(0xff0000, 0);
  r.toneMapping = THREE.AgXToneMapping;
  r.toneMappingExposure = 2;
  r.setScissorTest(true);
  r.info.autoReset = false;
}

function expectAsTheGraphLeftIt(r: THREE.WebGLRenderer): void {
  expect(r.getRenderTarget()).toBeNull();
  expect(r.getActiveMipmapLevel()).toBe(0);
  expect([r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil]).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(r.getClearColor(new THREE.Color()).getHex()).toBe(0x0a0a0a);
  expect(r.getClearAlpha()).toBe(1);
  expect(r.toneMapping).toBe(THREE.NoToneMapping);
  expect(r.toneMappingExposure).toBe(1);
  expect(r.getScissorTest()).toBe(false);
  expect(r.info.autoReset).toBe(true);
}

describe('withRendererState', () => {
  it('hands back what it ran, with the renderer as the graph left it', () => {
    const r = stubRenderer();
    expect(
      withRendererState(r, () => {
        mess(r);
        return 42;
      }),
    ).toBe(42);
    expectAsTheGraphLeftIt(r);
  });

  it('puts everything back when what it runs throws, and lets the error through', () => {
    const r = stubRenderer();
    expect(() =>
      withRendererState(r, () => {
        mess(r);
        throw new Error('a pass failed');
      }),
    ).toThrow('a pass failed');
    expectAsTheGraphLeftIt(r);
  });
});

describe('assertRendererState', () => {
  // In this order: the check reports once a session, so the quiet case goes first.
  it('says nothing about a renderer left as the graph expects it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    assertRendererState(stubRenderer(), 'the glow pass');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('names what was left changed, once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = stubRenderer();
    mess(r);
    assertRendererState(r, 'the glow pass');
    assertRendererState(r, 'the glow pass');
    expect(error).toHaveBeenCalledTimes(1);
    const text = String(error.mock.calls[0]![0]);
    expect(text).toContain('after the glow pass');
    expect(text).toContain('a render target is still bound');
    expect(text).toContain('tone mapping is on');
    error.mockRestore();
  });
});
