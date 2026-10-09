// The light found notes give off: a soft halo facing the camera, in the colour
// of why the note was found, so a find reads from across the cluster; and,
// the moment it ignites, a ring that runs out round the note, facing the
// camera, and fades. Both are added light — depth-tested, so a gem in front
// hides them, never writing depth — and work without any bloom.
//
// Every note has a quad in both, laid out once at the build; a note not found
// yet, or a ring already run out, collapses to nothing in the vertex shader.
// A few thousand empty quads cost less than keeping a list in step with the
// crawl, and nothing is uploaded as notes are found: the state texture says
// which they are, and since when.

import * as THREE from 'three';

import type { Vec3 } from '../../vec';

import { HALO_FS, HALO_VS, RING_FS, RING_VS } from './shaders';

/** Added light, tested against the depth the rest wrote, never writing it. */
function added(
  name: string,
  uniforms: Record<string, THREE.IUniform>,
  vertexShader: string,
  fragmentShader: string,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader,
    fragmentShader,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function haloMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return added('brainstack-dormant-halo', uniforms, HALO_VS, HALO_FS);
}

export function ringMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return added('brainstack-dormant-ring', uniforms, RING_VS, RING_FS);
}

/** One note's place in the sprites. */
export interface SpriteNote {
  /** Its index in the state textures. */
  node: number;
  position: Vec3;
  /** In [0, 1): its breathing's phase, shared with its crystal. */
  seed: number;
}

export class Sprites {
  readonly halos: THREE.Mesh;
  readonly rings: THREE.Mesh;

  constructor(
    notes: readonly SpriteNote[],
    halo: THREE.ShaderMaterial,
    ring: THREE.ShaderMaterial,
  ) {
    const n = notes.length;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(Math.max(1, n) * 3);
    const node = new Float32Array(Math.max(1, n));
    const seed = new Float32Array(Math.max(1, n));
    notes.forEach((s, i) => {
      pos.set(s.position, i * 3);
      node[i] = s.node;
      seed[i] = s.seed;
    });
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('aNode', new THREE.InstancedBufferAttribute(node, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    g.instanceCount = n;
    const mesh = (material: THREE.ShaderMaterial, name: string) => {
      const m = new THREE.Mesh(g, material);
      m.frustumCulled = false;
      m.visible = n > 0;
      m.name = name;
      return m;
    };
    this.halos = mesh(halo, 'dormant halos');
    this.rings = mesh(ring, 'dormant rings');
  }

  dispose(): void {
    // One geometry, both meshes.
    this.halos.geometry.dispose();
  }
}
