// The crystals on the GPU: three instanced meshes — notes, indexes, decisions
// — over one shader material, so three draws and one program. The shapes and
// the matrix that puts each one on its note are crystals.ts; this module only
// uploads them.
//
// Which mesh a note is in depends on whether it records a decision, which the
// data says after the build (`setDecisions`). So every mesh can hold every
// note, and placing them again is a rewrite of a few buffers, never a new
// geometry or a compile. The crystal size knob takes the same path.

import * as THREE from 'three';

import type { Vec3 } from '../../vec';

import { CRYSTAL_RADIUS, crystalFrame, crystalShape, type CrystalKind } from './crystals';
import { CRYSTAL_FS, CRYSTAL_VS } from './shaders';

const KINDS: readonly CrystalKind[] = ['note', 'index', 'decision'];

/** One note's crystal, as the meshes need it. */
export interface CrystalNote {
  id: string;
  /** Its index in the state textures. */
  node: number;
  /** Where its light sits: the note. */
  position: Vec3;
  /** Three numbers in [0, 1), fixed per note: which way the gem is turned. */
  turn: readonly [number, number, number];
  /** Its project's tint, linear. */
  tint: readonly [number, number, number];
  /** A fixed number in [0, 1): its breathing's phase and its height. */
  seed: number;
}

/**
 * The crystals' material: one program for all three meshes. Opaque, writing
 * depth; the near fade dissolves a gem by alpha to coverage, which at alpha 1
 * changes nothing.
 */
export function crystalMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-crystal',
    uniforms,
    vertexShader: CRYSTAL_VS,
    fragmentShader: CRYSTAL_FS,
    toneMapped: false,
    alphaToCoverage: true,
  });
}

/** A kind's shape as geometry, with room for `capacity` instances. */
function kindGeometry(kind: CrystalKind, capacity: number): THREE.BufferGeometry {
  const s = crystalShape(kind);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
  g.setAttribute('aEdge', new THREE.BufferAttribute(s.edges, 3));
  const shape = new Float32Array(s.triangles * 9);
  for (let v = 0; v < s.triangles * 3; v++) shape.set([s.coreY, s.coreR, s.bottom], v * 3);
  g.setAttribute('aShape', new THREE.BufferAttribute(shape, 3));
  g.setAttribute('aNode', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
  g.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  return g;
}

/** How much taller or shorter than its kind a crystal stands: a little scatter. */
const STRETCH = 0.2;

export class CrystalMeshes {
  /** Notes, indexes and decisions, in that order: what the scene draws. */
  readonly meshes: readonly THREE.InstancedMesh[];
  private readonly byKind: Record<CrystalKind, THREE.InstancedMesh>;
  /** Each kind's inner light, local y: the point put on the note. */
  private readonly cores: Record<CrystalKind, number>;
  private readonly notes: readonly CrystalNote[];

  constructor(notes: readonly CrystalNote[], material: THREE.ShaderMaterial) {
    this.notes = notes;
    const capacity = Math.max(1, notes.length);
    const make = (kind: CrystalKind) => {
      const mesh = new THREE.InstancedMesh(kindGeometry(kind, capacity), material, capacity);
      mesh.count = 0;
      mesh.visible = false;
      // Three bounds an instanced mesh once; the crystals cover the cluster, never off screen all at once.
      mesh.frustumCulled = false;
      mesh.name = `dormant ${kind} crystals`;
      return mesh;
    };
    this.byKind = { note: make('note'), index: make('index'), decision: make('decision') };
    this.meshes = KINDS.map((k) => this.byKind[k]);
    this.cores = {
      note: crystalShape('note').coreY,
      index: crystalShape('index').coreY,
      decision: crystalShape('decision').coreY,
    };
  }

  /**
   * Puts every note in its kind's mesh, `size` times its kind's footprint,
   * with `unit` world units a creature unit.
   */
  place(kindOf: (id: string) => CrystalKind, unit: number, size: number): void {
    const counts: Record<CrystalKind, number> = { note: 0, index: 0, decision: 0 };
    for (const n of this.notes) {
      const kind = kindOf(n.id);
      const mesh = this.byKind[kind];
      const i = counts[kind]++;
      crystalFrame(
        {
          position: n.position,
          turn: n.turn,
          radius: CRYSTAL_RADIUS[kind] * unit * size,
          stretch: 1 - STRETCH / 2 + STRETCH * n.seed,
          core: this.cores[kind],
        },
        mesh.instanceMatrix.array as Float32Array,
        i * 16,
      );
      const node = mesh.geometry.getAttribute('aNode') as THREE.InstancedBufferAttribute;
      (node.array as Float32Array)[i] = n.node;
      const look = mesh.geometry.getAttribute('aLook') as THREE.InstancedBufferAttribute;
      (look.array as Float32Array).set([n.tint[0], n.tint[1], n.tint[2], n.seed], i * 4);
    }
    for (const kind of KINDS) {
      const mesh = this.byKind[kind];
      const count = counts[kind];
      mesh.count = count;
      mesh.visible = count > 0;
      if (count === 0) continue;
      const attributes: [THREE.BufferAttribute, number][] = [
        [mesh.instanceMatrix, 16],
        [mesh.geometry.getAttribute('aNode') as THREE.BufferAttribute, 1],
        [mesh.geometry.getAttribute('aLook') as THREE.BufferAttribute, 4],
      ];
      for (const [a, size] of attributes) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, count * size);
        a.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}
