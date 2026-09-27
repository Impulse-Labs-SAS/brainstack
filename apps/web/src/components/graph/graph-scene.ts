// The WebGL half of the graph: notes, edges, nebulae, the brain mesh and the
// map's land. Everything but the land draws additively on a flat background,
// so brightness is the only thing that ever changes — colour times intensity,
// no sorting, no alpha blending order to get wrong. The land is the exception:
// translucent country fills, drawn first, under everything else. Text, rings,
// borders and the focus signal are drawn by the 2D overlay on top
// (graph-overlay.ts); WebGL lines are one pixel wide.

import * as THREE from 'three';

import { makeBrainMesh } from '@/lib/graph-brain';
import { FOV_DEG, TAN_HALF_FOV, basis, nearPlane, type Camera, type Viewport } from '@/lib/graph-camera';
import type { MapLand } from '@/lib/graph-map';
import { BRIDGE_COLOR } from '@/lib/graph-palette';
import { activity, colorOf, isActive, type GraphEdge, type GraphModel, type GraphNode, type GraphView } from '@/lib/graph-model';

/** Everything one frame of the scene depends on. */
export interface SceneFrame {
  now: number;
  /** Milliseconds since the last frame: fades go by time, not by frame count. */
  dt: number;
  /** Date.now(), for how recently notes were edited. */
  wallClock: number;
  cam: Camera;
  vp: Viewport;
  dpr: number;
  is3D: boolean;
  brainScale: number;
  /** 0 = notes, 1 = projects (semantic zoom). */
  cloud: number;
  view: GraphView;
  /** How much of the map's land shows: 0 away from Territories, 1 once the notes are in place. */
  landAlpha: number;
  /** 0 → 1 as the notes turn into the map's even-sized cities. */
  mapBlend: number;
  /** The country under the pointer, lit a little brighter. */
  hotCountry: string | null;
  /** Edge brightness for the view: 1 in Brain and Network, none or faint routes on the map. */
  edgeScale: number;
  hops: Map<GraphNode, number> | null;
  pathNodes: Set<GraphNode> | null;
  pathEdges: Set<GraphEdge> | null;
  matched: Set<GraphNode> | null;
  /** The layout moved since the last frame: positions need uploading. */
  moved: boolean;
  /** Focus, filter or appearance changed: edge brightness needs recomputing. */
  edgesDirty: boolean;
  appear(n: GraphNode): number;
  flash(n: GraphNode): number;
  reduceMotion: boolean;
}

const DEPTH_GLSL = /* glsl */ `
  uniform float uFocusDist; uniform float uDepthRange; uniform float uMinFade;
  float depthFade(float depth) { return clamp(1.0 - (depth - uFocusDist) / uDepthRange, uMinFade, 1.0); }`;

const NODE_VS = /* glsl */ `
  attribute vec3 aColor; attribute float aSize; attribute float aShape;
  attribute float aGlow; attribute float aCore; attribute float aFlash;
  uniform float uPxPerUnit; uniform float uMinPx; uniform float uMaxPx;
  ${DEPTH_GLSL}
  varying vec3 vColor; varying float vShape; varying float vGlow; varying float vCore;
  varying float vCoreR; varying float vAA; varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(-mv.z, 1.0);
    float rPx = clamp(aSize * uPxPerUnit / depth, uMinPx, uMaxPx);
    float spriteR = rPx * (3.4 + aFlash * 5.0) + 3.0;
    gl_PointSize = spriteR * 2.0;
    vCoreR = rPx / spriteR;
    vAA = 1.5 / spriteR;
    vColor = aColor; vShape = aShape; vGlow = aGlow; vCore = aCore;
    vFade = depthFade(depth);
  }`;

