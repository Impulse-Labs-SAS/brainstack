// A stand-in for the graph, so the lab can judge the Sentinel against
// something that blends the way the brain does: the sample vault's notes as
// soft points, its threads as the six chords the scene draws, and the brain's
// own mesh points behind them. The materials follow graph-scene.ts — raw
// ShaderMaterials, additive, no depth test or write, no tone mapping, colour
// written as is — so drawn under the creature it lights the metal's edges the
// way the graph will, and drawn over it, it shows what an additive graph on
// top would do to a dark body. It is not the graph: no nebulae, focus,
// labels or search lift.

import * as THREE from 'three';

import { brainScaleFor, makeBrainMesh } from '@/lib/graph-brain';
import {
  FOV_DEG,
  TAN_HALF_FOV,
  basis,
  nearPlane,
  type Camera,
  type Viewport,
} from '@/lib/graph-camera';
import { colorOf, type GraphEdge, type GraphModel } from '@/lib/graph-model';

import { walkable } from '../../crawl-plan';
import { THREAD_CHORDS, at, onEdge } from '../../threads';

const DEPTH_GLSL = /* glsl */ `
  uniform float uFocusDist;
  uniform float uDepthRange;
  float depthFade( float depth ) { return clamp( 1.0 - ( depth - uFocusDist ) / uDepthRange, 0.2, 1.0 ); }`;

const NOTE_VS = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPxPerUnit;
  uniform float uMinPx;
  uniform float uMaxPx;
  ${DEPTH_GLSL}
  varying vec3 vColor;
  varying float vCoreR;
  varying float vAA;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    float depth = max( -mv.z, 1.0 );
    float rPx = clamp( aSize * uPxPerUnit / depth, uMinPx, uMaxPx );
    float spriteR = rPx * 3.4 + 3.0;
    gl_PointSize = spriteR * 2.0;
    vCoreR = rPx / spriteR;
    vAA = 1.5 / spriteR;
    vColor = aColor;
    vFade = depthFade( depth );
  }`;

// The graph's note sprite, circle only: a halo and a whitened core.
const NOTE_FS = /* glsl */ `
  uniform float uGlow;
  uniform float uCore;
  varying vec3 vColor;
  varying float vCoreR;
  varying float vAA;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length( uv );
    if ( d > 1.0 ) discard;
    float cr = vCoreR;
    float halo = exp( -d * d / ( cr * cr * 3.0 ) ) * 0.85 + exp( -d * d * 4.0 ) * 0.18;
    float coreM = 1.0 - smoothstep( cr - vAA, cr + vAA, d );
    vec3 coreCol = mix( vColor, vec3( 1.0 ), 0.6 );
    gl_FragColor = vec4( ( vColor * halo * uGlow + coreCol * coreM * uCore ) * vFade, 1.0 );
  }`;

const LINE_VS = /* glsl */ `
  attribute vec3 aColor;
  ${DEPTH_GLSL}
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    vFade = depthFade( -mv.z );
    vColor = aColor;
  }`;

const LINE_FS = /* glsl */ `
  varying vec3 vColor;
  varying float vFade;
  void main() {
    gl_FragColor = vec4( vColor * vFade, 1.0 );
  }`;

const MESH_POINT_VS = /* glsl */ `
  uniform float uSize;
  ${DEPTH_GLSL}
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize;
    vFade = depthFade( -mv.z );
  }`;

const MESH_POINT_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = dot( uv, uv );
    if ( d > 1.0 ) discard;
    gl_FragColor = vec4( uColor * ( 1.0 - d ) * uAlpha * vFade, 1.0 );
  }`;

/** graph-scene.ts's thread brightness by kind, for the two kinds a crawl walks. */
const THREAD_INTENSITY = { link: 0.22, structure: 0.08 } as const;
/** A note's halo and core at a middling activity, as graph-scene.ts levels them. */
const NOTE_GLOW = 0.2;
const NOTE_CORE = 0.6;
/** Points of the brain's mesh: fewer than the graph's 6000, enough to read as it. */
const BRAIN_POINTS = 4000;

function material(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFocusDist: { value: 1 }, uDepthRange: { value: 1e9 }, ...uniforms },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function dynamic(geometry: THREE.BufferGeometry, name: string, size: number, count: number) {
  const attribute = new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * size), size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attribute);
  return attribute;
}

