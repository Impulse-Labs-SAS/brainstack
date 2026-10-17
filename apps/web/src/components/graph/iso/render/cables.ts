// The cables on the line-art map: the selected note's links, run along the streets between
// plates, and, while that layer is on, one cable for each pair of projects that link to each
// other. Every segment of every cable is one instance of a quad the vertex shader turns to face
// the screen at its width in CSS pixels, so all of them are one draw, at any zoom, with no line
// geometry to rebuild when the camera moves.
//
// Each cable is drawn twice from the same instances: solid where it is seen, dashed and fainter
// where a plate or a block stands in front of it. The one decision worth not undoing: both draws
// put every fragment at the same depth and test it against the boxes' the opposite way round
// (less-or-equal, then greater), and neither writes depth. So a stretch of cable is either seen
// or hidden, never both and never neither, and no cable hides another one or a block.
//
// That depth is the plate's, beside the cable as well as on it. The quad is widened on the
// screen, and a pixel below a cable on the screen is nearer ground: at one depth across, the
// lower half of every cable would sink under the plate it runs on, the solid draw would lose it
// and the dashed one would show it.
//
// The colours go to the shaders as sRGB channels and come out as they are, as the boxes' do.

import * as THREE from 'three';

import { lineArtRgb, type LineArtTheme } from '@/lib/graph-theme';

import type { Route, Vec3 } from '../routes';

export const CABLE = { link: 0, route: 1 } as const;

/** A link's width where it is seen, CSS pixels. A project route's grows with what it carries. */
export const LINK_PX = 1.6;
/** What a plate or a block hides of a cable, by CABLE kind: thinner, in CSS pixels… */
export const HIDDEN_PX: readonly number[] = [1.2, 1];
/** …and fainter: how much of its colour it keeps. */
export const HIDDEN_ALPHA: readonly number[] = [0.55, 0.35];
/** Where a cable is seen, by CABLE kind: a link whole, a project route a touch under it. */
export const SEEN_ALPHA: readonly number[] = [1, 0.9];
/** The hidden stretches' rhythm, CSS pixels on and off. */
export const CABLE_DASH_PX = { on: 3, off: 3 } as const;
/** How long the selection's links take to grow in from it, ms. None under reduced motion. */
export const GROW_MS = 420;
/**
 * How far toward the camera a cable is drawn, world units. A drop runs down a plate's side, in
 * the side's own plane: there, face and cable would fight for the same depth and the cable show
 * in patches. Far less than any street is wide, so nothing a cable passes behind lets it through.
 */
export const DEPTH_LIFT = 0.02;

/** A project route's width, CSS pixels: 1 for a single link, 0.6 more for each doubling, to 2.8. */
export function routeWidth(count: number): number {
  return Number.isFinite(count) && count > 1 ? 1 + 0.6 * Math.min(3, Math.log2(count)) : 1;
}

export interface CableSet {
  routes: readonly Route[];
  /** A CABLE kind. */
  kind: number;
  /** Each route's width where it is seen, CSS pixels. Left out: LINK_PX, or routeWidth(1). */
  widths?: readonly number[];
}

const DEFAULT_CAPACITY = 512;
/** Shorter than this, world units, a segment is a repeated point: it has nothing to draw. */
const MIN_SEGMENT = 1e-6;

/** A float as GLSL wants it written: with its point, so it is never read as an int. */
const glsl = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const floats = (values: readonly number[]) =>
  `float[${values.length}](${values.map(glsl).join(', ')})`;

