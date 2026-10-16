// The dotted lines under a lifted block: from its four bottom corners down to the plate it
// stands on, and its footprint there, so a block raised by a hover or a selection still says
// where it belongs. Few at a time — the selected note, the one pointed at — in one draw of
// line segments, depth-tested so what the block itself hides stays hidden.
//
// A small shader, not LineDashedMaterial, so the colours come out exactly as the boxes'
// do: sRGB as written, whatever the renderer's colour management.

import * as THREE from 'three';

import { lineArtRgb, type LineArtTheme } from '@/lib/graph-theme';

export interface LiftMark {
  /** The block's footprint, world units. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The z it stands at: its plate's top. */
  base: number;
  /** The z of its bottom now, raised. */
  lifted: number;
  color: 'accent' | 'hover';
}

/** The dotted lines' rhythm, CSS pixels on and off. */
export const DOT_PX = { on: 1.5, off: 2.5 } as const;
/** Four verticals and the footprint's four sides. */
export const SEGMENTS_PER_MARK = 8;
/** Below this lift a mark would only darken the block's own bottom edges: it is left out. */
export const MIN_LIFT = 0.02;
/**
 * How far above the plate the footprint is drawn, world units. On the plate's own top, a line
 * and a face fight for the same depth and the line shows in patches.
 */
export const FOOT_RAISE = 0.005;

const DEFAULT_CAPACITY = 4;
const VERTICES_PER_MARK = SEGMENTS_PER_MARK * 2;

const VERTEX = /* glsl */ `
precision highp float;

uniform vec3 uAccent;
uniform vec3 uHover;

in float aDist;
in float aHover;

out float vDist;
flat out vec3 vColor;

void main() {
  vDist = aDist;
  vColor = aHover > 0.5 ? uHover : uAccent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform float uDash;
uniform float uGap;

in float vDist;
flat in vec3 vColor;

layout(location = 0) out highp vec4 fragColor;

void main() {
  if (mod(vDist, uDash + uGap) > uDash) discard;
  fragColor = vec4(vColor, 1.0);
}
`;

interface Buffers {
  position: THREE.BufferAttribute;
  dist: THREE.BufferAttribute;
  hover: THREE.BufferAttribute;
}

function dynamic(count: number, size: number) {
  const attribute = new THREE.BufferAttribute(new Float32Array(count * size), size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function markGeometry(capacity: number): { geometry: THREE.BufferGeometry; buffers: Buffers } {
  const vertices = capacity * VERTICES_PER_MARK;
  const buffers: Buffers = {
    position: dynamic(vertices, 3),
    dist: dynamic(vertices, 1),
    hover: dynamic(vertices, 1),
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', buffers.position);
  geometry.setAttribute('aDist', buffers.dist);
  geometry.setAttribute('aHover', buffers.hover);
  geometry.setDrawRange(0, 0);
  return { geometry, buffers };
}

export class LiftMarks {
  readonly object: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly uniforms = {
    uAccent: { value: new THREE.Vector3() },
    uHover: { value: new THREE.Vector3() },
    uDash: { value: DOT_PX.on / 10 },
    uGap: { value: DOT_PX.off / 10 },
  };
  private buffers: Buffers;
  private capacity: number;

  constructor(theme: LineArtTheme) {
    this.capacity = DEFAULT_CAPACITY;
    const { geometry, buffers } = markGeometry(this.capacity);
    this.buffers = buffers;
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: true,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });
    this.object = new THREE.LineSegments(geometry, material);
    // Its vertices move every frame of a lift; a bounding sphere would always be stale.
    this.object.frustumCulled = false;
    // After the boxes, which it is depth-tested against.
    this.object.renderOrder = 1;
    this.object.visible = false;
    this.setTheme(theme);
  }

  /**
   * Dotted verticals from a lifted block's four bottom corners down to where it stands, and its
   * footprint there. Dashes 1.5 px on, 2.5 off, made world units by `ppu`.
   */
  set(marks: readonly LiftMark[], ppu: number): void {
    const shown = marks.filter((m) => m.lifted - m.base > MIN_LIFT);
    if (shown.length > this.capacity) this.grow(Math.max(shown.length, this.capacity * 2));
    const position = this.buffers.position.array as Float32Array;
    const dist = this.buffers.dist.array as Float32Array;
    const hover = this.buffers.hover.array as Float32Array;
    let v = 0;
    const segment = (a: readonly number[], b: readonly number[], hot: number) => {
      position.set(a, v * 3);
      position.set(b, v * 3 + 3);
      dist[v] = 0;
      dist[v + 1] = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      hover[v] = hot;
      hover[v + 1] = hot;
      v += 2;
    };
    for (const m of shown) {
      const hot = m.color === 'hover' ? 1 : 0;
      const foot = m.base + FOOT_RAISE;
      const corners = [
        [m.x0, m.y0],
        [m.x1, m.y0],
        [m.x1, m.y1],
        [m.x0, m.y1],
      ] as const;
      // From the block down, so each line leaves its corner on a dot.
      for (const [x, y] of corners) segment([x, y, m.lifted], [x, y, foot], hot);
      corners.forEach(([x, y], k) => {
        const [nx, ny] = corners[(k + 1) % 4]!;
        segment([x, y, foot], [nx, ny, foot], hot);
      });
    }
    if (v > 0) {
      for (const attribute of Object.values(this.buffers)) {
        // What is drawn now covers anything queued before it.
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, v * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    this.object.geometry.setDrawRange(0, v);
    this.object.visible = v > 0;
    const scale = Number.isFinite(ppu) && ppu > 0 ? ppu : 1;
    this.uniforms.uDash.value = DOT_PX.on / scale;
    this.uniforms.uGap.value = DOT_PX.off / scale;
  }

  setTheme(theme: LineArtTheme): void {
    this.uniforms.uAccent.value.fromArray(lineArtRgb(theme.accent));
    this.uniforms.uHover.value.fromArray(lineArtRgb(theme.hoverEdge));
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  /** New buffers, in a new geometry: disposing the old one frees its GPU buffers with it. */
  private grow(capacity: number): void {
    const { geometry, buffers } = markGeometry(capacity);
    this.object.geometry.dispose();
    this.object.geometry = geometry;
    this.buffers = buffers;
    this.capacity = capacity;
  }
}
