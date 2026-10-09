// The form's cage on the GPU: the line segments volume/cage.ts lays over the
// cluster's hub, lobes, necks and satellite, as one draw. It is how the dark
// form reads from afar — dark glass in a dark room is otherwise nothing — so
// it is drawn as GL lines, added, and very faint.
//
// Close up its long straight edges would be taken for threads, so it is gated
// as the eye gates the network: whole only from afar, where it is the form's
// outline, and close up only where the eye's pool falls, and then never
// brighter than a third of a dormant link (CAGE_FS). It never writes depth,
// so it never hides anything, and the depth it is tested against keeps it
// behind every gem and thread in front of it.

import * as THREE from 'three';

import { CAGE_FS, CAGE_VS } from './shaders';

/** The cage's material: added light, depth-tested, never writing depth, so it never hides anything. */
export function cageMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-cage',
    uniforms,
    vertexShader: CAGE_VS,
    fragmentShader: CAGE_FS,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** The cage as one LineSegments draw: `lines` from volume/cage.ts, xyz xyz per segment, world units. */
export function buildCage(lines: Float32Array, material: THREE.ShaderMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(lines, 3));
  const cage = new THREE.LineSegments(g, material);
  cage.name = 'dormant cage';
  // It spans the whole cluster: never off screen all at once.
  cage.frustumCulled = false;
  cage.matrixAutoUpdate = false;
  cage.visible = lines.length >= 6;
  return cage;
}
