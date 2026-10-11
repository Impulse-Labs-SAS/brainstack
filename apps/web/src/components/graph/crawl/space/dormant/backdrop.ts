// The air behind the network: one triangle over the whole canvas, drawn
// before anything else, that paints a cool glow behind the form falling to
// near black at the screen's edges (ATMOS in shaders.ts). The opaque gems far
// off fade into the same colour, so depth reads as distance through air.
// It neither tests nor writes depth, so it hides nothing.

import * as THREE from 'three';

import { BACKDROP_FS, BACKDROP_VS } from './shaders';

export function backdropMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-backdrop',
    uniforms,
    vertexShader: BACKDROP_VS,
    fragmentShader: BACKDROP_FS,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
}

/** One triangle that covers the canvas, drawn first. */
export function buildBackdrop(material: THREE.ShaderMaterial): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'dormant backdrop';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
