// The Sentinel on screen: it takes one pose a frame and draws it over the
// graph, straight into the graph's canvas, with the canvas's own
// multisampling. The graph draws first; the Sentinel clears only depth and
// draws on top, then adds its glow. The lit threads, labels and found notes
// are on the 2D overlay above both, so the creature never hides the walk.
//
// It works in creature space — the world moved to the body and divided by the
// vault's typical link — with its own scene and camera. The camera matches
// the graph's view exactly (same basis, field of view and aspect: scaling a
// scene and its camera together changes nothing on screen), with near and
// far planes fitted to the creature. Lights, distances and the hangar are
// tuned once, in these units, for any vault.
//
// In a space of Crawl's own (space/space.ts) the space draws first and writes
// depth. There the Sentinel can draw into that depth instead of clearing it,
// with the space's near and far planes brought into creature space, so a pipe
// in front of a tentacle hides it. The space can also lend its environment
// map, so the metal reflects the space it walks in rather than the hangar.
//
// Lighting: the hangar's reflections; a cold rim light from behind, placed
// from the camera every frame; and the eye, a spotlight at the lens — the
// only light the creature makes. Neither light is ever hidden (hiding one
// recompiles every material); they dim through their intensity.
//
// Every change to the shared renderer happens inside withRendererState. Tone
// mapping is switched on only around the creature's own draw: the graph's
// materials are never drawn with it, so they never recompile.
//
// Quality tiers swap the hull's level of detail, the instance counts and the
// glow's resolution — never a material, a light or the environment, so a
// tier change never compiles a shader.

import * as THREE from 'three';

import { FOV_DEG, TAN_HALF_FOV, basis, type Camera, type Viewport } from '@/lib/graph-camera';

import { CLAW_FINGERS, TENTACLES } from './anatomy';
import { bakeEnvironment, buildHangar, disposeScene } from './environment';
import {
  IRIS,
  LENS_POINT,
  buildClawFinger,
  buildHull,
  buildIrisBlade,
  buildVertebra,
  writeIrisMatrices,
  type HullLod,
} from './geometry';
import { withRendererState } from './gl-state';
import { SentinelGlow } from './glow';
import { defaultLook, type SentinelLook } from './look';
import { createMaterials, type SentinelMaterials } from './materials';
import { linear, SENTINEL_LINEAR } from './palette';
import type { SentinelPose } from './pose';
import { SENTINEL_SEED } from './rig';
import { MAX_SEGMENTS, TIERS, type Tier } from './tiers';
import { bakeWear, type WearMaps } from './wear';

const WEAR_SIZE = 256;
const CLAWS = TENTACLES * CLAW_FINGERS;
/** The hull's own reach from the body's centre: the least a pose's bounds may claim. */
const HULL_REACH = 0.55;

// -- What the CPU builds once per page ---------------------------------------------

interface Assets {
  hull: Record<HullLod, THREE.BufferGeometry>;
  vertebra: THREE.BufferGeometry;
  claw: THREE.BufferGeometry;
  iris: THREE.BufferGeometry;
  wear: WearMaps;
}

let assets: Assets | null = null;
let building: Promise<Assets> | null = null;

/** Lets the page draw a frame between two long pieces of work. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Geometry and wear take tens of milliseconds each and never change: built
 * once, a piece per task so the page keeps drawing frames meanwhile, and
 * kept for the next time Crawl opens. Each view draws clones of them.
 */
function loadAssets(): Promise<Assets> {
  if (assets) return Promise.resolve(assets);
  building ??= (async () => {
    const wear = bakeWear(WEAR_SIZE, SENTINEL_SEED);
    await breathe();
    const low = buildHull('low');
    await breathe();
    const high = buildHull('high');
    await breathe();
    assets = {
      hull: { high, low },
      vertebra: buildVertebra(8),
      claw: buildClawFinger(),
      iris: buildIrisBlade(),
      wear,
    };
    return assets;
  })().catch((error: unknown) => {
    building = null;
    throw error;
  });
  return building;
}

