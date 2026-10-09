// The frame round the prompt, drawn in the stage: a thin bar of dark glass
// round the DOM box the question is typed into, which the Sentinel clings to.
// The box is a DOM element above the canvas; this is its rim in the world,
// placed where prompt/perch-geometry.ts unprojects the box (`BezelShape`), so
// the claws close on something that is there in 3D — the rails the grip
// planner holds are this bar's centreline.
//
// It is lit as the dormant glass is, so the frame belongs to the world the
// creature walks into: dark glass under a soft key that rides with the camera,
// a cold rim where the bar turns away from the viewer, a faint sheen on its
// bevels, and the creature's own eye glinting on it — its cone, falling off
// with distance, and a little spill right round the lens, as the dormant
// network's eye pool has it.
//
// It writes depth, and it is drawn after the Sentinel with the depth test on,
// in the same planes: so a claw curled round the front of the bar shows in
// front of it, the body behind it is hidden by it, and while the frame fades
// it blends over the creature behind it instead of cutting it out — drawn
// before the creature, a fading bar would still hide whatever lay behind it.
// It never clears. Every renderer change goes through `withRendererState`.
//
// One mesh, one program. The geometry is rebuilt only when the frame's size
// changes (the box narrowed with the window): the bezel moving or turning
// with the camera is only its matrix.

import * as THREE from 'three';

import { FOV_DEG, basis, type Camera, type Viewport } from '@/lib/graph-camera';

import type { BezelShape } from '../prompt/perch-geometry';
import { withRendererState } from '../sentinel/gl-state';
import { SENTINEL_LINEAR, linear } from '../sentinel/palette';
import type { SpaceFrame } from '../space/space';
import type { Vec3 } from '../vec';

/** The Sentinel's eye in world space, as a space is told of it. */
type Eye = NonNullable<SpaceFrame['eye']>;

/** How the bar looks: read every frame, so the lab tunes it live. */
export interface BezelLook {
  /** The glass, and the rim where it turns away from the viewer. */
  colour: string;
  rimColour: string;
  rim: number;
  /** The key light's highlight on its bevels. */
  sheen: number;
  /** The eye's light on it, and how far it carries, creature units. */
  glint: number;
  eyeReach: number;
}

/**
 * The dormant glass and its rim (dormant-network.ts), so the frame reads as
 * part of the same world; the rim a good deal brighter than a crystal's, which
 * is lit by the eye most of the time, where the bar is only lit at the prompt.
 * Guesses until the gate.
 */
export function defaultBezelLook(): BezelLook {
  return {
    colour: '#14181c',
    rimColour: '#8fa3b0',
    rim: 0.35,
    sheen: 0.2,
    glint: 1.2,
    eyeReach: 3,
  };
}

/** The eye's cone, as the Sentinel's spotlight has it (view.ts): angle and penumbra. */
const EYE_ANGLE = 0.55;
const EYE_PENUMBRA = 0.7;
/** The eye's intensity at rest: a glint of 1 lights fully there. */
const EYE_REST = 0.55;
/** The light that spills right round the lens, creature units. */
const EYE_SPILL = 1.2;
/** Its own planes, creature units either side of the frame: the creature perched behind it, its claws in front. */
const NEAR_ROOM = 4;
const FAR_ROOM = 6;
/** Room round a sphere the planes are widened to hold, as the Sentinel fits its own planes round itself. */
const SPHERE_ROOM = 1.05;

const BEZEL_VS = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vView;
  varying vec3 vNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    vWorld = world.xyz;
    vView = mv.xyz;
    vNormal = normalize(normalMatrix * normal);
  }
