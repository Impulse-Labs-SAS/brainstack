// What the GPU can do, asked once before the Sentinel is built — the impure
// half of quality.ts, which turns the answer into a starting tier.
//
// It asks the graph's own renderer: a throwaway context with
// `failIfMajorPerformanceCaveat` could push the graph's out under the
// browser's context limit, and the renderer string already names a software
// rasteriser. Every probe puts the renderer back as it found it.

import * as THREE from 'three';

import { classifyRenderer, type Caps } from './quality';

export function probeCaps(renderer: THREE.WebGLRenderer): Caps {
  const gl = renderer.getContext();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  return {
    renderer: rendererName(gl),
    floatColor: rendersHalfFloat(renderer),
    maxSamples: renderer.capabilities.maxSamples,
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    dpr: renderer.getPixelRatio(),
    pixels: size.x * size.y,
  };
}

/**
 * The GPU's name. Firefox reports a real, sanitised one as `RENDERER` and
 * warns that the debug extension is deprecated, so the extension is only asked
 * when `RENDERER` is masked — a bare "WebKit WebGL", say.
 */
function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string | null {
  const plain = text(gl.getParameter(gl.RENDERER));
  if (classifyRenderer(plain) !== 'unknown') return plain;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = debug ? text(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
  return unmasked ?? plain;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Whether bloom and the environment can render at all. They use half-float
 * targets unconditionally, and three never checks a framebuffer's status: an
 * incomplete one just draws black. So a 4×4 target of the same kind — single
 * sample, like the glow pass — is bound and asked.
 */
function rendersHalfFloat(renderer: THREE.WebGLRenderer): boolean {
  if (!renderer.extensions.has('EXT_color_buffer_float')) return false;
  const gl = renderer.getContext();
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  try {
    renderer.setRenderTarget(target);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    renderer.setRenderTarget(previous, face, level);
    target.dispose();
  }
}