const VERTEX = /* glsl */ `
precision highp float;
precision highp int;

uniform vec3 uAccent;
uniform vec3 uRoute;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uProgress;
uniform float uHidden;

in vec3 iStart;
in vec3 iEnd;
in float iKind;
in float iWidth;
in vec2 iAlong;

out float vAcross;
out float vDash;
out float vAlong;
flat out vec3 vColor;
flat out float vAlpha;
flat out float vWidth;
flat out float vCut;

const float DEPTH_LIFT = ${glsl(DEPTH_LIFT)};
const float HIDDEN_PX[2] = ${floats(HIDDEN_PX)};
const float HIDDEN_ALPHA[2] = ${floats(HIDDEN_ALPHA)};
const float SEEN_ALPHA[2] = ${floats(SEEN_ALPHA)};

// Clip space, drawn DEPTH_LIFT toward the camera, which looks down view space's -z. An
// orthographic view moves nothing on screen for it.
vec4 clipOf(vec3 p) {
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  view.z += DEPTH_LIFT;
  return projectionMatrix * view;
}

// How a plate's top runs in clip-space depth per CSS pixel across the screen. The map's camera is
// orthographic, so a direction projects with no w, and the slope is the same everywhere.
vec2 groundSlope(vec2 toPx) {
  vec4 ex = projectionMatrix * (modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0));
  vec4 ey = projectionMatrix * (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0));
  vec2 sx = ex.xy * toPx;
  vec2 sy = ey.xy * toPx;
  float det = sx.x * sy.y - sx.y * sy.x;
  // Seen edge on, the ground is a line on the screen, with no slope to follow.
  if (abs(det) < 1e-6) return vec2(0.0);
  return vec2(ex.z * sy.y - ey.z * sx.y, ey.z * sx.x - ex.z * sy.x) / det;
}

void main() {
  int kind = clamp(int(iKind + 0.5), 0, 1);
  bool hidden = uHidden > 0.5;
  bool link = kind == ${CABLE.link};
  // A link is cut where it has grown to; a project route is always whole.
  float cut = (link && uProgress < 1.0) ? uProgress * iAlong.y : 1e30;
  vCut = cut;
  vColor = link ? uAccent : uRoute;
  vAlpha = hidden ? HIDDEN_ALPHA[kind] : SEEN_ALPHA[kind];
  vWidth = hidden ? HIDDEN_PX[kind] : iWidth;
  vAcross = 0.0;
  vDash = 0.0;
  vAlong = 0.0;
  if (iAlong.x >= cut) {
    // Not grown this far yet: out of the clip volume, so nothing is rasterised.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 a = clipOf(iStart);
  vec4 b = clipOf(iEnd);
  // CSS pixels from the middle of the stage.
  vec2 toPx = 0.5 * uViewport;
  vec2 pa = a.xy / a.w * toPx;
  vec2 pb = b.xy / b.w * toPx;
  float pxLen = length(pb - pa);
  // A drop seen from straight above is a point: any direction serves it.
  vec2 dir = pxLen > 1e-4 ? (pb - pa) / pxLen : vec2(1.0, 0.0);
  vec2 across = vec2(-dir.y, dir.x);
  float aa = 0.5 / uDpr;
  float reach = 0.5 * vWidth + aa;
  // Square ends where the cable is seen, so its corners close. The dashed pass has none, so its
  // translucent quads do not overlap at a corner and draw it darker.
  float cap = hidden ? 0.0 : 0.5 * vWidth;
  float t = position.x;
  float side = position.y;
  float ends = 2.0 * t - 1.0;
  float along = t * pxLen + ends * cap;
  // CSS pixels from the corner's own end of the segment.
  vec2 offset = across * (side * reach) + dir * (ends * cap);

  vec4 clip = mix(a, b, t);
  clip.xy += offset / toPx * clip.w;
  vec2 ground = groundSlope(toPx);
  if (abs(iEnd.z - iStart.z) < 1e-4) {
    // Level, on a plate's top: every corner stays in that plane, caps included, so a pixel
    // beside the cable is tested against the plate there, as the one on it is.
    clip.z += dot(ground, offset) * clip.w;
  } else {
    // A drop down a plate's side, whose face may turn either way: its caps run on along it, and
    // all of it is drawn as far toward the camera as the ground rises over the width of a cable,
    // so neither the face nor the tops it joins cover half of it. The same in both draws.
    float slope = pxLen > 1.0 ? (b.z - a.z) / pxLen : 0.0;
    float lift = length(ground) * (max(iWidth, HIDDEN_PX[kind]) + aa);
    clip.z += (ends * cap * slope - lift) * clip.w;
  }
  gl_Position = clip;

  vAcross = side * reach;
  vDash = along;
  // Under a pixel long on the screen, a drop seen from above, a cap's share of the segment
  // would be out of all proportion: it is measured across the segment itself instead.
  vAlong = iAlong.x + (pxLen > 1.0 ? along / pxLen : t) * length(iEnd - iStart);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform float uDpr;
uniform float uHidden;

in float vAcross;
in float vDash;
in float vAlong;
flat in vec3 vColor;
flat in float vAlpha;
flat in float vWidth;
flat in float vCut;

layout(location = 0) out highp vec4 fragColor;

const float DASH_ON = ${glsl(CABLE_DASH_PX.on)};
const float DASH_PERIOD = ${glsl(CABLE_DASH_PX.on + CABLE_DASH_PX.off)};

void main() {
  if (vAlong > vCut) discard;
  float aa = 0.5 / uDpr;
  float cover = 1.0 - smoothstep(0.5 * vWidth - aa, 0.5 * vWidth + aa, abs(vAcross));
  if (uHidden > 0.5) {
    // CSS pixels to the middle of the nearest dash. Each segment starts on one, so a corner a
    // plate hides is still marked.
    float c = mod(vDash - 0.5 * DASH_ON + 0.5 * DASH_PERIOD, DASH_PERIOD) - 0.5 * DASH_PERIOD;
    cover *= 1.0 - smoothstep(0.5 * DASH_ON - aa, 0.5 * DASH_ON + aa, abs(c));
  }
  if (cover <= 0.0) discard;
  fragColor = vec4(vColor, vAlpha * cover);
}
`;