/** The GPU side of one view: meshes over clones of the shared geometry. */
interface Body {
  hullGeometry: Record<HullLod, THREE.BufferGeometry>;
  hull: THREE.Mesh;
  segments: THREE.InstancedMesh;
  claws: THREE.InstancedMesh;
  iris: THREE.InstancedMesh;
  materials: SentinelMaterials;
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  // Per instance: glow, wear seed, position along the tentacle, tentacle.
  const seg = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  seg.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aSeg', seg);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Three caches an instanced mesh's bounds once; the view skips off-screen frames itself.
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

/** Copies `count` instances' matrices and attributes in, uploading only what is used. */
function upload(
  mesh: THREE.InstancedMesh,
  matrices: Float32Array,
  attrs: Float32Array,
  count: number,
): void {
  const capacity = mesh.instanceMatrix.count;
  const n = Math.max(
    0,
    Math.min(Math.floor(count), capacity, Math.floor(matrices.length / 16), attrs.length >> 2),
  );
  mesh.count = n;
  if (n === 0) return;
  const m = mesh.instanceMatrix;
  (m.array as Float32Array).set(matrices.subarray(0, n * 16));
  m.clearUpdateRanges();
  m.addUpdateRange(0, n * 16);
  m.needsUpdate = true;
  const a = mesh.geometry.getAttribute('aSeg') as THREE.InstancedBufferAttribute;
  (a.array as Float32Array).set(attrs.subarray(0, n * 4));
  a.clearUpdateRanges();
  a.addUpdateRange(0, n * 4);
  a.needsUpdate = true;
}

export interface SentinelViewOptions {
  tier: Tier;
  /** The GPU renders to half-float buffers: without them there is no environment map and no glow. */
  floatColor: boolean;
  /** What the metal reflects, for comparing in the lab (a RoomEnvironment, say). The default is the hangar; the caller keeps ownership of its own. */
  environment?: THREE.Scene;
}

export interface SentinelRenderOptions {
  /**
   * The near and far planes the space's camera drew with this frame, world
   * units: the Sentinel draws into the depth the space wrote, instead of
   * clearing it. Null or absent, it clears depth and draws on top.
   */
  depth?: { near: number; far: number } | null;
}

/**
 * A space's depth range in creature units, or null when there is none worth
 * sharing.
 *
 * Creature space is the world moved to the anchor and divided by `unit`, with
 * no rotation. In the Sentinel's camera every view-space coordinate is the
 * space camera's divided by `unit`. A perspective projection's depth is
 * (A·z + B) / −z, where A depends only on far / near and B scales with them.
 * Dividing z, near and far by `unit` leaves A as it was and divides B by
 * `unit`, so the numerator and the denominator shrink alike and the NDC depth
 * comes out the same. The same field of view and aspect fix x and y. Both
 * cameras therefore put every surface at the same depth in the buffer, up to
 * float rounding, and the depth test between the space's pipes and the
 * creature is exact. This holds for the standard depth buffer the graph's
 * renderer uses; a logarithmic one writes log(view depth), which a scale does
 * change.
 *
 * A range the space cannot have drawn with (not positive, not finite, far not
 * beyond near) is treated as no range: the creature draws on its own rather
 * than being clipped by nonsense.
 */
export function creatureDepthRange(
  depth: { near: number; far: number } | null | undefined,
  unit: number,
): { near: number; far: number } | null {
  if (!depth) return null;
  const near = depth.near / unit;
  const far = depth.far / unit;
  if (!(near > 0 && far > near && Number.isFinite(far))) return null;
  return { near, far };
}

/** The height three reads from a PMREM's image when it keys a program; null for anything else. */
function cubeUvHeight(texture: THREE.Texture): number | null {
  if (texture.mapping !== THREE.CubeUVReflectionMapping) return null;
  const height = (texture.image as { height?: unknown } | null | undefined)?.height;
  return typeof height === 'number' ? height : null;
}

/**
 * True when a material drawn with either environment map uses the same
 * program. Three keys a standard material's program on its map's mapping and,
 * for a PMREM, on the map's height (`envMapCubeUVHeight` in WebGLPrograms),
 * never on the texture itself. Two PMREMs of one size share every program.
 * Anything else three converts to a PMREM of its own size first, or skips
 * while the image loads: either way, another program.
 */
export function sharesPrograms(a: THREE.Texture, b: THREE.Texture): boolean {
  const height = cubeUvHeight(a);
  return height !== null && height === cubeUvHeight(b);
}

export class SentinelView {
  /** Read every frame: change it freely, nothing compiles. */
  look: SentinelLook = defaultLook();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly floatColor: boolean;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 10);
  private readonly rim = new THREE.DirectionalLight();
  private readonly eye = new THREE.SpotLight();
  /** Stands in for the environment when there is none. */
  private readonly sky: THREE.HemisphereLight | null;
  private readonly envScene: THREE.Scene;
  private readonly ownsEnvScene: boolean;
  private readonly glow: SentinelGlow | null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  /** A space's environment, lent while the Sentinel walks in it: drawn with, never disposed. */
  private lent: THREE.Texture | null = null;
  private body: Body | null = null;
  private tier: Tier;
  private warming: Promise<void> | null = null;
  /** A compile still polling: materials must outlive it, or three's poll reads freed state. */
  private compiling: Promise<unknown> | null = null;
  private isReady = false;
  private disposed = false;
  private drawn = { calls: 0, triangles: 0 };
  private rimHex = '';