`;

const BEZEL_FS = /* glsl */ `
  uniform vec3 uGlass;
  uniform vec3 uRimColour;
  uniform float uRim;
  uniform float uSheen;
  uniform vec3 uAccent;
  uniform float uLevel;
  uniform vec3 uEyePos;
  uniform vec3 uEyeDir;
  // The lens in view space, for the highlight's half vector.
  uniform vec3 uEyeView;
  // cos of the cone's edge, cos of its full-strength core, reach (world units), gain.
  uniform vec4 uEyeCone;
  uniform float uEyeSpill;
  varying vec3 vWorld;
  varying vec3 vView;
  varying vec3 vNormal;
  // A key light that rides with the camera, view space: from above and to the left, as the dormant glass's.
  const vec3 KEY = vec3(-0.3913, 0.6148, 0.6848);

  // Interleaved gradient noise, ±half a step of the 8-bit canvas: dark glass bands without it.
  float dither() {
    return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(-vView);
    float ndv = abs(dot(n, v));
    vec3 c = uGlass * (0.35 + 0.65 * max(dot(n, KEY), 0.0));
    c += uRimColour * uRim * pow(1.0 - ndv, 3.0);
    c += uRimColour * uSheen * pow(max(dot(n, normalize(KEY + v)), 0.0), 24.0);

    // The eye: its cone falling off with distance, and the spill round the lens.
    vec3 toEye = uEyePos - vWorld;
    float d = length(toEye);
    vec3 l = toEye / max(d, 1e-5);
    float cone = smoothstep(uEyeCone.x, uEyeCone.y, dot(-l, uEyeDir));
    float x = d / max(uEyeCone.z, 1e-5);
    float fall = (1.0 - smoothstep(0.6, 1.0, x)) / (1.0 + 8.0 * x * x);
    float s = clamp(1.0 - d / max(uEyeSpill, 1e-5), 0.0, 1.0);
    float lit = min((cone * fall + 0.5 * s * s) * uEyeCone.w, 1.5);
    vec3 lv = normalize(uEyeView - vView);
    float facing = 0.35 + 0.65 * max(dot(n, lv), 0.0);
    float spec = pow(max(dot(n, normalize(lv + v)), 0.0), 40.0);
    c += uAccent * lit * (0.06 * facing + spec);

    gl_FragColor = linearToOutputTexel(vec4(max(c, 0.0), uLevel));
    gl_FragColor.rgb += dither() / 255.0;
  }