// Shapes: 0 circle (note), 1 rounded square (index), 2 hollow hexagon (topic);
// +4 adds the ring that marks somebody else's note. `uRing` fades that ring
// out on the map, where the note's whole continent already says whose it is.
const NODE_FS = /* glsl */ `
  uniform float uRing;
  varying vec3 vColor; varying float vShape; varying float vGlow; varying float vCore;
  varying float vCoreR; varying float vAA; varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length(uv);
    if (d > 1.0) discard;
    float ring = step(3.5, vShape);
    float s = vShape - ring * 4.0;
    float cr = vCoreR;
    float halo = exp(-d * d / (cr * cr * 3.0)) * 0.85 + exp(-d * d * 4.0) * 0.18;
    float sd = s < 0.5 ? d : (s < 1.5 ? max(abs(uv.x), abs(uv.y)) * 1.1 : max(abs(uv.x) * 0.866 + abs(uv.y) * 0.5, abs(uv.y)));
    float coreM = 1.0 - smoothstep(cr - vAA, cr + vAA, sd);
    if (s > 1.5) coreM *= smoothstep(cr * 0.55 - vAA, cr * 0.55 + vAA, sd);
    float ringM = ring * uRing * (1.0 - smoothstep(vAA * 0.6, vAA * 1.7, abs(d - cr * 1.6)));
    vec3 coreCol = mix(vColor, vec3(1.0), 0.6);
    vec3 col = vColor * halo * vGlow + coreCol * coreM * vCore + vColor * ringM * vCore;
    gl_FragColor = vec4(col * vFade, 1.0);
  }`;

const LINE_VS = /* glsl */ `
  attribute vec3 aColor; attribute float aDist;
  ${DEPTH_GLSL}
  varying vec3 vColor; varying float vDist; varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vFade = depthFade(-mv.z);
    vColor = aColor; vDist = aDist;
  }`;
const LINE_FS = /* glsl */ `
  uniform float uDash; uniform float uAlpha;
  varying vec3 vColor; varying float vDist; varying float vFade;
  void main() {
    if (uDash > 0.0 && mod(vDist, uDash) > uDash * 0.42) discard;
    gl_FragColor = vec4(vColor * vFade * uAlpha, 1.0);
  }`;

const NEBULA_VS = /* glsl */ `
  attribute vec3 aColor; attribute float aSize;
  uniform float uPxPerUnit; uniform float uMaxPx;
  ${DEPTH_GLSL}
  varying vec3 vColor; varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(-mv.z, 1.0);
    gl_PointSize = clamp(aSize * uPxPerUnit / depth * 2.0, 2.0, uMaxPx);
    vColor = aColor; vFade = depthFade(depth);
  }`;
const NEBULA_FS = /* glsl */ `
  varying vec3 vColor; varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(uv, uv);
    if (d2 > 1.0) discard;
    gl_FragColor = vec4(vColor * exp(-d2 * 3.2) * (1.0 - d2) * vFade, 1.0);
  }`;

const LAND_VS = /* glsl */ `
  attribute vec3 aColor; attribute float aCountry;
  uniform float uHot;
  varying vec3 vColor; varying float vHot;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vHot = abs(aCountry - uHot) < 0.5 ? 1.0 : 0.0;
  }`;
const LAND_FS = /* glsl */ `
  uniform float uAlpha;
  varying vec3 vColor; varying float vHot;
  void main() {
    gl_FragColor = vec4(vColor, uAlpha * mix(0.19, 0.36, vHot));
  }`;

const MESH_POINT_VS = /* glsl */ `
  uniform float uSize;
  ${DEPTH_GLSL}
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize;
    vFade = depthFade(-mv.z);
  }`;