  constructor(renderer: THREE.WebGLRenderer, opts: SentinelViewOptions) {
    this.renderer = renderer;
    this.tier = opts.tier;
    this.floatColor = opts.floatColor;
    this.envScene = opts.environment ?? buildHangar();
    this.ownsEnvScene = !opts.environment;
    this.glow = opts.floatColor ? new SentinelGlow(TIERS[opts.tier].bloomScale) : null;

    this.eye.color.setRGB(...SENTINEL_LINEAR.accent);
    this.eye.angle = 0.55;
    this.eye.penumbra = 0.7;
    this.eye.decay = 2;
    this.eye.distance = 0;
    // Lights aim at their targets' world positions: the targets must be in the scene to have one.
    this.scene.add(this.rim, this.rim.target, this.eye, this.eye.target);
    if (opts.floatColor) {
      this.sky = null;
    } else {
      // Without an environment map the metal would reflect nothing: a dim, cold sky instead.
      this.sky = new THREE.HemisphereLight(0x9fb4b4, 0x050607, 0.5);
      this.scene.add(this.sky);
    }
  }

  /** True once warmed up: render() draws nothing before. */
  get ready(): boolean {
    return this.isReady;
  }

  /** What the last frame cost, for the lab: draw calls and triangles, and the renderer's programs. */
  get info(): { calls: number; triangles: number; programs: number } {
    return { ...this.drawn, programs: this.renderer.info.programs?.length ?? 0 };
  }

  /**
   * Builds and uploads everything, bakes the environment and compiles every
   * shader the Sentinel uses, for the state it will draw in. Rejects if one
   * of its shaders fails, or if the view is disposed meanwhile.
   */
  warmup(): Promise<void> {
    this.warming ??= this.prepare();
    return this.warming;
  }

  private alive(): void {
    if (this.disposed) throw new Error('The Sentinel view was disposed while warming up');
  }