`;

/** The parts of a shape that make its geometry: anything else only moves it. */
type Size = Pick<BezelShape, 'width' | 'height' | 'radius' | 'band' | 'thickness'>;

const sameSize = (a: Size | null, b: Size): boolean => {
  if (!a) return false;
  const tol = 1e-9 * Math.max(b.width, b.height, 1e-9);
  return (
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol &&
    Math.abs(a.radius - b.radius) <= tol &&
    Math.abs(a.band - b.band) <= tol &&
    Math.abs(a.thickness - b.thickness) <= tol
  );
};

/** A rounded rectangle about the origin, half extents `hw` × `hh`, corners of radius `r`. */
function roundedRect<T extends THREE.Path>(path: T, hw: number, hh: number, r: number): T {
  const c = Math.max(0, Math.min(r, hw, hh));
  path.moveTo(-hw + c, -hh);
  path.lineTo(hw - c, -hh);
  if (c > 0) path.absarc(hw - c, -hh + c, c, -Math.PI / 2, 0, false);
  path.lineTo(hw, hh - c);
  if (c > 0) path.absarc(hw - c, hh - c, c, 0, Math.PI / 2, false);
  path.lineTo(-hw + c, hh);
  if (c > 0) path.absarc(-hw + c, hh - c, c, Math.PI / 2, Math.PI, false);
  path.lineTo(-hw, -hh + c);
  if (c > 0) path.absarc(-hw + c, -hh + c, c, Math.PI, (3 * Math.PI) / 2, false);
  return path;
}

/**
 * The bar as geometry about its own middle: a rounded-rectangle ring whose
 * centreline is the rails' rectangle, `band` across and `thickness` deep,
 * with a small bevel. Three's bevel grows the outline by its size and the
 * depth by its thickness either side, so both are taken off first: the whole
 * bar spans the rails' rectangle grown by half the band, and the thickness
 * centred on the box's plane.
 */
export function bezelGeometry(s: Size): THREE.ExtrudeGeometry {
  const bevel = Math.min(s.band, s.thickness) / 4;
  const hw = s.width / 2;
  const hh = s.height / 2;
  const half = s.band / 2;
  const outer = roundedRect(
    new THREE.Shape(),
    hw + half - bevel,
    hh + half - bevel,
    s.radius + half - bevel,
  );
  const innerW = Math.max(0, hw - half + bevel);
  const innerH = Math.max(0, hh - half + bevel);
  if (innerW > 0 && innerH > 0) {
    outer.holes.push(
      roundedRect(new THREE.Path(), innerW, innerH, Math.max(0, s.radius - half) + bevel),
    );
  }
  const g = new THREE.ExtrudeGeometry(outer, {
    depth: Math.max(0, s.thickness - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.translate(0, 0, -(s.thickness / 2 - bevel));
  return g;
}

/** What the bezel is drawn against, a frame at a time. */
export interface BezelFrame {
  cam: Camera;
  vp: Viewport;
  /** How much of it shows, 0–1: the prompt's level. 0 draws nothing. */
  level: number;
  /** World units per creature unit. */
  unit: number;
  /**
   * The planes the frame's depth was written with, world units: the space's,
   * when it drew first, or `planes` when the Sentinel drew in the bezel's.
   * Null picks its own.
   */
  depth: { near: number; far: number } | null;
  /** The Sentinel's eye, world space, as the space is told it; null lights nothing. */
  eye: Eye | null;
}

export class PromptBezel {
  /** Read every frame: change it freely, nothing compiles. */
  readonly look: BezelLook;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 10);
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  /** Stands in until the first shape: a mesh needs a geometry to be compiled with. */
  private readonly placeholder: THREE.BufferGeometry;
  private size: Size | null = null;
  private shaped: BezelShape | null = null;
  private drawn = { calls: 0, triangles: 0 };
  /** A compile still polling: the material must outlive it. */
  private compiling: Promise<unknown> | null = null;
  private disposed = false;
  private glassHex = '';
  private rimHex = '';
  private readonly eyeView = new THREE.Vector3();

  constructor(look: BezelLook = defaultBezelLook()) {
    this.look = look;
    const u = (value: unknown): THREE.IUniform => ({ value });
    this.material = new THREE.ShaderMaterial({
      name: 'brainstack-prompt-bezel',
      uniforms: {
        uGlass: u(new THREE.Vector3()),
        uRimColour: u(new THREE.Vector3()),
        uRim: u(0),
        uSheen: u(0),
        uAccent: u(new THREE.Vector3(...SENTINEL_LINEAR.accent)),
        uLevel: u(1),
        uEyePos: u(new THREE.Vector3()),
        uEyeDir: u(new THREE.Vector3(0, 0, 1)),
        uEyeView: u(new THREE.Vector3()),
        uEyeCone: u(
          new THREE.Vector4(Math.cos(EYE_ANGLE), Math.cos(EYE_ANGLE * (1 - EYE_PENUMBRA)), 1, 0),
        ),
        uEyeSpill: u(1),
      },
      vertexShader: BEZEL_VS,
      fragmentShader: BEZEL_FS,
      toneMapped: false,
      transparent: true,
      depthWrite: true,
    });
    this.placeholder = new THREE.BufferGeometry();
    this.placeholder.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Array(9).fill(0), 3),
    );
    this.placeholder.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
    );
    this.mesh = new THREE.Mesh(this.placeholder, this.material);
    this.mesh.name = 'prompt bezel';
    this.mesh.matrixAutoUpdate = false;
    // Always on screen when it draws at all, and drawn once with the camera away to warm up.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  /** Its geometry, for tests: null before its first shape. */
  get geometry(): THREE.BufferGeometry | null {
    return this.size ? this.mesh.geometry : null;
  }

  /** What its last draw cost. */
  get info(): { calls: number; triangles: number } {
    return this.drawn;
  }

  /**
   * Shapes it to the frame, or hides it (null). The geometry is built again
   * only when the frame's size changes, the old one disposed; otherwise the
   * frame only moves.
   */
  shape(b: BezelShape | null): void {
    if (this.disposed) return;
    this.shaped = b;
    if (!b) {
      this.mesh.visible = false;
      return;
    }
    if (!sameSize(this.size, b)) {
      const old = this.mesh.geometry;
      this.mesh.geometry = bezelGeometry(b);
      if (old !== this.placeholder) old.dispose();
      this.size = {
        width: b.width,
        height: b.height,
        radius: b.radius,
        band: b.band,
        thickness: b.thickness,
      };
    }
    const m = this.mesh.matrix;
    m.makeBasis(
      new THREE.Vector3(...b.right),
      new THREE.Vector3(...b.up),
      new THREE.Vector3(...b.normal),
    );
    m.setPosition(b.centre[0], b.centre[1], b.centre[2]);
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.visible = true;
  }

  /**
   * Planes round the frame for `cam`, world units: room for the creature
   * perched behind it and its claws in front. What the Sentinel draws in
   * when no space drew first, so the two share one depth.
   *
   * Those hold the creature only while it clings to the frame. On its way to
   * the cluster or back it is anywhere between the two, tens of units past
   * the far plane, and drawn in them it would be sliced, then culled whole:
   * `also`, its bounding sphere in world units, widens them to hold it too.
   * The frame or the sphere behind the camera adds nothing. Null without a
   * shape, or with nothing in front of the camera to hold.
   */
  planes(
    cam: Camera,
    unit: number,
    also: { centre: Vec3; radius: number } | null = null,
  ): { near: number; far: number } | null {
    const b = this.shaped;
    if (!b || !(unit > 0)) return null;
    const { forward, position } = basis(cam);
    const ahead = (p: Vec3) =>
      (p[0] - position[0]) * forward[0] +
      (p[1] - position[1]) * forward[1] +
      (p[2] - position[2]) * forward[2];
    let lo = Infinity;
    let hi = -Infinity;
    const d = ahead(b.centre);
    if (d > 0 && Number.isFinite(d)) {
      lo = d - NEAR_ROOM * unit;
      hi = d + FAR_ROOM * unit;
    }
    if (also) {
      const s = ahead(also.centre);
      const r = Math.max(0, also.radius) * SPHERE_ROOM;
      if (Number.isFinite(s + r) && s + r > 0) {
        lo = Math.min(lo, s - r);
        hi = Math.max(hi, s + r);
      }
    }
    if (!(hi > 0)) return null;
    const near = Math.max(0.02 * unit, lo);
    return { near, far: Math.max(near * 2, hi) };
  }

  /**
   * Compiles its program for the canvas and uses it once with the camera
   * turned away, under its own error handler: rejects on a shader error.
   *
   * The mesh is shown for both, and afterwards shown exactly when it has a
   * shape — never put back as it was before the compile: a host shapes the
   * frame while the compile is still polling (the lab warms it up as it is
   * made, and lays the prompt out as the page hands it in), and that shape
   * must not come back hidden.
   */
  async warmup(renderer: THREE.WebGLRenderer): Promise<void> {
    if (this.disposed) throw new Error('Prompt bezel: warmup after dispose');
    const r = renderer;
    this.mesh.visible = true;
    try {
      this.compiling = withRendererState(r, () => {
        r.setRenderTarget(null);
        return r.compileAsync(this.scene, this.camera);
      });
      await this.compiling;
    } finally {
      this.compiling = null;
      this.mesh.visible = this.shaped !== null;
    }
    if (this.disposed) throw new Error('Prompt bezel: disposed while warming up');
    const failures: string[] = [];
    withRendererState(r, () => {
      const previous = r.debug.onShaderError;
      r.debug.onShaderError = (gl, _program, vertex, fragment) => {
        const logs = [gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)];
        failures.push(logs.filter((l) => l && l.trim()).join('\n') || 'link failed');
      };
      try {
        this.mesh.visible = true;
        const away = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 1);
        away.position.set(0, 1e7, 0);
        away.lookAt(0, 2e7, 0);
        r.setRenderTarget(null);
        r.autoClear = false;
        r.render(this.scene, away);
      } finally {
        this.mesh.visible = this.shaped !== null;
        r.debug.onShaderError = previous;
      }
    });
    if (failures.length) throw new Error(`Prompt bezel shader failed:\n${failures.join('\n')}`);
  }

  /**
   * Draws over what the canvas holds, at `f.level`, tested against and
   * writing into the depth already there, in `f.depth`'s planes (or its own).
   * Never clears.
   */
  render(renderer: THREE.WebGLRenderer, f: BezelFrame): void {
    this.drawn = { calls: 0, triangles: 0 };
    const { cam, vp } = f;
    const level = Math.min(1, f.level);
    if (this.disposed || !this.shaped || !(level > 0)) return;
    if (!(vp.width > 0 && vp.height > 0)) return;
    const planes = f.depth ?? this.planes(cam, f.unit);
    if (!planes || !(planes.near > 0 && planes.far > planes.near)) return;
    this.aim(cam, vp, planes);
    this.set(f, level);
    const r = renderer;
    withRendererState(r, () => {
      r.info.autoReset = false;
      r.info.reset();
      r.setRenderTarget(null);
      r.autoClear = false;
      r.render(this.scene, this.camera);
      this.drawn = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    });
  }

  /** The graph's camera, placed exactly as graph-scene.ts places it, in `planes`. */
  private aim(cam: Camera, vp: Viewport, planes: { near: number; far: number }): void {
    const { position, up } = basis(cam);
    const c = this.camera;
    c.position.set(position[0], position[1], position[2]);
    c.up.set(up[0], up[1], up[2]);
    c.lookAt(cam.tx, cam.ty, cam.tz);
    const aspect = vp.width / vp.height;
    if (
      c.near !== planes.near ||
      c.far !== planes.far ||
      c.aspect !== aspect ||
      c.fov !== FOV_DEG
    ) {
      c.near = planes.near;
      c.far = planes.far;
      c.aspect = aspect;
      c.fov = FOV_DEG;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
  }

  /** This frame's uniforms: the look, the level and the eye. */
  private set(f: BezelFrame, level: number): void {
    const u = this.material.uniforms;
    const k = this.look;
    if (k.colour !== this.glassHex) {
      this.glassHex = k.colour;
      (u.uGlass!.value as THREE.Vector3).set(...linear(k.colour));
    }
    if (k.rimColour !== this.rimHex) {
      this.rimHex = k.rimColour;
      (u.uRimColour!.value as THREE.Vector3).set(...linear(k.rimColour));
    }
    u.uRim!.value = Math.max(0, k.rim);
    u.uSheen!.value = Math.max(0, k.sheen);
    u.uLevel!.value = level;
    u.uEyeSpill!.value = EYE_SPILL * f.unit;

    const eye = f.eye;
    const cone = u.uEyeCone!.value as THREE.Vector4;
    const seen =
      !!eye &&
      Number.isFinite(eye.position[0] + eye.position[1] + eye.position[2] + eye.intensity) &&
      Math.hypot(eye.dir[0], eye.dir[1], eye.dir[2]) > 1e-9;
    if (eye && seen) {
      const pos = u.uEyePos!.value as THREE.Vector3;
      pos.set(eye.position[0], eye.position[1], eye.position[2]);
      (u.uEyeDir!.value as THREE.Vector3).set(eye.dir[0], eye.dir[1], eye.dir[2]).normalize();
      cone.z = Math.max(1e-6, k.eyeReach) * f.unit;
      cone.w = (Math.max(0, k.glint) * Math.max(0, eye.intensity)) / EYE_REST;
      (u.uEyeView!.value as THREE.Vector3).copy(
        this.eyeView.copy(pos).applyMatrix4(this.camera.matrixWorldInverse),
      );
    } else cone.w = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometry = this.mesh.geometry;
    if (geometry !== this.placeholder) geometry.dispose();
    this.placeholder.dispose();
    this.size = null;
    this.shaped = null;
    // A compile still polling reads its material's state until it settles.
    const free = () => this.material.dispose();
    if (this.compiling) this.compiling.then(free, free);
    else free();
    this.scene.clear();
  }
}