const MESH_POINT_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = dot(uv, uv);
    if (d > 1.0) discard;
    gl_FragColor = vec4(uColor * (1.0 - d) * uAlpha * vFade, 1.0);
  }`;

type Uniforms = Record<string, THREE.IUniform>;

function material(vertexShader: string, fragmentShader: string, extra: Uniforms = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFocusDist: { value: 1 }, uDepthRange: { value: 1e9 }, uMinFade: { value: 1 }, ...extra },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function dynamic(geometry: THREE.BufferGeometry, name: string, itemSize: number, count: number): Float32Array {
  const array = new Float32Array(Math.max(1, count) * itemSize);
  const attribute = new THREE.BufferAttribute(array, itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attribute);
  return array;
}

const SEGMENTS = 6;
const EDGE_INTENSITY: Record<GraphEdge['kind'], number> = { link: 0.22, structure: 0.08, topic: 0.12, affinity: 0.26 };
const AFFINITY_RGB = [0.65, 0.64, 0.72] as const;
const TOPIC_RGB = [0.6, 0.59, 0.68] as const;
/** Network: a link from one project to another, which is what that view is for. */
const BRIDGE_RGB = BRIDGE_COLOR.rgb.map((c) => c / 255) as unknown as readonly [number, number, number];
const BRIDGE_BOOST = 1.6;
/** Countries of one vault take its hue in four shades: itself, lighter, darker, lighter still. */
const SHADES = [0, 0.26, -0.3, 0.5];

function shade(rgb: readonly number[], index: number): [number, number, number] {
  const t = SHADES[index % SHADES.length] ?? 0;
  const toward = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  return [0, 1, 2].map((i) => (rgb[i]! + (toward - rgb[i]!) * k) / 255) as [number, number, number];
}

const isBridge = (e: GraphEdge) => e.kind === 'link' && e.source.vault === e.target.vault && e.source.project?.id !== e.target.project?.id;
const isSolid = (e: GraphEdge) => e.kind !== 'affinity';
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

interface Buffers {
  model: GraphModel;
  nodeIndex: Map<GraphNode, number>;
  edgeIndex: Map<GraphEdge, number>;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  shape: Float32Array;
  glow: Float32Array;
  core: Float32Array;
  flash: Float32Array;
  nebulaPos: Float32Array;
  nebulaCol: Float32Array;
  nebulaSize: Float32Array;
  solidPos: Float32Array;
  solidCol: Float32Array;
  dashPos: Float32Array;
  dashCol: Float32Array;
  dashDist: Float32Array;
  placed: boolean;
}

export class GraphScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 100000);
  private readonly nodeMat = material(NODE_VS, NODE_FS, { uPxPerUnit: { value: 1 }, uMinPx: { value: 1.8 }, uMaxPx: { value: 12 }, uRing: { value: 1 } });
  private readonly nebulaMat = material(NEBULA_VS, NEBULA_FS, { uPxPerUnit: { value: 1 }, uMaxPx: { value: 400 } });
  private readonly solidMat = material(LINE_VS, LINE_FS, { uDash: { value: 0 }, uAlpha: { value: 1 } });
  private readonly dashMat = material(LINE_VS, LINE_FS, { uDash: { value: 6 }, uAlpha: { value: 1 } });
  private readonly nodes = new THREE.Points(new THREE.BufferGeometry(), this.nodeMat);
  private readonly nebula = new THREE.Points(new THREE.BufferGeometry(), this.nebulaMat);
  private readonly solid = new THREE.LineSegments(new THREE.BufferGeometry(), this.solidMat);
  private readonly dashed = new THREE.LineSegments(new THREE.BufferGeometry(), this.dashMat);
  private readonly landMat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uHot: { value: -1 } },
    vertexShader: LAND_VS,
    fragmentShader: LAND_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  private readonly land = new THREE.Mesh(new THREE.BufferGeometry(), this.landMat);
  /** Project id → the index its land's vertices carry, for lighting the country under the pointer. */
  private countryIndex = new Map<string, number>();
  private brain: { group: THREE.Group; points: THREE.ShaderMaterial; lines: THREE.ShaderMaterial } | null = null;
  private brainAlpha = 0;
  private buffers: Buffers | null = null;

  /** Throws when the browser gives no WebGL context; the view falls back to 2D. */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0a0a0a, 1);
    // The land is the one layer that blends normally, so it goes down first.
    this.land.renderOrder = -1;
    this.land.visible = false;
    for (const object of [this.land, this.nebula, this.solid, this.dashed, this.nodes]) {
      object.frustumCulled = false;
      this.scene.add(object);
    }
  }

  /** The map's countries as triangles, coloured by vault and shade. Null clears them. */
  setLand(land: MapLand | null, model: GraphModel): void {
    const geometry = new THREE.BufferGeometry();
    this.countryIndex = new Map();
    if (land) {
      let vertices = 0;
      for (const cell of land.cells) if (cell.length >= 6) vertices += (cell.length / 2 - 2) * 3;
      const pos = new Float32Array(vertices * 3);
      const col = new Float32Array(vertices * 3);
      const country = new Float32Array(vertices);
      let v = 0;
      land.cells.forEach((cell, i) => {
        if (cell.length < 6) return;
        const site = land.sites[i]!;
        if (!this.countryIndex.has(site.project)) this.countryIndex.set(site.project, this.countryIndex.size);
        const id = this.countryIndex.get(site.project)!;
        const vault = model.vaults.find((x) => x.id === site.vault);
        const rgb = shade(vault?.color.rgb ?? [160, 160, 170], land.shade.get(site.project) ?? 0);
        // A fan from the first corner: every cell is convex.
        for (let k = 1; k < cell.length / 2 - 1; k++) {
          for (const c of [0, k, k + 1]) {
            pos[v * 3] = cell[c * 2]!;
            pos[v * 3 + 1] = cell[c * 2 + 1]!;
            pos[v * 3 + 2] = 0;
            col.set(rgb, v * 3);
            country[v] = id;
            v++;
          }
        }
      });
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geometry.setAttribute('aCountry', new THREE.BufferAttribute(country, 1));
    }
    this.land.geometry.dispose();
    this.land.geometry = geometry;
  }

  resize(vp: Viewport, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(vp.width, vp.height, false);
    this.camera.aspect = vp.width / vp.height;
    this.camera.updateProjectionMatrix();
  }

  setModel(model: GraphModel): void {
    const n = model.nodes.length;
    const nodeIndex = new Map(model.nodes.map((node, i) => [node, i]));
    const edgeIndex = new Map<GraphEdge, number>();
    let solid = 0;
    let dashed = 0;
    for (const e of model.edges) edgeIndex.set(e, isSolid(e) ? solid++ : dashed++);

    const nodeGeo = new THREE.BufferGeometry();
    const nebulaGeo = new THREE.BufferGeometry();
    const solidGeo = new THREE.BufferGeometry();
    const dashGeo = new THREE.BufferGeometry();
    const buffers: Buffers = {
      model,
      nodeIndex,
      edgeIndex,
      pos: dynamic(nodeGeo, 'position', 3, n),
      col: dynamic(nodeGeo, 'aColor', 3, n),
      size: dynamic(nodeGeo, 'aSize', 1, n),
      shape: dynamic(nodeGeo, 'aShape', 1, n),
      glow: dynamic(nodeGeo, 'aGlow', 1, n),
      core: dynamic(nodeGeo, 'aCore', 1, n),
      flash: dynamic(nodeGeo, 'aFlash', 1, n),
      nebulaPos: dynamic(nebulaGeo, 'position', 3, n),
      nebulaCol: dynamic(nebulaGeo, 'aColor', 3, n),
      nebulaSize: dynamic(nebulaGeo, 'aSize', 1, n),
      solidPos: dynamic(solidGeo, 'position', 3, solid * SEGMENTS * 2),
      solidCol: dynamic(solidGeo, 'aColor', 3, solid * SEGMENTS * 2),
      dashPos: dynamic(dashGeo, 'position', 3, dashed * 2),
      dashCol: dynamic(dashGeo, 'aColor', 3, dashed * 2),
      dashDist: dynamic(dashGeo, 'aDist', 1, dashed * 2),
      placed: false,
    };
    nodeGeo.setDrawRange(0, n);
    nebulaGeo.setDrawRange(0, n);
    solidGeo.setDrawRange(0, solid * SEGMENTS * 2);
    dashGeo.setDrawRange(0, dashed * 2);
    model.nodes.forEach((node, i) => {
      const base = node.kind === 'topic' ? 2 : node.isIndex ? 1 : 0;
      buffers.shape[i] = base + (node.foreign ? 4 : 0);
      const rgb = colorOf(model, node).rgb;
      buffers.col[i * 3] = rgb[0] / 255;
      buffers.col[i * 3 + 1] = rgb[1] / 255;
      buffers.col[i * 3 + 2] = rgb[2] / 255;
    });
    for (const [object, geometry] of [
      [this.nodes, nodeGeo],
      [this.nebula, nebulaGeo],
      [this.solid, solidGeo],
      [this.dashed, dashGeo],
    ] as const) {
      object.geometry.dispose();
      object.geometry = geometry;
    }
    this.buffers = buffers;
  }

  render(frame: SceneFrame): void {
    const b = this.buffers;
    if (!b) return;
    const wantsBrain = frame.is3D;
    if (wantsBrain && !this.brain) this.brain = this.buildBrain();
    const ease = frame.reduceMotion ? 1 : 1 - Math.exp(-frame.dt / 250);
    this.brainAlpha += ((wantsBrain ? 1 : 0) - this.brainAlpha) * ease;

    if (frame.moved || !b.placed) {
      this.uploadPositions(b);
      b.placed = true;
    }
    this.uploadNodeLevels(b, frame);
    if (frame.edgesDirty) this.uploadEdgeColors(b, frame);

    const pxPerUnit = (frame.vp.height * frame.dpr) / 2 / TAN_HALF_FOV;
    const depthRange = frame.is3D || this.brainAlpha > 0.05 ? frame.brainScale * 1.4 : 1e9;
    const minFade = frame.is3D ? 0.2 : 1;
    this.nodeMat.uniforms.uPxPerUnit!.value = pxPerUnit;
    this.nodeMat.uniforms.uMinPx!.value = 1.8 * frame.dpr;
    this.nodeMat.uniforms.uMaxPx!.value = 11 * frame.dpr;
    this.nodeMat.uniforms.uRing!.value = 1 - frame.mapBlend;
    this.nebulaMat.uniforms.uPxPerUnit!.value = pxPerUnit;
    this.nebulaMat.uniforms.uMaxPx!.value = 420 * frame.dpr;
    this.land.visible = frame.landAlpha > 0.005;
    this.landMat.uniforms.uAlpha!.value = frame.landAlpha;
    this.landMat.uniforms.uHot!.value = frame.hotCountry ? (this.countryIndex.get(frame.hotCountry) ?? -1) : -1;
    this.dashMat.uniforms.uDash!.value = 7 / (frame.vp.height / 2 / (TAN_HALF_FOV * frame.cam.dist));
    const materials = [this.nodeMat, this.nebulaMat, this.solidMat, this.dashMat];
    if (this.brain) {
      const { group, points, lines } = this.brain;
      group.visible = this.brainAlpha > 0.01;
      group.scale.setScalar(frame.brainScale);
      lines.uniforms.uAlpha!.value = 0.1 * this.brainAlpha;
      points.uniforms.uAlpha!.value = 0.55 * this.brainAlpha;
      points.uniforms.uSize!.value = 1.6 * frame.dpr;
      materials.push(points, lines);
    }
    for (const m of materials) {
      m.uniforms.uFocusDist!.value = frame.cam.dist;
      m.uniforms.uDepthRange!.value = depthRange;
      m.uniforms.uMinFade!.value = minFade;
    }

    const { position, up } = basis(frame.cam);
    this.camera.position.set(position[0], position[1], position[2]);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.lookAt(frame.cam.tx, frame.cam.ty, frame.cam.tz);
    const near = nearPlane(frame.cam);
    const far = frame.cam.dist * 4 + frame.brainScale * 12 + 4000;
    if (this.camera.near !== near || this.camera.far !== far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const object of [this.nodes, this.nebula, this.solid, this.dashed, this.land]) object.geometry.dispose();
    for (const m of [this.nodeMat, this.nebulaMat, this.solidMat, this.dashMat, this.landMat]) m.dispose();
    if (this.brain) {
      this.brain.group.traverse((o) => {
        if (o instanceof THREE.Points || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      this.brain.points.dispose();
      this.brain.lines.dispose();
    }
    this.renderer.dispose();
  }

  // -- Internals ------------------------------------------------------------------

  private buildBrain() {
    const mesh = makeBrainMesh(6000);
    const group = new THREE.Group();
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.BufferAttribute(mesh.points, 3));
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(mesh.segments, 3));
    const vertices = mesh.segments.length / 3;
    lineGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(vertices * 3).fill(0.82), 3));
    lineGeo.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(vertices), 1));
    const points = material(MESH_POINT_VS, MESH_POINT_FS, {
      uSize: { value: 2 },
      uColor: { value: new THREE.Color(0.86, 0.85, 0.95) },
      uAlpha: { value: 0 },
    });
    const lines = material(LINE_VS, LINE_FS, { uDash: { value: 0 }, uAlpha: { value: 0 } });
    const pointObj = new THREE.Points(pointGeo, points);
    const lineObj = new THREE.LineSegments(lineGeo, lines);
    pointObj.frustumCulled = lineObj.frustumCulled = false;
    group.add(lineObj, pointObj);
    // Draw order does not matter: every layer blends additively.
    this.scene.add(group);
    return { group, points, lines };
  }

  private uploadPositions(b: Buffers): void {
    b.model.nodes.forEach((n, i) => {
      b.pos[i * 3] = b.nebulaPos[i * 3] = finite(n.x);
      b.pos[i * 3 + 1] = b.nebulaPos[i * 3 + 1] = finite(n.y);
      b.pos[i * 3 + 2] = b.nebulaPos[i * 3 + 2] = finite(n.z);
    });
    for (const e of b.model.edges) {
      const o = b.edgeIndex.get(e)!;
      const sx = finite(e.source.x);
      const sy = finite(e.source.y);
      const sz = finite(e.source.z);
      const tx = finite(e.target.x);
      const ty = finite(e.target.y);
      const tz = finite(e.target.z);
      if (isSolid(e)) {
        // A gentle curve, like an axon; the control point bends in the x-y plane.
        const dx = tx - sx;
        const dy = ty - sy;
        const cx = (sx + tx) / 2 - dy * 0.1;
        const cy = (sy + ty) / 2 + dx * 0.1;
        const cz = (sz + tz) / 2;
        let k = o * SEGMENTS * 6;
        let px = sx;
        let py = sy;
        let pz = sz;
        for (let step = 1; step <= SEGMENTS; step++) {
          const u = step / SEGMENTS;
          const a = (1 - u) * (1 - u);
          const m = 2 * (1 - u) * u;
          const c = u * u;
          const qx = a * sx + m * cx + c * tx;
          const qy = a * sy + m * cy + c * ty;
          const qz = a * sz + m * cz + c * tz;
          b.solidPos[k++] = px;
          b.solidPos[k++] = py;
          b.solidPos[k++] = pz;
          b.solidPos[k++] = qx;
          b.solidPos[k++] = qy;
          b.solidPos[k++] = qz;
          px = qx;
          py = qy;
          pz = qz;
        }
      } else {
        b.dashPos.set([sx, sy, sz, tx, ty, tz], o * 6);
        b.dashDist[o * 2] = 0;
        b.dashDist[o * 2 + 1] = Math.hypot(tx - sx, ty - sy, tz - sz);
      }
    }
    this.touch(this.nodes.geometry, 'position');
    this.touch(this.nebula.geometry, 'position');
    this.touch(this.solid.geometry, 'position');
    this.touch(this.dashed.geometry, 'position', 'aDist');
  }

  private uploadNodeLevels(b: Buffers, f: SceneFrame): void {
    const ppu = f.vp.height / 2 / (TAN_HALF_FOV * f.cam.dist);
    const scaleMul = Math.min(1, Math.max(0.45, 1.2 - b.model.nodes.length / 2000));
    const focused = !!(f.hops || f.pathNodes);
    b.model.nodes.forEach((n, i) => {
      b.size[i] = n.drawRadius;
      const ap = f.appear(n);
      if (ap <= 0 || !Number.isFinite(n.x)) {
        b.glow[i] = b.core[i] = b.flash[i] = b.nebulaSize[i] = 0;
        b.nebulaCol.fill(0, i * 3, i * 3 + 3);
        return;
      }
      const act = activity(n.updatedAt, f.wallClock);
      let level = act;
      if (!f.reduceMotion && n.kind === 'note' && isActive(n.updatedAt, f.wallClock)) level *= 0.8 + 0.2 * Math.sin(f.now / 620 + n.phase);
      if (f.hops) {
        const h = f.hops.get(n);
        level *= h === 0 ? 1.6 : h === 1 ? 1.2 : h === 2 ? 0.6 : 0.1;
      }
      if (f.pathNodes) level = f.pathNodes.has(n) ? Math.max(level, 1.4) : level * (f.hops ? 1 : 0.2);
      if (f.matched && !f.matched.has(n)) level *= 0.12;
      const fl = f.flash(n);
      // On the map a note is a city: only the ones edited this week keep their glow.
      const city = 1 - f.mapBlend * (isActive(n.updatedAt, f.wallClock) ? 0 : 0.72);
      b.glow[i] = (0.36 * level * (n.kind === 'topic' ? 0.35 : 1) * city + fl * 0.9) * ap * (1 - 0.45 * f.cloud);
      b.core[i] = Math.min(1, Math.max(0.08, 0.3 + 0.6 * level)) * ap * (1 - 0.3 * f.cloud);
      b.flash[i] = fl;

      // Nebulae: activity hotspots inside the brain, and project clouds when
      // zoomed far out. The map needs neither: its land says both.
      let glow = 0;
      let radius = 0;
      if (n.kind === 'note') {
        if (f.is3D) {
          glow += (0.012 + 0.05 * act * act) * this.brainAlpha;
          radius = 28 + n.radius * 2.6;
        }
        if (f.cloud > 0.01 && !f.is3D) {
          glow += 0.11 * f.cloud * scaleMul;
          radius = Math.max(radius, 26 + n.radius * 2.4, 20 / ppu);
        }
        if (f.matched && !f.matched.has(n)) glow *= 0.2;
        if (focused) glow *= 0.5;
      }
      glow *= ap;
      b.nebulaCol[i * 3] = b.col[i * 3]! * glow;
      b.nebulaCol[i * 3 + 1] = b.col[i * 3 + 1]! * glow;
      b.nebulaCol[i * 3 + 2] = b.col[i * 3 + 2]! * glow;
      b.nebulaSize[i] = radius;
    });
    this.touch(this.nodes.geometry, 'aSize', 'aGlow', 'aCore', 'aFlash');
    this.touch(this.nebula.geometry, 'aColor', 'aSize');
  }

  private uploadEdgeColors(b: Buffers, f: SceneFrame): void {
    const scaleMul = Math.min(1, Math.max(0.5, 1.25 - b.model.nodes.length / 2200));
    const base = (1 - 0.65 * f.cloud) * scaleMul * (f.hops || f.pathNodes ? 0.3 : 1) * f.edgeScale;
    const bridges = f.view === 'network';
    for (const e of b.model.edges) {
      const o = b.edgeIndex.get(e)!;
      const visible = f.appear(e.source) >= 0.6 && f.appear(e.target) >= 0.6 && !f.pathEdges?.has(e);
      const lit = !f.matched || f.matched.has(e.source) || f.matched.has(e.target);
      const bridge = bridges && isBridge(e);
      const k = visible ? EDGE_INTENSITY[e.kind] * base * (lit ? 1 : 0.15) * (bridge ? BRIDGE_BOOST : 1) : 0;
      const si = b.nodeIndex.get(e.source)! * 3;
      const rgb = bridge
        ? BRIDGE_RGB
        : e.kind === 'affinity'
          ? AFFINITY_RGB
          : e.kind === 'topic'
            ? TOPIC_RGB
            : ([b.col[si]!, b.col[si + 1]!, b.col[si + 2]!] as const);
      if (isSolid(e)) {
        let j = o * SEGMENTS * 6;
        for (let v = 0; v < SEGMENTS * 2; v++) {
          b.solidCol[j++] = rgb[0] * k;
          b.solidCol[j++] = rgb[1] * k;
          b.solidCol[j++] = rgb[2] * k;
        }
      } else {
        b.dashCol.set([rgb[0] * k, rgb[1] * k, rgb[2] * k, rgb[0] * k, rgb[1] * k, rgb[2] * k], o * 6);
      }
    }
    this.touch(this.solid.geometry, 'aColor');
    this.touch(this.dashed.geometry, 'aColor');
  }

  private touch(geometry: THREE.BufferGeometry, ...names: string[]): void {
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      if (attribute) attribute.needsUpdate = true;
    }
  }
}
