// The dormant network: Crawl's space of its own, a cluster of notes that
// stays dark until the Sentinel wakes it. Notes fill the volume of one form
// (volume/layout.ts) — a hub and the lobes round it on short necks, the
// biggest projects each a lobe, the rest regions of the hub, and the island
// on a satellite apart — standing as crystals. Threads run through it as
// straight chords with a gentle bow, so a walk between projects crosses the
// hub, and the Sentinel walks them with world up, as it walks the brain.
//
// Asleep, the network is dark glass and faint filaments inside a fainter
// cage — enough to read as a network with a shape, never enough to compete
// with what the crawl lights. Then the crawl wakes it, and what it did stays:
//
//  - the eye reveals what falls in its cone: specular, rims and edges come up
//    only there, and fade again as it moves on;
//  - a note the walk passes flares and keeps an ember;
//  - a note found ignites in the colour of why it was found, with a ring
//    running out round it, facing the camera, and keeps a halo and a slow
//    breath;
//  - a thread walked becomes a tube of light, hot behind the walk, cooling to
//    a trail with pulses running the way it went; a thread a grip closes on
//    flashes and goes dark again.
//
// All of that is read from the replay's stamped history (state.ts), on the
// replay's clock, so it is the same at any frame rate and after a jump to the
// end, and nothing is uploaded while nothing new happens.
//
// The camera follows the walk through the volume, so what passes close to it
// dissolves rather than blocking the view, and what lies beyond the focus
// dims as the brain's depth cue dims it, so the volume reads near to far
// (shaders.ts).
//
// It draws first into the graph's canvas — clearing it to the graph's own
// background, writing depth — with a camera placed exactly as the graph's,
// and reports the depth range it drew with so the Sentinel draws into the
// same depth: a tube in front of a tentacle hides it. Seven or eight draws,
// one program each kind, and every renderer setting it touches is put back
// (withRendererState). It never changes the renderer's clear colour: its
// background clears with its own.

import * as THREE from 'three';
import type GUI from 'three/addons/libs/lil-gui.module.min.js';

import { FOV_DEG, TAN_HALF_FOV, basis, type Bounds } from '@/lib/graph-camera';
import { colorOf, hash01, type GraphEdge, type GraphModel } from '@/lib/graph-model';

import { walkable } from '../../crawl-plan';
import { withRendererState } from '../../sentinel/gl-state';
import { SENTINEL_PALETTE, linear } from '../../sentinel/palette';
import { threadKey, type ThreadKey } from '../../threads';
import type { Vec3 } from '../../vec';
import { polylineThreadField } from '../polyline-field';
import type { CrawlSpace, SpaceBuild, SpaceFrame } from '../space';
import { cageLines } from '../volume/cage';
import { CAGE_OUT, type Cluster } from '../volume/cluster';
import { volumeLayout, type CrystalKind, type VolumeLayout } from '../volume/layout';

import { buildCage, cageMaterial } from './cage';
import { routeChords, type RouteChords } from './chords';
import { CrystalMeshes, crystalMaterial, type CrystalNote } from './crystal-meshes';
import { Filaments, filamentMaterial } from './filaments';
import { defaultKnobs, type DormantKnobs } from './knobs';
import { Sprites, haloMaterial, ringMaterial } from './sprites';
import { DormantState, type StateUpload } from './state';
import { Tubes, tubeMaterial } from './tubes';

export const DORMANT_NETWORK = 'Dormant network';

/**
 * The graph's background: the canvas is cleared to it, as graph-scene.ts
 * clears it, and the opaque crystals and filaments fade into it with depth.
 */
const BACKGROUND = '#0a0a0a';
/**
 * The fastest a walk crosses the cluster, creature units a second. A leg from
 * one lobe through the hub to another runs 30–40 units: at 9 it takes about
 * 3.5–4.5 s, near the 3.4 s the brain caps any leg at, and the follow
 * camera's 450 ms ease trails the walk by about half its distance.
 */
