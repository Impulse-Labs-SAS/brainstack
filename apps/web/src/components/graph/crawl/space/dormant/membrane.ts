// The form's membrane: one soft shell round each bulb of the cluster — hub,
// lobes and satellite — lit only where its surface turns away from the
// camera, so it reads as a contour of light round what it holds, never as a
// wall. It replaced a wire cage of straight hairlines that read as two flat
// polygons and drew every bulb in the same grey.
//
// Each shell takes the colour of the notes inside it, washed out, so a lobe
// says what it holds before a single note is read. One instanced draw, added
// light, never writing depth, so it never hides anything; seen from inside a
// bulb its front faces are culled and it is gone, so a chase through the hub
// sees no wall. Close up it shows only where the eye looks (MEMBRANE_FS).

import * as THREE from 'three';

import type { Vec3 } from '../../vec';
import { CAGE_OUT, type Bulb, type Cluster } from '../volume/cluster';

import { MEMBRANE_FS, MEMBRANE_VS } from './shaders';

/** How finely a shell is cut: its contour stays round at any size on screen. */
const DETAIL = 5;
/** How much of a bulb's colour is kept against grey: enough to tell lobes apart, never a saturated wall. */
const SATURATION = 0.65;
/** A bulb nothing is in: a cool grey. */
const EMPTY: Vec3 = [0.55, 0.62, 0.66];

/** The membrane's material: added light, depth-tested, never writing depth. */
export function membraneMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-membrane',
    uniforms,
    vertexShader: MEMBRANE_VS,
    fragmentShader: MEMBRANE_FS,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Every bulb of the cluster, hub first. */
export function bulbsOf(c: Cluster): Bulb[] {
  return [c.hub, ...c.lobes, ...(c.satellite ? [c.satellite] : [])];
}

/**
 * Each bulb's colour, linear: the mean of the tints of the notes inside it,
 * brought to full brightness and washed towards grey. Pure.
 */
export function bulbTints(
  bulbs: readonly Bulb[],
  notes: ReadonlyArray<{ position: Vec3; tint: readonly [number, number, number] }>,
): Vec3[] {
  return bulbs.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (const note of notes) {
      const dx = note.position[0] - b.centre[0];
      const dy = note.position[1] - b.centre[1];
      const dz = note.position[2] - b.centre[2];
      if (dx * dx + dy * dy + dz * dz > b.radius * b.radius) continue;
      r += note.tint[0];
      g += note.tint[1];
      bl += note.tint[2];
      n++;
    }
    if (n === 0) return [...EMPTY];
    const peak = Math.max(r, g, bl, 1e-9);
    const grey = (r + g + bl) / (3 * peak);
    return [r / peak, g / peak, bl / peak].map((c) => grey + (c - grey) * SATURATION) as Vec3;
  });
}

/** The membrane as one instanced draw: a shell per bulb, `CAGE_OUT` spacings outside it. */
export function buildMembrane(
  cluster: Cluster,
  tints: readonly Vec3[],
  material: THREE.ShaderMaterial,
): THREE.InstancedMesh {
  const bulbs = bulbsOf(cluster);
  const geometry = new THREE.IcosahedronGeometry(1, DETAIL);
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, bulbs.length));
  const m = new THREE.Matrix4();
  const colour = new THREE.Color();
  bulbs.forEach((b, i) => {
    const r = b.radius + CAGE_OUT * cluster.spacing;
    m.makeScale(r, r, r).setPosition(b.centre[0], b.centre[1], b.centre[2]);
    mesh.setMatrixAt(i, m);
    const t = tints[i] ?? EMPTY;
    mesh.setColorAt(i, colour.setRGB(t[0], t[1], t[2], THREE.LinearSRGBColorSpace));
  });
  mesh.count = bulbs.length;
  mesh.name = 'dormant membrane';
  // It spans the whole cluster: never off screen all at once.
  mesh.frustumCulled = false;
  mesh.visible = bulbs.length > 0;
  return mesh;
}
