// The dot grid on the ground under the line-art map: one quad at z = 0 over the map's
// bounds, its fragment shader putting a round dot at every lattice point. Round on screen,
// not on the ground: the dot is measured in screen pixels, so a tilted view does not squash
// it into an ellipse, and its size holds at any zoom.
//
// The lattice coarsens as the map zooms out, a doubling at a time, so dots never crowd into a
// texture; plates hide it where they stand, by the depth test.

import * as THREE from 'three';

import { lineArtRgb, type LineArtTheme } from '@/lib/graph-theme';

/** World units of ground shown past the map's bounds on every side. */
export const GRID_MARGIN = 4;
/** The finest lattice, in world units, and how close on screen its dots may come. */
const BASE_SPACING = 2;
const MIN_GAP_PX = 9;

/** World units between dots: 2, doubled until they stand at least 9 CSS pixels apart. */
export function gridSpacing(ppu: number): number {
  let s = BASE_SPACING;
  // Bounded, so a ppu of 0 or NaN cannot hang a frame.
  for (let k = 0; k < 40 && !(s * ppu >= MIN_GAP_PX); k++) s *= 2;
  return s;
}

/** A dot's diameter in CSS pixels: a touch larger once cells are big. */
export function dotPx(ppu: number): number {
  return ppu >= 20 ? 1.6 : 1.2;
}

const VERTEX = /* glsl */ `
precision highp float;

out vec2 vGround;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vGround = world.xy;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uSpacing;
uniform float uDotPx;
uniform float uDpr;

in vec2 vGround;

layout(location = 0) out highp vec4 fragColor;

void main() {
  // How the ground moves per device pixel right and down: its inverse takes a ground offset to
  // the screen, exactly, since an orthographic view is affine.
  mat2 toGround = mat2(dFdx(vGround), dFdy(vGround));
  float det = determinant(toGround);
  if (abs(det) < 1e-12) discard;
  vec2 offset = (fract(vGround / uSpacing + 0.5) - 0.5) * uSpacing;
  float px = length(inverse(toGround) * offset) / uDpr;
  float r = 0.5 * uDotPx;
  float aa = 0.5 / uDpr;
  float alpha = 1.0 - smoothstep(r - aa, r + aa, px);
  if (alpha <= 0.0) discard;
  fragColor = vec4(uColor, alpha);
}
`;

export class GroundGrid {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly uniforms = {
    uColor: { value: new THREE.Vector3() },
    uSpacing: { value: BASE_SPACING },
    uDotPx: { value: dotPx(0) },
    uDpr: { value: 1 },
  };

  constructor(theme: LineArtTheme) {
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.FrontSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    // A unit quad facing up, placed and stretched over the bounds.
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = -1;
    this.setTheme(theme);
    this.setBounds(0, 0, 0, 0);
  }

  /** The map's extent on the ground, world units at z = 0; the grid runs GRID_MARGIN past it. */
  setBounds(x0: number, y0: number, x1: number, y1: number): void {
    const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
    this.mesh.position.set((ax + bx) / 2, (ay + by) / 2, 0);
    this.mesh.scale.set(bx - ax + 2 * GRID_MARGIN, by - ay + 2 * GRID_MARGIN, 1);
    this.mesh.updateMatrix();
  }

  /** Spacing 2 units, doubled until at least 9 CSS pixels apart; dots ~1.2 px, 1.6 from 20 ppu. */
  setScale(ppu: number, dpr: number): void {
    this.uniforms.uSpacing.value = gridSpacing(ppu);
    this.uniforms.uDotPx.value = dotPx(ppu);
    this.uniforms.uDpr.value = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  setTheme(theme: LineArtTheme): void {
    this.uniforms.uColor.value.fromArray(lineArtRgb(theme.grid));
  }

  setVisible(on: boolean): void {
    this.mesh.visible = on;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