interface Instances {
  start: THREE.InstancedBufferAttribute;
  end: THREE.InstancedBufferAttribute;
  kind: THREE.InstancedBufferAttribute;
  width: THREE.InstancedBufferAttribute;
  /** Where along its cable the segment starts, and the cable's length: world units. */
  along: THREE.InstancedBufferAttribute;
}

function instanced(capacity: number, size: number): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
  // Written again at every new selection.
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * The quad every segment is drawn as, x along it (0 at its start, 1 at its end) and y across
 * (−1 to 1), and room for `capacity` segments.
 */
function cableGeometry(capacity: number): {
  geometry: THREE.InstancedBufferGeometry;
  inst: Instances;
} {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  const quad = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]);
  geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  const inst: Instances = {
    start: instanced(capacity, 3),
    end: instanced(capacity, 3),
    kind: instanced(capacity, 1),
    width: instanced(capacity, 1),
    along: instanced(capacity, 2),
  };
  geometry.setAttribute('iStart', inst.start);
  geometry.setAttribute('iEnd', inst.end);
  geometry.setAttribute('iKind', inst.kind);
  geometry.setAttribute('iWidth', inst.width);
  geometry.setAttribute('iAlong', inst.along);
  geometry.instanceCount = 0;
  return { geometry, inst };
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

type CableMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

export class CableLayer {
  /** Where the cables are seen: solid. */
  readonly visible: CableMesh;
  /** Only where a plate or a block stands in front of them: dashed and faint. */
  readonly hidden: CableMesh;
  /** Shared by both draws: setting one sets it for the two. */
  private readonly uniforms = {
    uAccent: { value: new THREE.Vector3() },
    uRoute: { value: new THREE.Vector3() },
    uViewport: { value: new THREE.Vector2(800, 600) },
    uDpr: { value: 1 },
    uProgress: { value: 1 },
  };
  private inst: Instances;
  private capacity: number;
  private n = 0;
  private hiddenOn = true;

