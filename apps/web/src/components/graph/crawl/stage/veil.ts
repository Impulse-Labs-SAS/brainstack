// The dark a space sits in, laid over it at an opacity: how the prompt scene
// fades the cluster in and out without touching a single one of its shaders.
// The space draws as ever, whole, and one triangle over the whole screen in
// the graph's own background mixes it toward that background — so the
// crystals, threads, tubes and halos all fade together, at one cost, and
// nothing the space draws needs a level of its own.
//
// It tests no depth and writes none: the space's depth is left as the space
// wrote it, and whoever draws next decides what to do with it. (While the
// cluster is veiled the prompt scene clears it, so crystals veiled almost to
// nothing cannot cut holes in the creature.) Every renderer change goes through
// `withRendererState`, as every pass drawn into the graph's renderer does.

import * as THREE from 'three';

import { withRendererState } from '../sentinel/gl-state';
import { linear } from '../sentinel/palette';

/** The graph's background, which graph-scene.ts and every space clear to. */
const BACKGROUND = '#0a0a0a';

const VEIL_VS = /* glsl */ `
  void main() {
    // Straight to clip space: no camera, no depth.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const VEIL_FS = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  void main() {
    gl_FragColor = linearToOutputTexel(vec4(uColour, uOpacity));
  }
`;

export class Veil {
  private readonly scene = new THREE.Scene();
  /** Never read by the shader; three's render wants a camera all the same. */
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private drawn = { calls: 0, triangles: 0 };
  /** A compile still polling: the material must outlive it. */
  private compiling: Promise<unknown> | null = null;
  private disposed = false;

  constructor(colour: string = BACKGROUND) {
    const [r, g, b] = linear(colour);
    this.material = new THREE.ShaderMaterial({
      name: 'brainstack-prompt-veil',
      uniforms: {
        uColour: { value: new THREE.Vector3(r, g, b) },
        uOpacity: { value: 0 },
      },
      vertexShader: VEIL_VS,
      fragmentShader: VEIL_FS,
      toneMapped: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    // One triangle over the whole screen.
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    const quad = new THREE.Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    quad.matrixAutoUpdate = false;
    this.scene.add(quad);
  }

  /** What its last draw cost: one call and one triangle, or nothing. */
  get info(): { calls: number; triangles: number } {
    return this.drawn;
  }

  /**
   * Compiles its program for the canvas, and uses it once at opacity 0 —
   * which leaves the canvas as it was — under its own error handler, so a
   * shader that fails rejects here rather than mid-transition.
   */
  async warmup(renderer: THREE.WebGLRenderer): Promise<void> {
    if (this.disposed) throw new Error('Veil: warmup after dispose');
    const r = renderer;
    this.compiling = withRendererState(r, () => {
      r.setRenderTarget(null);
      return r.compileAsync(this.scene, this.camera);
    });
    try {
      await this.compiling;
    } finally {
      this.compiling = null;
    }
    if (this.disposed) throw new Error('Veil: disposed while warming up');
    const failures: string[] = [];
    withRendererState(r, () => {
      const previous = r.debug.onShaderError;
      r.debug.onShaderError = (gl, _program, vertex, fragment) => {
        const logs = [gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)];
        failures.push(logs.filter((l) => l && l.trim()).join('\n') || 'link failed');
      };
      try {
        this.material.uniforms.uOpacity!.value = 0;
        r.setRenderTarget(null);
        r.autoClear = false;
        r.render(this.scene, this.camera);
      } finally {
        r.debug.onShaderError = previous;
      }
    });
    if (failures.length) throw new Error(`Veil shader failed:\n${failures.join('\n')}`);
  }

  /** The background over what the canvas holds, at `opacity` (0–1; nothing at 0). Never clears. */
  render(renderer: THREE.WebGLRenderer, opacity: number): void {
    this.drawn = { calls: 0, triangles: 0 };
    const a = Math.min(1, opacity);
    if (this.disposed || !(a > 0)) return;
    const r = renderer;
    withRendererState(r, () => {
      r.info.autoReset = false;
      r.info.reset();
      r.setRenderTarget(null);
      r.autoClear = false;
      this.material.uniforms.uOpacity!.value = a;
      r.render(this.scene, this.camera);
      this.drawn = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    // A compile still polling reads its material's state until it settles.
    const free = () => this.material.dispose();
    if (this.compiling) this.compiling.then(free, free);
    else free();
    this.scene.clear();
  }
}
