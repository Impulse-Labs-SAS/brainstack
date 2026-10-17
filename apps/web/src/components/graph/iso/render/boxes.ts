// Every plate and every note of the line-art map, drawn as one instanced mesh: a box per
// instance, its faces flat and its edges drawn by the fragment shader at a constant width in
// CSS pixels, at any zoom. Five thousand notes and their plates are one draw call, and there is
// no line geometry to rebuild when the camera moves.
//
// The one decision worth not undoing: an edge between two faces the camera sees is drawn half
// by each, and an edge on the outline whole by the one face it has. Drawn whole by every face,
// each edge inside a box's outline would show twice as wide as the outline itself, and the
// look is thin edges of one width.
//
// The colours go to the shaders as sRGB channels and come out as they are, with no colour
// management: a block is exactly the hex its token names.

import * as THREE from 'three';

import { lineArtRgb, type LineArtTheme } from '@/lib/graph-theme';

export const KIND = { vault: 0, project: 1, folder: 2, sub: 3, note: 4 } as const;
/** How a box is lit; `hidden` draws nothing at all (a note the growth replay has not reached). */
export const STATE = {
  rest: 0,
  dim: 1,
  hover: 2,
  linked: 3,
  found: 4,
  selected: 5,
  hidden: 6,
} as const;
/** Bit flags: a dashed rim (the shared vault's plate), an inner square (a project's index note). */
export const FLAG = { dashed: 1, index: 2 } as const;

/** An edge's width in CSS pixels, by state: what is active reads a little heavier. */
export const EDGE_PX: readonly number[] = [1, 1, 1.25, 1.25, 1.25, 1.75];
/** How far in from a block's sides the index note's inner square is drawn, in world units. */
export const INDEX_INSET = 0.17;
/** Below this many pixels per unit the inner square would only blur a block's top. */
export const INDEX_MIN_PPU = 6;
/**
 * Below this many pixels per unit a block's edges run together into a grey blur: a block at
 * rest is drawn as a flat tile then, and only what is active keeps its edges.
 */
export const TILE_PPU = 4.5;
/** The shared vault's rim, in CSS pixels: dashes this long, then gaps this long. */
export const DASH_PX = { on: 5, off: 4 } as const;

const DEFAULT_CAPACITY = 1024;

type Vec3 = readonly [number, number, number];

/**
 * The unit box's faces but its bottom, which no camera above the ground sees. Corners run
 * counter-clockwise seen from outside, as FrontSide wants.
 */
const FACES: readonly { normal: Vec3; corners: readonly Vec3[] }[] = [
  {
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [1, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 1, 0],
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
    ],
  },
];

/**
 * The unit box (0..1)³ as buffers: four vertices a face, each with the face's normal and a uv
 * across it, and two triangles a face. A face's uv is the world axes along it — x and y on the
 * top, x or y and then z on a side — not its own left to right, so the two faces either side
 * of an edge measure along it alike and a dashed rim's halves meet dash for dash.
 */
export function unitBox(): {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array;
} {
  const position = new Float32Array(FACES.length * 12);
  const normal = new Float32Array(FACES.length * 12);
  const uv = new Float32Array(FACES.length * 8);
  const index = new Uint16Array(FACES.length * 6);
  FACES.forEach((face, f) => {
    face.corners.forEach((p, k) => {
      const v = f * 4 + k;
      position.set(p, v * 3);
      normal.set(face.normal, v * 3);
      const top = face.normal[2] === 1;
      uv.set(top ? [p[0], p[1]] : face.normal[1] !== 0 ? [p[0], p[2]] : [p[1], p[2]], v * 2);
    });
    const v = f * 4;
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], f * 6);
  });
  return { position, normal, uv, index };
}

