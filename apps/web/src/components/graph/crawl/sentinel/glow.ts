// The Sentinel's glow: its emissive parts drawn alone into a small buffer,
// blurred by three's UnrealBloomPass, and added onto the canvas. Selective by
// construction — only what emits is in that buffer, the rest of the creature
// drawn black so it hides the glow behind it — rather than by a brightness
// threshold, which would also bloom every glint on the polished plates.
//
// The pass is used standalone, never through a composer and never with
// renderToScreen (that path clears the canvas, and the graph with it). Its
// last step adds the blur back onto our buffer with an alpha we never read;
// the blur itself is in `renderTargetsHorizontal[0]`, which is what the
// composite here samples. The pass leaves its input bound as the render
// target (UnrealBloomPass.js:362); the composite binds the canvas again, and
// the caller's withRendererState restores everything else.
//
// The composite adds the blur to the canvas with a soft shoulder, so a hot
// glow runs toward white without ever clipping, encodes it for the canvas and
// dithers it against banding on the near-black background.
//
// Its resolution follows the canvas's drawing buffer times the tier's scale,
// and is reallocated only when that changes: the pass reallocates eleven
// targets on every resize.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const COMPOSITE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }`;

const COMPOSITE_FS = /* glsl */ `
  #include <common>
  #include <dithering_pars_fragment>
  uniform sampler2D tBloom;
  uniform float uExposure;
  uniform float uGain;
  varying vec2 vUv;
  void main() {
    vec3 glow = texture2D( tBloom, vUv ).rgb * uExposure * uGain;
    // Linear for faint glow, easing toward white for a hot one; never past 1.
    glow = 1.0 - exp( -glow );
    // Nothing to add: skip the blend on the canvas's (multisampled) pixels.
    if ( max3( glow ) < 0.0002 ) discard;
    gl_FragColor = linearToOutputTexel( vec4( glow, 1.0 ) );
    #include <dithering_fragment>
  }`;

export interface GlowLook {
  bloomStrength: number;
  bloomRadius: number;
  exposure: number;
}

export class SentinelGlow {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private readonly bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0.25, 0);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Unused by the composite's shader, which writes clip space directly; render() wants one. */
  private readonly screen = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private scale: number;
  private width = 1;
  private height = 1;

  constructor(scale: number) {
    this.scale = scale;
    this.target.texture.name = 'Sentinel glow';
    this.material = new THREE.ShaderMaterial({
      name: 'Sentinel glow composite',
      uniforms: {
        tBloom: { value: this.bloom.renderTargetsHorizontal[0]!.texture },
        uExposure: { value: 1 },
        uGain: { value: 1 },
      },
      vertexShader: COMPOSITE_VS,
      fragmentShader: COMPOSITE_FS,
      toneMapped: false,
      dithering: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Plain addition on colour; the canvas's alpha stays as it is.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.material.customProgramCacheKey = () => 'sentinel-glow-composite-1';
    // One triangle over the whole screen.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
  }

  /** The glow's resolution against the canvas; takes effect on the next frame. */
  setScale(scale: number): void {
    this.scale = scale;
  }

  private fit(bufferWidth: number, bufferHeight: number): void {
    const w = Math.max(1, Math.round(bufferWidth * this.scale));
    const h = Math.max(1, Math.round(bufferHeight * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  /**
   * Draws the glow buffer with `drawEmissive` (which renders the creature
   * with its glow materials into the bound target), blurs it and adds it to
   * the canvas. Changes the renderer's target, clearing and clear colour:
   * call it inside withRendererState.
   */
  render(
    renderer: THREE.WebGLRenderer,
    bufferWidth: number,
    bufferHeight: number,
    look: GlowLook,
    drawEmissive: () => void,
    gain = 1,
  ): void {
    this.fit(bufferWidth, bufferHeight);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    drawEmissive();
    this.bloom.strength = look.bloomStrength;
    // Wider than this, the largest blur rings reach the screen's edge.
    this.bloom.radius = Math.max(0, Math.min(0.3, look.bloomRadius));
    this.bloom.render(renderer, this.target, this.target, 0, false);
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    this.material.uniforms.uExposure!.value = look.exposure;
    this.material.uniforms.uGain!.value = gain;
    renderer.render(this.quad, this.screen);
  }

  /** Uses every program the glow needs once, adding nothing to the canvas. */
  warm(
    renderer: THREE.WebGLRenderer,
    bufferWidth: number,
    bufferHeight: number,
    drawEmissive: () => void,
  ): void {
    this.render(
      renderer,
      bufferWidth,
      bufferHeight,
      { bloomStrength: 0, bloomRadius: 0, exposure: 1 },
      drawEmissive,
      0,
    );
  }

  dispose(): void {
    this.target.dispose();
    this.bloom.dispose();
    // r180's UnrealBloomPass.dispose() misses its high-pass material, whose
    // program would otherwise live as long as the renderer: the graph's own.
    this.bloom.materialHighPassFilter.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