const PACE = 9;
/** A gentle pitch over the cluster, and the chase's distance, creature units. */
const CAMERA = { pitch: 0.3, follow: 8 } as const;
/** The brain's lines' brightness by kind, as graph-scene.ts draws them: the dormant threads match it. */
const LINE = { link: 0.22, structure: 0.08 } as const;
/**
 * A thread longer than LONG_FROM creature units dims, losing LONG_DIM of its
 * light by LONG_TO: the links between projects cross the hub.
 */
const LONG_FROM = 4;
const LONG_TO = 24;
const LONG_DIM = 0.6;
/**
 * The brain's depth cue: whole up to where the camera looks, then dimmer over
 * DEPTH_RANGE times the form's radius, never under DEPTH_FLOOR.
 */
const DEPTH_RANGE = 1.4;
const DEPTH_FLOOR = 0.2;
/**
 * The near fade never reaches past this share of the way to where the camera
 * looks: zoomed in closer than the knob's distance, the note in view stays
 * whole, and only what lies well in front of it dissolves.
 */
const NEAR_KEEP = 0.6;

/** The eye's cone, as the Sentinel's spotlight has it (view.ts): angle and penumbra. */
const EYE_ANGLE = 0.55;
const EYE_PENUMBRA = 0.7;
/** The eye's intensity at rest: there, a gain of 1 reveals fully. */
const EYE_REST = 0.55;
/** The light that spills right round the lens, creature units. */
const EYE_SPILL = 1.6;

/** Seconds a ring takes to run out (the ring shader's own). */
const RING_SECONDS = 0.9;
/** Trail pulses: their spacing, creature units, and how much each one adds. */
const PULSE_GAP = 2.4;
const PULSE_GAIN = 2.5;
/**
 * The least a thread is drawn on screen, CSS pixels: a filament across, a
 * tube's radius. A filament at a bare pixel shows alpha to coverage's
 * stipple along it; a quarter more reads as a line. A tube stays wider than
 * the filament under it, or the filament's edges would show either side.
 */
const FILAMENT_MIN_PX = 1.25;
const TUBE_MIN_PX = 1.4;

/** The colours of why a note was found: Crawl's own (named, linked, decision). */
const WHY = ['#b8a6ff', '#5eead4', '#4ade80'] as const;
/** Dormant glass and its rim. */
const GLASS = '#14181c';
const RIM = '#8fa3b0';
/** How bright the dormant glass's rim is, and its faint inner light, before the glass knob. */
const RIM_LEVEL = 0.1;
const PIP_LEVEL = 0.04;
/**
 * The cage: a cool grey at 0.024 of its light, about two thirds of a dormant
 * link from afar, where it is the form's outline; close up the shader keeps
 * it under a third of one.
 */
const CAGE = '#9fb4b4';
const CAGE_LEVEL = 0.024;
/** A found note's core, halo and ring. */
const CORE_LIT = 1.6;
const HALO_GAIN = 0.35;
const RING_GAIN = 0.8;
/** The eye's highlight on dormant glass. */
const SPECULAR = 1.5;

const vec3 = (rgb: readonly number[]) => new THREE.Vector3(rgb[0], rgb[1], rgb[2]);
const BACKGROUND_LINEAR = vec3(linear(BACKGROUND));
const GLASS_LINEAR = vec3(linear(GLASS));
const CAGE_LINEAR = vec3(linear(CAGE));

/** sRGB 0–1 to linear light. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

interface Built {
  layout: VolumeLayout;
  chords: RouteChords;
  state: DormantState;
  nodeTexture: THREE.DataTexture;
  threadTexture: THREE.DataTexture;
  cage: THREE.LineSegments;
  /** Segments in the cage. */
  cageSegments: number;
  crystals: CrystalMeshes;
  filaments: Filaments;
  tubes: Tubes;
  sprites: Sprites;
  /** The crystal size the crystals were placed at. */
  size: number;
  ms: number;
}

