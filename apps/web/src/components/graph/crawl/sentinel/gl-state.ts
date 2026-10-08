// The Sentinel borrows the graph's own renderer, and the graph trusts that
// renderer to be exactly as it left it: no render target bound, clearing on,
// a #0a0a0a background, no tone mapping. A leak would not stay in Crawl — a
// bound target makes Brain, Network and Territories draw into the creature's
// buffer, a leaked autoClear smears every frame, a leaked tone mapping
// recompiles every graph material.
//
// So every change the Sentinel makes goes through `withRendererState`, which
// puts it all back in a `finally`, whatever throws; and in development
// `assertRendererState` checks, after each of its hooks, that it did.

import * as THREE from 'three';

/** Runs `fn` and restores whatever renderer state it may change, even if it throws. */
export function withRendererState<T>(renderer: THREE.WebGLRenderer, fn: () => T): T {
  const target = renderer.getRenderTarget();
  const cubeFace = renderer.getActiveCubeFace();
  const mipLevel = renderer.getActiveMipmapLevel();
  const autoClear = renderer.autoClear;
  const autoClearColor = renderer.autoClearColor;
  const autoClearDepth = renderer.autoClearDepth;
  const autoClearStencil = renderer.autoClearStencil;
  const clearColor = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  const toneMapping = renderer.toneMapping;
  const exposure = renderer.toneMappingExposure;
  const scissorTest = renderer.getScissorTest();
  const infoAutoReset = renderer.info.autoReset;
  try {
    return fn();
  } finally {
    // Binding the canvas again also restores its viewport (the renderer's size × pixel ratio).
    renderer.setRenderTarget(target, cubeFace, mipLevel);
    renderer.autoClear = autoClear;
    renderer.autoClearColor = autoClearColor;
    renderer.autoClearDepth = autoClearDepth;
    renderer.autoClearStencil = autoClearStencil;
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = exposure;
    renderer.setScissorTest(scissorTest);
    renderer.info.autoReset = infoAutoReset;
  }
}

/** The state graph-scene.ts sets up and expects every frame. */
const GRAPH_CLEAR = 0x0a0a0a;

let reported = false;
const scratch = new THREE.Color();

/**
 * Development only: complains, once, if the renderer is not as the graph
 * expects it after the Sentinel drew. `label` says which step to look at.
 */
export function assertRendererState(renderer: THREE.WebGLRenderer, label: string): void {
  if (process.env.NODE_ENV === 'production' || reported) return;
  const wrong: string[] = [];
  if (renderer.getRenderTarget() !== null) wrong.push('a render target is still bound');
  if (!renderer.autoClear || !renderer.autoClearColor || !renderer.autoClearDepth) {
    wrong.push('clearing is off');
  }
  if (renderer.getClearColor(scratch).getHex() !== GRAPH_CLEAR) {
    wrong.push(`the clear colour is #${scratch.getHexString()}`);
  }
  if (renderer.getClearAlpha() !== 1) wrong.push(`the clear alpha is ${renderer.getClearAlpha()}`);
  if (renderer.toneMapping !== THREE.NoToneMapping) wrong.push('tone mapping is on');
  if (renderer.toneMappingExposure !== 1) {
    wrong.push(`the exposure is ${renderer.toneMappingExposure}`);
  }
  if (renderer.getScissorTest()) wrong.push('the scissor test is on');
  if (wrong.length === 0) return;
  reported = true;
  console.error(
    `Sentinel: after ${label}, the graph's renderer was left changed: ${wrong.join('; ')}.`,
  );
}
