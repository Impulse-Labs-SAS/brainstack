// The threads the walk has gone along, as tubes of light with real thickness:
// an open hexagonal cylinder along each chord of the thread's route, so the
// trail has a body the Sentinel's talons can wrap, unlike the flat filament
// under it.
//
// Tubes are only ever added: the first time the walk (or a reach to a found
// note) goes along a thread, its chords are copied to the end of the
// instance buffers — a few hundred bytes uploaded, once — and the draw count
// grows. Going along it again changes only its texels in the state texture.
// The buffers are sized for every chord of the network at the start, since a
// thread is added at most once, so they never grow and nothing is ever
// reallocated mid-walk.
//
// What a tube shows comes from the state texture and two uniforms: drawn up
// to where the walk has got along it, hot just behind the head, cooling to a
// floor once left, with pulses running the way it was walked. A pair a reach
// lit that no thread here joins simply has no tube.

import * as THREE from 'three';

import type { RouteChords } from './chords';
import { TUBE_FS, TUBE_VS } from './shaders';

/** Sides round each tube: enough to read as round, few enough for thousands. */
const SIDES = 6;

/**
 * The tubes' material: opaque, writing depth. Near the camera a tube
 * dissolves by alpha to coverage, which at alpha 1 changes nothing.
 */
export function tubeMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-tube',
    uniforms,
    vertexShader: TUBE_VS,
    fragmentShader: TUBE_FS,
    toneMapped: false,
    alphaToCoverage: true,
  });
}

/**
 * An open cylinder of radius 1 along +y over [0, 1], its sides wound
 * counter-clockwise from outside: (x, z) round it, y along it.
 */
function cylinder(): THREE.InstancedBufferGeometry {
  const position = new Float32Array(SIDES * 2 * 3);
  for (let k = 0; k < SIDES; k++) {
    const a = (k * Math.PI * 2) / SIDES;
    position.set([Math.cos(a), 0, Math.sin(a)], k * 3);
    position.set([Math.cos(a), 1, Math.sin(a)], (SIDES + k) * 3);
  }
  const index: number[] = [];
  for (let k = 0; k < SIDES; k++) {
    const a = k;
    const b = (k + 1) % SIDES;
    index.push(a, SIDES + b, b, a, SIDES + a, SIDES + b);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setIndex(index);
  return g;
}

export class Tubes {
  readonly mesh: THREE.Mesh;
  private readonly chords: RouteChords;
  private readonly a: THREE.InstancedBufferAttribute;
  private readonly b: THREE.InstancedBufferAttribute;
  private readonly tube: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private count = 0;

  constructor(chords: RouteChords, material: THREE.ShaderMaterial) {
    this.chords = chords;
    this.capacity = chords.chords;
    const room = Math.max(1, chords.chords);
    const g = cylinder();
    const make = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(room * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.a = make(3);
    this.b = make(3);
    this.tube = make(3);
    g.setAttribute('aA', this.a);
    g.setAttribute('aB', this.b);
    g.setAttribute('aTube', this.tube);
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'dormant tubes';
  }

  /** Chords drawn so far. */
  get chordCount(): number {
    return this.count;
  }

  /** Adds thread `t`'s chords after the last: it was gone along for the first time. */
  open(t: number): void {
    const c = this.chords;
    const n = c.count[t] ?? 0;
    const first = c.first[t] ?? 0;
    if (n === 0 || this.count + n > this.capacity) return;
    const at = this.count;
    (this.a.array as Float32Array).set(c.a.subarray(first * 3, (first + n) * 3), at * 3);
    (this.b.array as Float32Array).set(c.b.subarray(first * 3, (first + n) * 3), at * 3);
    const tube = this.tube.array as Float32Array;
    for (let k = 0; k < n; k++) {
      tube[(at + k) * 3] = t;
      tube[(at + k) * 3 + 1] = c.s[(first + k) * 2]!;
      tube[(at + k) * 3 + 2] = c.s[(first + k) * 2 + 1]!;
    }
    for (const attribute of [this.a, this.b, this.tube]) {
      attribute.addUpdateRange(at * 3, n * 3);
      attribute.needsUpdate = true;
    }
    this.count += n;
    this.sync();
  }

  /** Takes every tube away: the crawl started over. Nothing to upload; the next ones write over them. */
  clear(): void {
    this.count = 0;
    for (const attribute of [this.a, this.b, this.tube]) attribute.clearUpdateRanges();
    this.sync();
  }

  private sync(): void {
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