/** A float as GLSL wants it written: with its point, so it is never read as an int. */
const glsl = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const VERTEX = /* glsl */ `
precision highp float;
precision highp int;

uniform vec3 uTop[5];
uniform vec3 uSide[5];
uniform vec3 uEdge[5];
uniform vec3 uBlockLeft;
uniform vec3 uBlockRight;
uniform vec3 uHoverTop;
uniform vec3 uSelTop;
uniform vec3 uDim;
uniform vec3 uHoverEdge;
uniform vec3 uAccent;
uniform vec3 uRoute;
uniform vec3 uTile;
uniform vec2 uRight;
uniform float uPpu;

in vec3 iMin;
in vec3 iMax;
in float iKind;
in float iState;
in float iFlags;
in float iLift;

out vec2 vUv;
flat out vec2 vSize;
flat out vec4 vShared;
flat out vec3 vFill;
flat out vec3 vEdge;
flat out float vWidth;
flat out float vDashed;
flat out float vIndex;

const float EDGE_PX[6] = float[6](${EDGE_PX.map(glsl).join(', ')});

void main() {
  int kind = clamp(int(iKind + 0.5), 0, 4);
  int state = clamp(int(iState + 0.5), 0, ${STATE.hidden});
  if (state == ${STATE.hidden}) {
    // Past the far plane: clipped whole, so not a fragment of it is drawn.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  int flags = int(iFlags + 0.5);
  bool note = kind == ${KIND.note};
  bool top = normal.z > 0.5;
  bool dashed = (flags & ${FLAG.dashed}) != 0;

  vec3 world = mix(iMin, iMax, position) + vec3(0.0, 0.0, iLift);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);

  // The face's two axes in the world, as unitBox lays its uv out.
  vec3 axisU = (top || abs(normal.y) > 0.5) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 axisV = top ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 size = iMax - iMin;
  vUv = uv;
  vSize = vec2(dot(size, axisU), dot(size, axisV));

  // The face across each border (u = 0, u = 1, v = 0, v = 1) has the normal of that axis, or
  // its opposite; it shares the edge when it faces the camera. An orthographic view looks one
  // way only, and the view matrix's third row points back along it.
  vec3 toCamera = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float facingU = dot(axisU, toCamera);
  float facingV = dot(axisV, toCamera);
  vShared = step(vec4(0.001), vec4(-facingU, facingU, -facingV, facingV));

  if (top) {
    vFill = (note && state == ${STATE.selected}) ? uSelTop
      : ((note && state == ${STATE.hover}) ? uHoverTop : uTop[kind]);
  } else if (note) {
    vFill = dot(normal.xy, uRight) < 0.0 ? uBlockLeft : uBlockRight;
  } else {
    vFill = uSide[kind];
  }
  vec3 restEdge = dashed ? uRoute : uEdge[kind];
  vEdge = state == ${STATE.rest} ? restEdge
    : (state == ${STATE.dim} ? uDim : (state == ${STATE.hover} ? uHoverEdge : uAccent));
  vWidth = EDGE_PX[state];
  if (note && uPpu < ${glsl(TILE_PPU)} && (state == ${STATE.rest} || state == ${STATE.dim})) {
    // Seen from far off: a tile, sunk into its plate when another note is selected.
    if (top) vFill = state == ${STATE.dim} ? uBlockLeft : uTile;
    vWidth = 0.0;
  }
  vDashed = dashed ? 1.0 : 0.0;
  vIndex = (note && top && (flags & ${FLAG.index}) != 0 && uPpu >= ${glsl(INDEX_MIN_PPU)}) ? 1.0 : 0.0;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;

uniform float uDpr;

in vec2 vUv;
flat in vec2 vSize;
flat in vec4 vShared;
flat in vec3 vFill;
flat in vec3 vEdge;
flat in float vWidth;
flat in float vDashed;
flat in float vIndex;

layout(location = 0) out highp vec4 fragColor;

const float DASH_ON = ${glsl(DASH_PX.on)};
const float DASH_PERIOD = ${glsl(DASH_PX.on + DASH_PX.off)};
const float INDEX_INSET = ${glsl(INDEX_INSET)};

void main() {
  // How uv moves per device pixel. A face seen orthographically lands on the screen affinely,
  // so these are exact, and the same all across it.
  vec2 du = vec2(dFdx(vUv.x), dFdy(vUv.x));
  vec2 dv = vec2(dFdx(vUv.y), dFdy(vUv.y));
  float gu = max(length(du), 1e-6);
  float gv = max(length(dv), 1e-6);
  float det = max(abs(du.x * dv.y - du.y * dv.x), 1e-12);
  float aa = 0.5 / uDpr;

  // CSS pixels to each border (u = 0, u = 1, v = 0, v = 1), less the width drawn there: all of
  // it on the outline, half where the face across draws the other half.
  vec4 dist = vec4(vUv.x, 1.0 - vUv.x, vUv.y, 1.0 - vUv.y) / (vec4(gu, gu, gv, gv) * uDpr);
  vec4 past = dist - vWidth * (1.0 - 0.5 * vShared);
  float acrossU = min(past.x, past.y);
  float acrossV = min(past.z, past.w);
  float edge = vWidth > 0.0 ? 1.0 - smoothstep(-aa, aa, min(acrossU, acrossV)) : 0.0;

  if (vDashed > 0.5) {
    // CSS pixels along the nearest border from its start: a unit of u, v held, spans
    // |grad v| / |det| device pixels. Each dash is centred on a whole period, corners included.
    float along = (acrossV < acrossU ? vUv.x * gv : vUv.y * gu) / (det * uDpr);
    float c = mod(along + 0.5 * DASH_PERIOD, DASH_PERIOD) - 0.5 * DASH_PERIOD;
    edge *= 1.0 - smoothstep(0.5 * DASH_ON - aa, 0.5 * DASH_ON + aa, abs(c));
  }

  if (vIndex > 0.5) {
    // The inner square's outline, as a box's signed distance, each axis in CSS pixels.
    vec2 inset = INDEX_INSET / max(vSize, vec2(0.0001));
    vec2 q = (abs(vUv - 0.5) - (0.5 - inset)) / (vec2(gu, gv) * uDpr);
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    edge = max(edge, 1.0 - smoothstep(-aa, aa, abs(sd) - 0.5 * vWidth));
  }

  fragColor = vec4(mix(vFill, vEdge, edge), 1.0);
}
`;