/** What the lab shows of the network. */
export interface DormantStats {
  /** Lobes, whether there is a satellite, and the lattice's sites. */
  lobes: number;
  satellite: boolean;
  sites: number;
  /** The form's bounding radius, world units. */
  radius: number;
  /** World units per creature unit. */
  unit: number;
  notes: number;
  threads: number;
  chords: number;
  /** Pieces regions fell in beyond their first: 0 is the promise. */
  pieces: number;
  /** Notes the layout found no site for, so nothing draws them: 0 is the promise. */
  unplaced: number;
  /** The layout alone, and the whole build, milliseconds. */
  layoutMs: number;
  buildMs: number;
  /** State texture uploads so far: it stops growing at rest. */
  uploads: number;
  /** Chords of the trail drawn as tubes. */
  tubes: number;
  /** Segments of the cage. */
  cage: number;
}

export class DormantNetwork implements CrawlSpace {
  readonly name = DORMANT_NETWORK;
  /** No light of its own to lend: the Sentinel's hangar suits a dark cluster. */
  readonly environment: THREE.Texture | null = null;
  /** Read every frame; `spacing`, `neck` and `bow` take effect at the next build. */
  readonly knobs: DormantKnobs;
  /**
   * Called when a knob that changes the layout settles: whoever drives the
   * space builds it again (and starts the crawl over on the new layout).
   */
  onRebuild: (() => void) | null = null;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 10);
  /** Every material reads these: one object, so a frame sets each once. */
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly materials: {
    cage: THREE.ShaderMaterial;
    crystal: THREE.ShaderMaterial;
    filament: THREE.ShaderMaterial;
    tube: THREE.ShaderMaterial;
    halo: THREE.ShaderMaterial;
    ring: THREE.ShaderMaterial;
  };
  private built: Built | null = null;
  private decisions: ReadonlySet<string> = new Set();
  private lastDepth: { near: number; far: number } | null = null;
  private drawn = { calls: 0, triangles: 0 };
  /** A compile still polling: materials must outlive it. */
  private compiling: Promise<unknown> | null = null;
  private disposed = false;
  private readonly buffer = new THREE.Vector2();
  private readonly eyeView = new THREE.Vector3();

  constructor(knobs: DormantKnobs = defaultKnobs()) {
    this.knobs = knobs;
    const u = (value: unknown): THREE.IUniform => ({ value });
    this.uniforms = {
      uNodes: u(null),
      uThreads: u(null),
      uClock: u(0),
      uTime: u(0),
      uStill: u(0),
      uUnit: u(1),
      uAccent: u(vec3(linear(SENTINEL_PALETTE.accent))),
      uReadColour: u(vec3(linear(SENTINEL_PALETTE.core))),
      uWhy: u([vec3(linear(SENTINEL_PALETTE.accent)), ...WHY.map((hex) => vec3(linear(hex)))]),
      uEyePos: u(new THREE.Vector3()),
      uEyeDir: u(new THREE.Vector3(0, 0, 1)),
      uEyeCone: u(
        new THREE.Vector4(Math.cos(EYE_ANGLE), Math.cos(EYE_ANGLE * (1 - EYE_PENUMBRA)), 1, 0),
      ),
      uEyeSpill: u(1),
      uEyeView: u(new THREE.Vector3()),
      uTarget: u(new THREE.Vector3()),
      uFocus: u(1),
      uDepthRange: u(1),
      uDepthFloor: u(DEPTH_FLOOR),
      uNearFade: u(new THREE.Vector2(0, 0)),
      uCue: u(1),
      uBackground: u(BACKGROUND_LINEAR.clone()),
      uPx: u(1),
      uViewport: u(new THREE.Vector2(1, 1)),
      uDpr: u(1),
      uNear: u(1),
      uHead: u(new THREE.Vector2(-1, 0)),
      uRead: u(new THREE.Vector3(-1, 0, 0)),
      uCage: u(CAGE_LINEAR.clone().multiplyScalar(CAGE_LEVEL)),
      uCageFar: u(new THREE.Vector2(0, 1)),
      uGlass: u(GLASS_LINEAR.clone()),
      uRim: u(RIM_LEVEL),
      uPip: u(PIP_LEVEL),
      uRimTint: u(vec3(linear(RIM))),
      uSpec: u(SPECULAR),
      uEmber: u(0),
      uCoreLit: u(CORE_LIT),
      uFilWidth: u(0),
      uFilMinPx: u(1),
      uFilGlow: u(1),
      uTubeR: u(0),
      uTubeMinPx: u(1),
      uTubeFloor: u(0),
      uPulseSpeed: u(0),
      uPulseGap: u(1),
      uPulseGain: u(PULSE_GAIN),
      uHaloR: u(0),
      uHaloGain: u(HALO_GAIN),
      uRingGain: u(RING_GAIN),
    };
    this.materials = {
      cage: cageMaterial(this.uniforms),
      crystal: crystalMaterial(this.uniforms),
      filament: filamentMaterial(this.uniforms),
      tube: tubeMaterial(this.uniforms),
      halo: haloMaterial(this.uniforms),
      ring: ringMaterial(this.uniforms),
    };
    // Cleared to the graph's own background by three's own clear: the
    // renderer's clear colour is left alone.
    this.scene.background = new THREE.Color(BACKGROUND);
  }

  get depth(): { near: number; far: number } | null {
    return this.lastDepth;
  }

  get info(): { calls: number; triangles: number } {
    return this.drawn;
  }

  /** The layout and what it costs, for the lab; null before a build. */
  get stats(): DormantStats | null {
    const b = this.built;
    if (!b) return null;
    const l = b.layout;
    return {
      lobes: l.stats.lobes,
      satellite: l.stats.satellite,
      sites: l.stats.sites,
      radius: l.radius,
      unit: l.unit,
      notes: l.positions.size,
      threads: b.chords.keys.length,
      chords: b.chords.chords,
      pieces: l.stats.pieces,
      unplaced: l.stats.unplaced,
      layoutMs: l.stats.ms,
      buildMs: b.ms,
      uploads: b.state.uploads,
      tubes: b.tubes.chordCount,
      cage: b.cageSegments,
    };
  }

  build(model: GraphModel): SpaceBuild {
    if (this.disposed) throw new Error('Dormant network: build after dispose');
    const started = performance.now();
    this.clear();
    const k = this.knobs;
    const layout = volumeLayout(model, { spacing: k.spacing, bow: k.bow, neck: k.neck });
    const { unit } = layout;
    const field = polylineThreadField({
      nodes: layout.positions,
      routes: layout.routes,
      adjacency: layout.adjacency,
      // About the grips' reach: what `nearby` is asked for.
      cell: unit,
    });
    const chords = routeChords(layout.routes);
    const ids = [...layout.positions.keys()];
    const state = new DormantState(ids, chords.keys, chords.lengths);
    const texture = (data: Float32Array, rows: number) => {
      const t = new THREE.DataTexture(data, state.width, rows, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    const nodeTexture = texture(state.nodes, state.nodeRows);
    const threadTexture = texture(state.threads, state.threadRows);

    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const notes: CrystalNote[] = ids.map((id, node) => {
      const n = byId.get(id)!;
      const region = layout.regions[layout.regionOf.get(id) ?? -1];
      const rgb = colorOf(model, n).rgb;
      // Regions read apart a little even where one vault's colour covers them all.
      const shade = 0.8 + 0.4 * hash01(region?.key ?? '');
      return {
        id,
        node,
        position: layout.positions.get(id)!,
        // Each gem turned its own way, fixed by its note.
        turn: [hash01(`${id}#x`), hash01(`${id}#y`), hash01(`${id}#z`)],
        tint: [
          toLinear(rgb[0] / 255) * shade,
          toLinear(rgb[1] / 255) * shade,
          toLinear(rgb[2] / 255) * shade,
        ],
        seed: hash01(id),
      };
    });

    const lines = cageLines(layout.cluster);
    const cage = buildCage(lines, this.materials.cage);
    const crystals = new CrystalMeshes(notes, this.materials.crystal);
    crystals.place((id) => this.kindOf(layout, id), unit, k.crystalSize);
    const filaments = new Filaments(
      chords,
      threadTints(model, chords, unit),
      this.materials.filament,
    );
    const tubes = new Tubes(chords, this.materials.tube);
    const sprites = new Sprites(notes, this.materials.halo, this.materials.ring);
    this.scene.add(
      cage,
      ...crystals.meshes,
      filaments.mesh,
      tubes.mesh,
      sprites.halos,
      sprites.rings,
    );

    this.uniforms.uNodes!.value = nodeTexture;
    this.uniforms.uThreads!.value = threadTexture;
    this.uniforms.uUnit!.value = unit;

    this.built = {
      layout,
      chords,
      state,
      nodeTexture,
      threadTexture,
      cage,
      cageSegments: lines.length / 6,
      crystals,
      filaments,
      tubes,
      sprites,
      size: k.crystalSize,
      ms: 0,
    };
    this.built.ms = performance.now() - started;

    return {
      positions: layout.positions,
      field,
      unit,
      bounds: boundsOfCluster(layout.cluster, CAGE_OUT * layout.spacing + 0.5 * unit),
      pace: PACE * unit,
      camera: { ...CAMERA },
    };
  }

  setDecisions(ids: ReadonlySet<string>): void {
    this.decisions = new Set(ids);
    const b = this.built;
    if (b) b.crystals.place((id) => this.kindOf(b.layout, id), b.layout.unit, b.size);
  }

  /** An index stays an index, whatever else it is; a decision is one when the data says so. */
  private kindOf(layout: VolumeLayout, id: string): CrystalKind {
    if (layout.kinds.get(id) === 'index') return 'index';
    return this.decisions.has(id) ? 'decision' : 'note';
  }

  render(renderer: THREE.WebGLRenderer, frame: SpaceFrame): void {
    this.drawn = { calls: 0, triangles: 0 };
    const { vp } = frame;
    if (this.disposed || !(vp.width > 0 && vp.height > 0)) {
      this.lastDepth = null;
      return;
    }
    this.aim(frame);
    const r = renderer;
    withRendererState(r, () => {
      // Count only our own draws.
      r.info.autoReset = false;
      r.info.reset();
      r.setRenderTarget(null);
      // The background clears colour, depth and stencil, with depth writes on.
      r.autoClear = true;
      r.autoClearColor = true;
      r.autoClearDepth = true;
      r.autoClearStencil = true;
      const b = this.built;
      if (b) {
        this.wake(r, b, frame);
        this.set(r, b, frame);
      }
      r.render(this.scene, this.camera);
      this.drawn = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    });
  }

  /**
   * The graph's camera, placed exactly as graph-scene.ts places it, with a far
   * plane that reaches across the whole form from wherever the camera is,
   * inside it or out.
   */
  private aim(frame: SpaceFrame): void {
    const { cam, vp } = frame;
    const { position, up } = basis(cam);
    const c = this.camera;
    c.position.set(position[0], position[1], position[2]);
    c.up.set(up[0], up[1], up[2]);
    c.lookAt(cam.tx, cam.ty, cam.tz);
    const b = this.built;
    const unit = b?.layout.unit ?? 1;
    const centre = b?.layout.centre ?? ([cam.tx, cam.ty, cam.tz] as Vec3);
    const radius = b?.layout.radius ?? 0;
    const away = Math.hypot(
      position[0] - centre[0],
      position[1] - centre[1],
      position[2] - centre[2],
    );
    const near = Math.max(0.02 * unit, cam.dist * 0.004);
    const far = Math.max(near * 10, away + radius + 2 * unit);
    const aspect = vp.width / vp.height;
    if (c.near !== near || c.far !== far || c.aspect !== aspect || c.fov !== FOV_DEG) {
      c.near = near;
      c.far = far;
      c.aspect = aspect;
      c.fov = FOV_DEG;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
    this.lastDepth = { near, far };
  }

  /** What the crawl did since the last frame, into the state textures and the tubes. */
  private wake(r: THREE.WebGLRenderer, b: Built, frame: SpaceFrame): void {
    const d = b.state.sync(frame.view);
    if (d.reset) b.tubes.clear();
    for (const t of d.opened) b.tubes.open(t);
    upload(r, b.nodeTexture, d.nodes);
    upload(r, b.threadTexture, d.threads);
  }

  /** This frame's uniforms: the clock, the camera, the eye, the fades, the knobs. */
  private set(r: THREE.WebGLRenderer, b: Built, frame: SpaceFrame): void {
    const u = this.uniforms;
    const k = this.knobs;
    const { cam, dpr } = frame;
    const unit = b.layout.unit;
    const radius = b.layout.radius;
    const clock = frame.view?.clock ?? 0;
    u.uClock!.value = clock;
    u.uTime!.value = frame.time;
    u.uStill!.value = frame.still ? 1 : 0;

    r.getDrawingBufferSize(this.buffer);
    u.uPx!.value = this.buffer.y / 2 / TAN_HALF_FOV;
    (u.uViewport!.value as THREE.Vector2).copy(this.buffer);
    u.uDpr!.value = dpr;
    u.uNear!.value = this.camera.near;
    (u.uTarget!.value as THREE.Vector3).set(cam.tx, cam.ty, cam.tz);
    u.uFocus!.value = cam.dist;

    // Whole beyond the knob's distance from the camera, gone within half of
    // it, never as far as what the camera looks at; 0 turns it off.
    const nearOut = Math.min(Math.max(0, k.nearFade) * unit, NEAR_KEEP * cam.dist);
    (u.uNearFade!.value as THREE.Vector2).set(0.5 * nearOut, nearOut);
    const cue = Math.min(1, Math.max(0, k.depthCue));
    u.uDepthRange!.value = DEPTH_RANGE * radius;
    u.uDepthFloor!.value = 1 - (1 - DEPTH_FLOOR) * cue;
    u.uCue!.value = cue;

    const eye = frame.eye;
    const cone = u.uEyeCone!.value as THREE.Vector4;
    const seen =
      !!eye &&
      Number.isFinite(eye.position[0] + eye.position[1] + eye.position[2] + eye.intensity) &&
      Math.hypot(eye.dir[0], eye.dir[1], eye.dir[2]) > 1e-9;
    if (eye && seen) {
      const pos = u.uEyePos!.value as THREE.Vector3;
      pos.set(eye.position[0], eye.position[1], eye.position[2]);
      (u.uEyeDir!.value as THREE.Vector3).set(eye.dir[0], eye.dir[1], eye.dir[2]).normalize();
      cone.z = k.eyeReach * unit;
      cone.w = (k.eyeGain * Math.max(0, eye.intensity)) / EYE_REST;
      (u.uEyeView!.value as THREE.Vector3).copy(
        this.eyeView.copy(pos).applyMatrix4(this.camera.matrixWorldInverse),
      );
    } else cone.w = 0;
    u.uEyeSpill!.value = EYE_SPILL * unit;

    const s = b.state;
    (u.uHead!.value as THREE.Vector2).set(s.head[0], s.head[1]);
    (u.uRead!.value as THREE.Vector3).set(s.read[0], s.read[1], s.read[2]);

    (u.uCage!.value as THREE.Vector3).copy(CAGE_LINEAR).multiplyScalar(CAGE_LEVEL * k.cage);
    // Whole from 1.8 radii away — every view of the whole form — and only in the eye's pool within 0.8.
    (u.uCageFar!.value as THREE.Vector2).set(0.8 * radius, 1.8 * radius);
    (u.uGlass!.value as THREE.Vector3).copy(GLASS_LINEAR).multiplyScalar(k.glass);
    u.uRim!.value = RIM_LEVEL * k.glass;
    u.uPip!.value = PIP_LEVEL * k.glass;
    u.uEmber!.value = k.ember;
    u.uFilWidth!.value = k.filamentWidth * unit;
    u.uFilMinPx!.value = FILAMENT_MIN_PX * dpr;
    u.uFilGlow!.value = k.filamentGlow;
    u.uTubeR!.value = k.tubeWidth * unit;
    u.uTubeMinPx!.value = TUBE_MIN_PX * dpr;
    u.uTubeFloor!.value = k.tubeGlow;
    u.uPulseSpeed!.value = k.pulseSpeed * unit;
    u.uPulseGap!.value = PULSE_GAP * unit;
    u.uHaloR!.value = k.halo * unit;

    if (b.size !== k.crystalSize) {
      b.size = k.crystalSize;
      b.crystals.place((id) => this.kindOf(b.layout, id), unit, b.size);
    }
    b.cage.visible = k.cage > 0 && b.cageSegments > 0;
    // Nothing found, nothing ringing: no draw for them at all.
    b.sprites.halos.visible = s.found > 0 && k.halo > 0;
    b.sprites.rings.visible = !frame.still && s.found > 0 && clock - s.lastFound < RING_SECONDS;
  }

  gui(folder: GUI): void {
    const k = this.knobs;
    const rebuild = () => this.onRebuild?.();
    folder.add(k, 'spacing', 1.2, 2.6, 0.05).name('spacing (u, rebuilds)').onFinishChange(rebuild);
    folder
      .add(k, 'neck', 1.5, 4, 0.1)
      .name('neck width (spacings, rebuilds)')
      .onFinishChange(rebuild);
    folder.add(k, 'bow', 0, 0.25, 0.01).name('thread bow (rebuilds)').onFinishChange(rebuild);
    folder.add(k, 'cage', 0, 4, 0.05).name('cage brightness');
    folder.add(k, 'crystalSize', 0.5, 2, 0.05).name('crystal size');
    folder.add(k, 'glass', 0, 4, 0.05).name('glass brightness');
    folder.add(k, 'eyeReach', 1, 12, 0.1).name('eye reach (u)');
    folder.add(k, 'eyeGain', 0, 4, 0.05).name('eye gain');
    folder.add(k, 'ember', 0, 0.6, 0.01).name('ember floor');
    folder.add(k, 'halo', 0, 3, 0.05).name('halo size (u)');
    folder.add(k, 'filamentWidth', 0.002, 0.06, 0.001).name('filament width (u)');
    folder.add(k, 'filamentGlow', 0, 4, 0.05).name('filament brightness');
    folder.add(k, 'tubeWidth', 0.01, 0.08, 0.001).name('tube radius (u)');
    folder.add(k, 'tubeGlow', 0, 2, 0.01).name('tube brightness');
    folder.add(k, 'pulseSpeed', 0, 10, 0.1).name('pulse speed (u/s)');
    folder.add(k, 'nearFade', 0, 6, 0.1).name('near fade (u)');
    folder.add(k, 'depthCue', 0, 1, 0.01).name('depth cue');
  }

  async warmup(renderer: THREE.WebGLRenderer): Promise<void> {
    if (this.disposed) throw new Error('Dormant network: warmup after dispose');
    const r = renderer;
    // Compiled for the canvas, as it draws: a render target would key other programs.
    this.compiling = withRendererState(r, () => {
      r.setRenderTarget(null);
      return r.compileAsync(this.scene, this.camera);
    });
    try {
      await this.compiling;
    } finally {
      this.compiling = null;
    }
    if (this.disposed) throw new Error('Dormant network: disposed while warming up');

    // Three checks a program for errors the first time it is used: each one
    // used once here, with the camera looking away, under our own handler.
    const failures: string[] = [];
    withRendererState(r, () => {
      const previous = r.debug.onShaderError;
      r.debug.onShaderError = (gl, _program, vertex, fragment) => {
        const logs = [gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)];
        failures.push(logs.filter((l) => l && l.trim()).join('\n') || 'link failed');
      };
      const background = this.scene.background;
      const shown = new Map<THREE.Object3D, boolean>();
      const counts = new Map<THREE.InstancedBufferGeometry, number>();
      try {
        this.scene.background = null;
        for (const o of this.scene.children) {
          shown.set(o, o.visible);
          o.visible = true;
          const g = (o as THREE.Mesh).geometry;
          if (g instanceof THREE.InstancedBufferGeometry && !counts.has(g)) {
            counts.set(g, g.instanceCount);
            g.instanceCount = Math.max(1, g.instanceCount);
          }
        }
        const away = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 1);
        away.position.set(0, 1e7, 0);
        away.lookAt(0, 2e7, 0);
        r.setRenderTarget(null);
        r.autoClear = false;
        r.render(this.scene, away);
      } finally {
        this.scene.background = background;
        for (const [o, visible] of shown) o.visible = visible;
        for (const [g, n] of counts) g.instanceCount = n;
        r.debug.onShaderError = previous;
      }
    });
    if (failures.length) throw new Error(`Dormant network shaders failed:\n${failures.join('\n')}`);
  }

  /** Frees what the last build made: its meshes' geometry and its state textures. */
  private clear(): void {
    const b = this.built;
    if (!b) return;
    this.built = null;
    this.scene.remove(
      b.cage,
      ...b.crystals.meshes,
      b.filaments.mesh,
      b.tubes.mesh,
      b.sprites.halos,
      b.sprites.rings,
    );
    b.cage.geometry.dispose();
    b.crystals.dispose();
    b.filaments.dispose();
    b.tubes.dispose();
    b.sprites.dispose();
    b.nodeTexture.dispose();
    b.threadTexture.dispose();
    this.uniforms.uNodes!.value = null;
    this.uniforms.uThreads!.value = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    const materials = Object.values(this.materials);
    // A compile still polling reads its materials' state until it settles.
    const free = () => materials.forEach((m) => m.dispose());
    if (this.compiling) this.compiling.then(free, free);
    else free();
    this.scene.clear();
    this.lastDepth = null;
  }
}