  private async prepare(): Promise<void> {
    const a = await loadAssets();
    this.alive();
    const body = this.createBody(a);
    this.body = body;
    if (this.floatColor) {
      this.envTarget = bakeEnvironment(this.renderer, this.envScene, 256);
      this.applyEnvironment();
    }
    this.sync(body);

    // Compile in the state the creature draws in: the program cache key
    // includes the render target (none: the canvas) and the tone mapping.
    const r = this.renderer;
    this.compiling = withRendererState(r, () => {
      r.setRenderTarget(null);
      r.toneMapping = THREE.AgXToneMapping;
      return r.compileAsync(this.scene, this.camera);
    });
    try {
      await this.compiling;
    } finally {
      this.compiling = null;
    }
    this.alive();

    // Three checks a program for errors the first time it is used: use each
    // one once, with our own error handler in place.
    const failures: string[] = [];
    withRendererState(r, () => {
      const previous = r.debug.onShaderError;
      r.debug.onShaderError = (gl, _program, vertex, fragment) => {
        const logs = [gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)];
        failures.push(logs.filter((l) => l && l.trim()).join('\n') || 'link failed');
      };
      try {
        this.warmDraw(body);
      } finally {
        r.debug.onShaderError = previous;
      }
    });
    if (failures.length) throw new Error(`Sentinel shaders failed:\n${failures.join('\n')}`);
    this.isReady = true;
  }

  private createBody(a: Assets): Body {
    const materials = createMaterials(a.wear, WEAR_SIZE);
    const hullGeometry = { high: a.hull.high.clone(), low: a.hull.low.clone() };
    const hull = new THREE.Mesh(hullGeometry[TIERS[this.tier].hullLod], materials.hull);
    hull.matrixAutoUpdate = false;
    hull.frustumCulled = false;
    const segments = instanced(a.vertebra.clone(), materials.parts, MAX_SEGMENTS);
    const claws = instanced(a.claw.clone(), materials.parts, CLAWS);
    const iris = instanced(a.iris.clone(), materials.parts, IRIS.blades);
    iris.count = IRIS.blades;
    const irisSeg = iris.geometry.getAttribute('aSeg') as THREE.InstancedBufferAttribute;
    for (let k = 0; k < IRIS.blades; k++) irisSeg.setXYZW(k, 0, (k + 0.5) / IRIS.blades, 0, -1);
    this.scene.add(hull, segments, claws, iris);
    return { hullGeometry, hull, segments, claws, iris, materials };
  }

  /** Uses every program once with the camera turned away: nothing reaches the canvas. */
  private warmDraw(body: Body): void {
    const r = this.renderer;
    const away = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 1);
    away.position.set(0, 0, 100);
    away.lookAt(0, 0, 200);
    const counts = [body.segments.count, body.claws.count];
    // Their matrices are still zero: drawn, they collapse to a point.
    body.segments.count = Math.max(1, counts[0]!);
    body.claws.count = Math.max(1, counts[1]!);
    try {
      r.setRenderTarget(null);
      r.autoClear = false;
      r.toneMapping = THREE.AgXToneMapping;
      r.render(this.scene, away);
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      this.glow?.warm(r, size.x, size.y, () =>
        this.withGlowMaterials(body, () => r.render(this.scene, away)),
      );
    } finally {
      body.segments.count = counts[0]!;
      body.claws.count = counts[1]!;
    }
  }

  /** Swaps the step's detail: the hull's mesh and the glow's resolution. Compiles nothing. */
  setTier(tier: Tier): void {
    this.tier = tier;
    if (this.body) this.body.hull.geometry = this.body.hullGeometry[TIERS[tier].hullLod];
    this.glow?.setScale(TIERS[tier].bloomScale);
  }

  /**
   * Reflects a space's own environment instead of the hangar, so the metal
   * shows the space it walks in; null goes back to the hangar. The space keeps
   * the texture: the view never disposes it, and the space takes it back
   * (null, or its successor's) before disposing it.
   *
   * Lend a PMREM of the hangar's size, 256, baked with this renderer: what
   * `bakeEnvironment` makes by default. Swapping between two of those compiles
   * nothing (see `sharesPrograms`). Any other size or kind of map recompiles
   * every Sentinel material on the next frame, mid-walk; in development the
   * view says so.
   *
   * A lent map shows the space around the creature, so it is world-locked: it
   * does not turn with the viewer as the hangar does. Without float colour
   * there is no environment map, lent or not; the sky stands in.
   */
  setEnvironment(texture: THREE.Texture | null): void {
    if (this.disposed || texture === this.lent) return;
    this.lent = texture;
    this.applyEnvironment();
  }

  /** The lent map if there is one, else the hangar once it is baked. */
  private applyEnvironment(): void {
    if (!this.floatColor) return;
    const hangar = this.envTarget?.texture ?? null;
    const lent = this.lent;
    if (process.env.NODE_ENV !== 'production' && lent && hangar && !sharesPrograms(lent, hangar)) {
      console.warn(
        'Sentinel: the lent environment is not a 256 PMREM like the hangar, so every material recompiles.',
      );
    }
    this.scene.environment = lent ?? hangar;
  }

  /**
   * Draws one frame of the Sentinel over what the canvas holds. `cam`, `vp`
   * and `dpr` are the graph's: the same view, the same drawing buffer. Does
   * nothing before warmup, or when the creature is off screen.
   *
   * With `opts.depth`, the space that drew first shares its depth: nothing
   * is cleared, and whatever the space put in front of the creature hides it.
   */
  render(
    pose: SentinelPose,
    cam: Camera,
    vp: Viewport,
    dpr: number,
    opts: SentinelRenderOptions = {},
  ): void {
    this.drawn = { calls: 0, triangles: 0 };
    const body = this.body;
    if (!this.isReady || this.disposed || !body) return;
    if (!(pose.unit > 0) || !pose.anchor.every(Number.isFinite)) return;
    if (!(vp.width > 0 && vp.height > 0)) return;
    const shared = creatureDepthRange(opts.depth, pose.unit);
    if (!this.aim(pose, cam, vp, shared)) return;
    this.place(body, pose, cam);
    this.sync(body);

    const r = this.renderer;
    const look = this.look;
    withRendererState(r, () => {
      // Count only our own draws, across every render() below.
      r.info.autoReset = false;
      r.info.reset();
      r.setRenderTarget(null);
      r.autoClear = false;
      // A space's depth is fresh, cleared and written by it this frame: kept, so its pipes hide us.
      if (!shared) {
        // The graph writes no depth, but nothing may hide the creature behind a stale value.
        // A clear honours the depth mask, and the graph's last draw left writes off.
        r.state.buffers.depth.setMask(true);
        r.clearDepth();
      }
      r.toneMapping = THREE.AgXToneMapping;
      r.toneMappingExposure = look.exposure;
      r.render(this.scene, this.camera);
      this.glow?.render(r, Math.floor(vp.width * dpr), Math.floor(vp.height * dpr), look, () =>
        this.withGlowMaterials(body, () => r.render(this.scene, this.camera)),
      );
      this.drawn = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    });
  }

  /**
   * Places the camera in creature space, as the graph's camera sees the
   * world. False when the creature's bounds are off screen or behind, or,
   * sharing a space's depth range, wholly outside it. Its near and far planes
   * hug the creature, or are the space's own when it shares its depth.
   */
  private aim(
    pose: SentinelPose,
    cam: Camera,
    vp: Viewport,
    shared: { near: number; far: number } | null,
  ): boolean {
    const { position, up, right, forward } = basis(cam);
    const [ax, ay, az] = pose.anchor;
    const inv = 1 / pose.unit;
    const px = (position[0] - ax) * inv;
    const py = (position[1] - ay) * inv;
    const pz = (position[2] - az) * inv;
    this.camera.position.set(px, py, pz);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.lookAt((cam.tx - ax) * inv, (cam.ty - ay) * inv, (cam.tz - az) * inv);

    const radius = Math.max(pose.bounds[3] ?? 0, HULL_REACH);
    const dx = (pose.bounds[0] ?? 0) - px;
    const dy = (pose.bounds[1] ?? 0) - py;
    const dz = (pose.bounds[2] ?? 0) - pz;
    const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
    if (!Number.isFinite(depth) || depth < -radius) return false;
    const aspect = vp.width / vp.height;
    const tanH = TAN_HALF_FOV * aspect;
    const across = dx * right[0] + dy * right[1] + dz * right[2];
    const upward = dx * up[0] + dy * up[1] + dz * up[2];
    // Outside a side of the frustum by more than the sphere's radius.
    if ((Math.abs(across) - depth * tanH) / Math.hypot(1, tanH) > radius) return false;
    if ((Math.abs(upward) - depth * TAN_HALF_FOV) / Math.hypot(1, TAN_HALF_FOV) > radius) {
      return false;
    }
    let near: number;
    let far: number;
    if (shared) {
      // Wholly before the space's near plane or past its far one: the clip would leave nothing.
      if (depth + radius < shared.near || depth - radius > shared.far) return false;
      ({ near, far } = shared);
    } else {
      near = Math.max(0.01, depth - radius * 1.05);
      far = Math.max(near * 2, depth + radius * 1.05);
    }
    if (
      this.camera.near !== near ||
      this.camera.far !== far ||
      this.camera.aspect !== aspect ||
      this.camera.fov !== FOV_DEG
    ) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.aspect = aspect;
      this.camera.fov = FOV_DEG;
      this.camera.updateProjectionMatrix();
    }
    return true;
  }

  /** The pose into meshes, lights and the uniforms it drives. */
  private place(body: Body, pose: SentinelPose, cam: Camera): void {
    const h = pose.hull;
    body.hull.matrix.fromArray(h);
    body.hull.matrixWorldNeedsUpdate = true;
    upload(body.segments, pose.segmentMatrices, pose.segmentAttrs, pose.segments);
    upload(body.claws, pose.clawMatrices, pose.clawAttrs, pose.claws);
    writeIrisMatrices(h, pose.eye.aperture, body.iris.instanceMatrix.array as Float32Array);
    body.iris.instanceMatrix.needsUpdate = true;

    const u = body.materials.uniforms;
    u.uHullCenter.value.set(h[12]!, h[13]!, h[14]!);
    const intensity = Math.max(0, pose.eye.intensity);
    u.uEye.value = intensity * this.look.eyeGain;

    // The eye's light sits at the lens and looks where the eye looks.
    const [lx, ly, lz] = LENS_POINT;
    const ex = h[0]! * lx + h[4]! * ly + h[8]! * lz + h[12]!;
    const ey = h[1]! * lx + h[5]! * ly + h[9]! * lz + h[13]!;
    const ez = h[2]! * lx + h[6]! * ly + h[10]! * lz + h[14]!;
    const [gx, gy, gz] = pose.eye.dir;
    this.eye.position.set(ex, ey, ez);
    this.eye.target.position.set(ex + gx, ey + gy, ez + gz);
    this.eye.intensity = intensity * this.look.eyeLightIntensity;

    // The rim light comes from behind the creature, above and to the left as the viewer sees it.
    const { up, right, forward } = basis(cam);
    this.rim.position.set(
      0.75 * forward[0] + 0.55 * up[0] - 0.35 * right[0],
      0.75 * forward[1] + 0.55 * up[1] - 0.35 * right[1],
      0.75 * forward[2] + 0.55 * up[2] - 0.35 * right[2],
    );
    // The hangar turns with the viewer, so its strips stay overhead and behind.
    // A space's map is the world around the creature, which creature space
    // does not rotate: it stays put.
    const yaw = this.lent ? 0 : cam.yaw + this.look.envYawOffset;
    this.scene.environmentRotation.set(0, yaw, 0);
  }

  /** The look into uniforms and light settings: every frame, all of it live. */
  private sync(body: Body): void {
    const look = this.look;
    body.materials.setLook(look);
    this.scene.environmentIntensity = look.envIntensity;
    if (this.sky) this.sky.intensity = 0.5 * look.envIntensity;
    this.rim.intensity = look.rimIntensity;
    if (look.rimColor !== this.rimHex) {
      this.rimHex = look.rimColor;
      this.rim.color.setRGB(...linear(look.rimColor));
    }
  }

  private withGlowMaterials(body: Body, draw: () => void): void {
    const { materials } = body;
    body.hull.material = materials.hullGlow;
    body.segments.material = materials.partsGlow;
    body.claws.material = materials.partsGlow;
    body.iris.material = materials.partsGlow;
    try {
      draw();
    } finally {
      body.hull.material = materials.hull;
      body.segments.material = materials.parts;
      body.claws.material = materials.parts;
      body.iris.material = materials.parts;
    }
  }

  /** Frees everything it put on the GPU. Call it while the renderer is still alive. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isReady = false;
    const body = this.body;
    this.body = null;
    if (body) {
      body.hullGeometry.high.dispose();
      body.hullGeometry.low.dispose();
      for (const mesh of [body.segments, body.claws, body.iris]) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      // A compile still polling reads its materials' state until it settles.
      const free = () => body.materials.dispose();
      if (this.compiling) this.compiling.then(free, free);
      else free();
    }
    // A lent map is the space's to free: only let go of it.
    this.lent = null;
    this.scene.environment = null;
    this.envTarget?.dispose();
    this.envTarget = null;
    if (this.ownsEnvScene) disposeScene(this.envScene);
    this.glow?.dispose();
    this.scene.clear();
  }
}