interface Instances {
  min: THREE.InstancedBufferAttribute;
  max: THREE.InstancedBufferAttribute;
  kind: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  flags: THREE.InstancedBufferAttribute;
  lift: THREE.InstancedBufferAttribute;
}

function instanced(capacity: number, size: number, dynamic: boolean) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
  if (dynamic) attribute.setUsage(THREE.DynamicDrawUsage);
  // three spends the ranges after a partial upload, but not after the first, whole one: left,
  // they would be uploaded again with the next change.
  attribute.onUpload(() => attribute.clearUpdateRanges());
  return attribute;
}

function boxGeometry(capacity: number): {
  geometry: THREE.InstancedBufferGeometry;
  inst: Instances;
} {
  const box = unitBox();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(box.index, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(box.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(box.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(box.uv, 2));
  const inst: Instances = {
    min: instanced(capacity, 3, false),
    max: instanced(capacity, 3, false),
    kind: instanced(capacity, 1, false),
    state: instanced(capacity, 1, true),
    flags: instanced(capacity, 1, false),
    lift: instanced(capacity, 1, true),
  };
  geometry.setAttribute('iMin', inst.min);
  geometry.setAttribute('iMax', inst.max);
  geometry.setAttribute('iKind', inst.kind);
  geometry.setAttribute('iState', inst.state);
  geometry.setAttribute('iFlags', inst.flags);
  geometry.setAttribute('iLift', inst.lift);
  geometry.instanceCount = 0;
  return { geometry, inst };
}

/** Sorted, distinct indices as runs of neighbours: what one upload each can cover. */
export function runs(indices: Iterable<number>): { start: number; count: number }[] {
  const sorted = [...indices].sort((a, b) => a - b);
  const out: { start: number; count: number }[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i <= last.start + last.count) {
      last.count = Math.max(last.count, i - last.start + 1);
    } else {
      out.push({ start: i, count: 1 });
    }
  }
  return out;
}

/** Queue the slots in `dirty` for upload, a range per run of neighbours. True when there were any. */
function queue(attribute: THREE.InstancedBufferAttribute, dirty: Set<number>): boolean {
  if (dirty.size === 0) return false;
  for (const r of runs(dirty)) attribute.addUpdateRange(r.start, r.count);
  attribute.needsUpdate = true;
  dirty.clear();
  return true;
}

const v3 = () => new THREE.Vector3();

export class BoxLayer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly uniforms = {
    uTop: { value: [v3(), v3(), v3(), v3(), v3()] },
    uSide: { value: [v3(), v3(), v3(), v3(), v3()] },
    uEdge: { value: [v3(), v3(), v3(), v3(), v3()] },
    uBlockLeft: { value: v3() },
    uBlockRight: { value: v3() },
    uHoverTop: { value: v3() },
    uSelTop: { value: v3() },
    uDim: { value: v3() },
    uHoverEdge: { value: v3() },
    uAccent: { value: v3() },
    uRoute: { value: v3() },
    uTile: { value: v3() },
    uRight: { value: new THREE.Vector2(Math.SQRT1_2, Math.SQRT1_2) },
    uPpu: { value: 10 },
    uDpr: { value: 1 },
  };
  private inst: Instances;
  private capacity: number;
  private n = 0;
  /** setBoxes ran since the last flush: its upload is already queued, but the frame must still be drawn. */
  private pending = false;
  private readonly dirtyState = new Set<number>();
  private readonly dirtyLift = new Set<number>();

  constructor(theme: LineArtTheme, capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.ceil(capacity));
    const { geometry, inst } = boxGeometry(this.capacity);
    this.inst = inst;
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // Its instances stand wherever the layout puts them, nowhere near the unit box three would
    // cull by.
    this.mesh.frustumCulled = false;
    this.setTheme(theme);
  }

  /**
   * Every box at once: 6 floats each (x0, y0, z0, x1, y1, z1), a kind and flags per box. States
   * and lifts reset to rest and 0. Queued for upload at once, and reported by the next flush.
   */
  setBoxes(bounds: Float32Array, kinds: Uint8Array, flags: Uint8Array): void {
    const n = kinds.length;
    if (bounds.length !== n * 6 || flags.length !== n) {
      throw new RangeError(
        `setBoxes: ${n} kinds want ${n * 6} bounds and ${n} flags, got ${bounds.length} and ${flags.length}`,
      );
    }
    if (n > this.capacity) this.grow(Math.max(n, this.capacity * 2));
    const { min, max, kind, state, flags: flag, lift } = this.inst;
    const lo = min.array as Float32Array;
    const hi = max.array as Float32Array;
    for (let i = 0; i < n; i++) {
      lo[i * 3] = bounds[i * 6]!;
      lo[i * 3 + 1] = bounds[i * 6 + 1]!;
      lo[i * 3 + 2] = bounds[i * 6 + 2]!;
      hi[i * 3] = bounds[i * 6 + 3]!;
      hi[i * 3 + 1] = bounds[i * 6 + 4]!;
      hi[i * 3 + 2] = bounds[i * 6 + 5]!;
    }
    (kind.array as Float32Array).set(kinds);
    (flag.array as Float32Array).set(flags);
    (state.array as Float32Array).fill(0, 0, n);
    (lift.array as Float32Array).fill(0, 0, n);
    for (const attribute of [min, max, kind, state, flag, lift]) {
      // The whole of what is drawn, which covers anything queued before it.
      attribute.clearUpdateRanges();
      if (n > 0) attribute.addUpdateRange(0, n * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.dirtyState.clear();
    this.dirtyLift.clear();
    this.n = n;
    this.mesh.geometry.instanceCount = n;
    this.pending = true;
  }

  get count(): number {
    return this.n;
  }

  /** No upload until flush; the same state again costs nothing. */
  setState(i: number, state: number): void {
    this.write(this.inst.state, this.dirtyState, i, state);
  }

  /** World units up; notes only, in practice. No upload until flush. */
  setLift(i: number, lift: number): void {
    this.write(this.inst.lift, this.dirtyLift, i, lift);
  }

  /** Upload what changed since the last flush: only the ranges touched. True when anything was uploaded. */
  flush(): boolean {
    let any = this.pending;
    this.pending = false;
    any = queue(this.inst.state, this.dirtyState) || any;
    any = queue(this.inst.lift, this.dirtyLift) || any;
    return any;
  }

  /** Pixels per world unit and the pixel ratio: edge widths and dashes are in CSS pixels. */
  setScale(ppu: number, dpr: number): void {
    this.uniforms.uPpu.value = ppu;
    this.uniforms.uDpr.value = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  /** Which way is screen-right on the ground, for shading the two visible sides differently. */
  setView(right: readonly [number, number]): void {
    this.uniforms.uRight.value.set(right[0], right[1]);
  }

  setTheme(theme: LineArtTheme): void {
    const u = this.uniforms;
    const put = (target: THREE.Vector3, css: string) => target.fromArray(lineArtRgb(css));
    // By KIND: vault, project, folder, sub-folder, note. A note's sides are shaded left and right.
    const tops = [theme.vaultTop, theme.projectTop, theme.folderTop, theme.subTop, theme.blockTop];
    const sides = [
      theme.vaultSide,
      theme.projectSide,
      theme.folderSide,
      theme.folderSide,
      theme.blockLeft,
    ];
    const edges = [
      theme.vaultEdge,
      theme.projectEdge,
      theme.folderEdge,
      theme.folderEdge,
      theme.blockEdge,
    ];
    tops.forEach((css, k) => put(u.uTop.value[k]!, css));
    sides.forEach((css, k) => put(u.uSide.value[k]!, css));
    edges.forEach((css, k) => put(u.uEdge.value[k]!, css));
    put(u.uBlockLeft.value, theme.blockLeft);
    put(u.uBlockRight.value, theme.blockRight);
    put(u.uHoverTop.value, theme.hoverTop);
    put(u.uSelTop.value, theme.selTop);
    put(u.uDim.value, theme.blockDim);
    put(u.uHoverEdge.value, theme.hoverEdge);
    put(u.uAccent.value, theme.accent);
    put(u.uRoute.value, theme.route);
    put(u.uTile.value, theme.blockTile);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private write(
    attribute: THREE.InstancedBufferAttribute,
    dirty: Set<number>,
    i: number,
    value: number,
  ): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.n) {
      throw new RangeError(`box ${i} is not one of the ${this.n} set`);
    }
    const array = attribute.array as Float32Array;
    if (array[i] === Math.fround(value)) return;
    array[i] = value;
    dirty.add(i);
  }

  /** New buffers, in a new geometry: disposing the old one frees its GPU buffers with it. */
  private grow(capacity: number): void {
    const { geometry, inst } = boxGeometry(capacity);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.inst = inst;
    this.capacity = capacity;
  }
}