/**
 * The box round every bulb of the form — hub, lobes and satellite, each grown
 * by `pad` — so the overview frames the cage and what reaches past it. The
 * necks lie between the hub and their lobes, inside it.
 */
function boundsOfCluster(c: Cluster, pad: number): Bounds {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const bulb of [c.hub, ...c.lobes, ...(c.satellite ? [c.satellite] : [])]) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i]!, bulb.centre[i]! - bulb.radius - pad);
      hi[i] = Math.max(hi[i]!, bulb.centre[i]! + bulb.radius + pad);
    }
  }
  return {
    cx: (lo[0] + hi[0]) / 2,
    cy: (lo[1] + hi[1]) / 2,
    cz: (lo[2] + hi[2]) / 2,
    w: hi[0] - lo[0],
    h: hi[1] - lo[1],
    d: hi[2] - lo[2],
  };
}

/** Sends a state texture's changes up now, while the spans still describe them. */
function upload(r: THREE.WebGLRenderer, texture: THREE.DataTexture, up: StateUpload): void {
  if (up.full) {
    // Spans left over would make the next upload partial over storage that holds nothing yet.
    texture.clearUpdateRanges();
  } else if (up.ranges.length > 0) {
    for (let i = 0; i < up.ranges.length; i += 2)
      texture.addUpdateRange(up.ranges[i]!, up.ranges[i + 1]!);
  } else return;
  texture.needsUpdate = true;
  r.initTexture(texture);
}