export class LabBackdrop {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 10);
  private readonly threads: GraphEdge[];
  private readonly notePosition: THREE.BufferAttribute;
  private readonly threadPosition: THREE.BufferAttribute;
  private readonly noteMaterial: THREE.ShaderMaterial;
  private readonly lineMaterial: THREE.ShaderMaterial;
  private readonly brainMaterial: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly brainScale: number;

  constructor(private readonly model: GraphModel) {
    this.brainScale = brainScaleFor(model.nodes.length);
    this.threads = model.edges.filter(walkable);

    const notes = new THREE.BufferGeometry();
    this.notePosition = dynamic(notes, 'position', 3, model.nodes.length);
    const noteColor = new Float32Array(model.nodes.length * 3);
    const noteSize = new Float32Array(model.nodes.length);
    model.nodes.forEach((n, i) => {
      const rgb = colorOf(model, n).rgb;
      noteColor.set([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255], i * 3);
      noteSize[i] = n.radius;
    });
    notes.setAttribute('aColor', new THREE.BufferAttribute(noteColor, 3));
    notes.setAttribute('aSize', new THREE.BufferAttribute(noteSize, 1));
    this.noteMaterial = material(NOTE_VS, NOTE_FS, {
      uPxPerUnit: { value: 1 },
      uMinPx: { value: 1.8 },
      uMaxPx: { value: 11 },
      uGlow: { value: NOTE_GLOW },
      uCore: { value: NOTE_CORE },
    });

    // Each thread as the scene cuts it: six chords, two vertices each.
    const lines = new THREE.BufferGeometry();
    const vertices = this.threads.length * THREAD_CHORDS * 2;
    this.threadPosition = dynamic(lines, 'position', 3, vertices);
    const lineColor = new Float32Array(Math.max(1, vertices) * 3);
    this.threads.forEach((e, o) => {
      const rgb = colorOf(model, e.source).rgb;
      const k = e.kind === 'structure' ? THREAD_INTENSITY.structure : THREAD_INTENSITY.link;
      for (let v = 0; v < THREAD_CHORDS * 2; v++) {
        lineColor.set(
          [(rgb[0] / 255) * k, (rgb[1] / 255) * k, (rgb[2] / 255) * k],
          (o * THREAD_CHORDS * 2 + v) * 3,
        );
      }
    });
    lines.setAttribute('aColor', new THREE.BufferAttribute(lineColor, 3));
    this.lineMaterial = material(LINE_VS, LINE_FS, {});

    // The brain's mesh, at the size the graph would give this many notes.
    const brain = new THREE.BufferGeometry();
    const mesh = makeBrainMesh(BRAIN_POINTS).points;
    const scaled = new Float32Array(mesh.length);
    for (let i = 0; i < mesh.length; i++) scaled[i] = mesh[i]! * this.brainScale;
    brain.setAttribute('position', new THREE.BufferAttribute(scaled, 3));
    this.brainMaterial = material(MESH_POINT_VS, MESH_POINT_FS, {
      uSize: { value: 1.6 },
      uColor: { value: new THREE.Color(0.86, 0.85, 0.95) },
      uAlpha: { value: 0.55 },
    });

    const brainPoints = new THREE.Points(brain, this.brainMaterial);
    const threadLines = new THREE.LineSegments(lines, this.lineMaterial);
    const notePoints = new THREE.Points(notes, this.noteMaterial);
    for (const object of [brainPoints, threadLines, notePoints]) {
      object.frustumCulled = false;
      this.scene.add(object);
    }
    this.geometries.push(notes, lines, brain);
    this.place();
  }

  /** Reads the notes' positions again: the layout moved. */
  place(): void {
    const pos = this.notePosition.array as Float32Array;
    this.model.nodes.forEach((n, i) => pos.set(at(n), i * 3));
    this.notePosition.needsUpdate = true;
    const line = this.threadPosition.array as Float32Array;
    this.threads.forEach((e, o) => {
      let k = o * THREAD_CHORDS * 6;
      let prev = onEdge(e, 0);
      for (let c = 1; c <= THREAD_CHORDS; c++) {
        const next = onEdge(e, c / THREAD_CHORDS);
        line.set(prev, k);
        line.set(next, k + 3);
        k += 6;
        prev = next;
      }
    });
    this.threadPosition.needsUpdate = true;
  }

  /** Draws into whatever the renderer is bound to, with its current clearing: the caller decides. */
  render(renderer: THREE.WebGLRenderer, cam: Camera, vp: Viewport, dpr: number): void {
    const pxPerUnit = (vp.height * dpr) / 2 / TAN_HALF_FOV;
    const notes = this.noteMaterial.uniforms;
    notes.uPxPerUnit!.value = pxPerUnit;
    notes.uMinPx!.value = 1.8 * dpr;
    notes.uMaxPx!.value = 11 * dpr;
    this.brainMaterial.uniforms.uSize!.value = 1.6 * dpr;
    for (const m of [this.noteMaterial, this.lineMaterial, this.brainMaterial]) {
      m.uniforms.uFocusDist!.value = cam.dist;
      m.uniforms.uDepthRange!.value = this.brainScale * 1.4;
    }

    // The graph's camera, exactly as graph-scene.ts places it.
    const { position, up } = basis(cam);
    this.camera.position.set(position[0], position[1], position[2]);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.lookAt(cam.tx, cam.ty, cam.tz);
    const near = nearPlane(cam);
    const far = cam.dist * 4 + this.brainScale * 12 + 4000;
    const aspect = vp.width / vp.height;
    if (this.camera.near !== near || this.camera.far !== far || this.camera.aspect !== aspect) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of [this.noteMaterial, this.lineMaterial, this.brainMaterial]) m.dispose();
  }
}