  /** `capacity`: the segments it holds before it grows. */
  constructor(theme: LineArtTheme, capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.ceil(capacity));
    const { geometry, inst } = cableGeometry(this.capacity);
    this.inst = inst;
    this.visible = this.pass(geometry, false);
    this.hidden = this.pass(geometry, true);
    this.setTheme(theme);
  }

  /** The segments drawn: every pair of neighbouring points, less the repeated ones. */
  get count(): number {
    return this.n;
  }

  /** Everything at once: the selection's links and, when on, the project routes. */
  set(sets: readonly CableSet[]): void {
    for (const s of sets) {
      if (s.kind !== CABLE.link && s.kind !== CABLE.route) {
        throw new RangeError(`cable kind ${s.kind} is neither a link nor a route`);
      }
      if (s.widths && s.widths.length !== s.routes.length) {
        throw new RangeError(
          `set: ${s.routes.length} routes want as many widths, got ${s.widths.length}`,
        );
      }
    }
    // Project routes first and links last: one draw paints its instances in order, and neither
    // pass writes depth, so a link that crosses a project route stays on top of it.
    const ordered = [...sets].sort(
      (p, q) => Number(p.kind === CABLE.link) - Number(q.kind === CABLE.link),
    );
    let wanted = 0;
    for (const s of ordered) for (const r of s.routes) wanted += Math.max(0, r.points.length - 1);
    if (wanted > this.capacity) this.grow(Math.max(wanted, this.capacity * 2));

    const start = this.inst.start.array as Float32Array;
    const end = this.inst.end.array as Float32Array;
    const kind = this.inst.kind.array as Float32Array;
    const width = this.inst.width.array as Float32Array;
    const along = this.inst.along.array as Float32Array;
    let n = 0;
    for (const s of ordered) {
      const fallback = s.kind === CABLE.link ? LINK_PX : routeWidth(1);
      s.routes.forEach((route, r) => {
        const given = s.widths?.[r];
        const w = given !== undefined && Number.isFinite(given) && given > 0 ? given : fallback;
        const pts = route.points;
        // Measured here, over the very points drawn, so a link grows in to exactly its end.
        let total = 0;
        for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1]!, pts[i]!);
        let at = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          const l = distance(a, b);
          if (l > MIN_SEGMENT) {
            start.set(a, n * 3);
            end.set(b, n * 3);
            kind[n] = s.kind;
            width[n] = w;
            along[n * 2] = at;
            along[n * 2 + 1] = total;
            n++;
          }
          at += l;
        }
      });
    }
    if (n > 0) {
      for (const attribute of Object.values(this.inst)) {
        // The whole of what is drawn, which covers anything queued before it.
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, n * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    this.n = n;
    this.visible.geometry.instanceCount = n;
    this.visible.visible = n > 0;
    this.hidden.visible = n > 0 && this.hiddenOn;
  }

  /** How far the links have grown in, 0..1: each cable is drawn up to that share of its length. */
  setProgress(t: number): void {
    this.uniforms.uProgress.value = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  }

  /**
   * The pixel ratio and the stage's size in CSS pixels, which widths and dashes are measured in.
   * The zoom changes nothing, as a cable is as wide at any: it is taken so that every layer is
   * scaled by the same call.
   */
  setScale(_ppu: number, dpr: number, viewport: { width: number; height: number }): void {
    this.uniforms.uDpr.value = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const size = (v: number) => (Number.isFinite(v) && v > 1 ? v : 1);
    this.uniforms.uViewport.value.set(size(viewport.width), size(viewport.height));
  }

  /** The quality governor turns the dashed stretches off, and on again. */
  setHiddenVisible(on: boolean): void {
    this.hiddenOn = on;
    this.hidden.visible = on && this.n > 0;
  }

  setTheme(theme: LineArtTheme): void {
    this.uniforms.uAccent.value.fromArray(lineArtRgb(theme.accent));
    this.uniforms.uRoute.value.fromArray(lineArtRgb(theme.route));
  }

  dispose(): void {
    // One geometry, both passes'.
    this.visible.geometry.dispose();
    this.visible.material.dispose();
    this.hidden.material.dispose();
  }

  /**
   * One of the two draws. After the boxes and the lift marks, which are opaque and drawn first,
   * so the depth they leave is there to test; the hidden one first, so the solid one's edges
   * lie over the dashes' where the two meet.
   */
  private pass(geometry: THREE.InstancedBufferGeometry, hidden: boolean): CableMesh {
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...this.uniforms, uHidden: { value: hidden ? 1 : 0 } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      // A quad turned in screen space: whichever way it winds, it is meant to be seen.
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Its instances lie wherever the routes run, nowhere near the quad three would cull by.
    mesh.frustumCulled = false;
    mesh.renderOrder = hidden ? 2 : 3;
    mesh.visible = false;
    return mesh;
  }

  /** New buffers, in a new geometry for both draws: disposing the old one frees its GPU buffers. */
  private grow(capacity: number): void {
    const { geometry, inst } = cableGeometry(capacity);
    this.visible.geometry.dispose();
    this.visible.geometry = geometry;
    this.hidden.geometry = geometry;
    this.inst = inst;
    this.capacity = capacity;
  }
}