/**
 * Each thread's dormant colour, linear rgb: its source note's vault colour at
 * the brightness the brain draws its kind with — 0.22 for a link, 0.08 for
 * structure — taken in the canvas's encoding as the brain writes it, then
 * brought into linear light.
 *
 * A long thread is dimmer, down to under half: the links between projects
 * cross the hub, and at full strength their chords would bury the short
 * threads that show how each project hangs together.
 */
function threadTints(model: GraphModel, chords: RouteChords, unit: number): Float32Array {
  const edges = new Map<ThreadKey, GraphEdge>();
  for (const e of model.edges) {
    if (!walkable(e)) continue;
    const key = threadKey(e.source, e.target);
    if (!edges.has(key)) edges.set(key, e);
  }
  const { keys, lengths } = chords;
  const out = new Float32Array(Math.max(1, keys.length) * 3);
  keys.forEach((key, t) => {
    const e = edges.get(key);
    if (!e) return;
    const far = THREE.MathUtils.smoothstep(lengths[t]! / unit, LONG_FROM, LONG_TO);
    const level = (e.kind === 'structure' ? LINE.structure : LINE.link) * (1 - LONG_DIM * far);
    const rgb = colorOf(model, e.source).rgb;
    out[t * 3] = toLinear((rgb[0] / 255) * level);
    out[t * 3 + 1] = toLinear((rgb[1] / 255) * level);
    out[t * 3 + 2] = toLinear((rgb[2] / 255) * level);
  });
  return out;
}
