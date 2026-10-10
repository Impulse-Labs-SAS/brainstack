// Every thread of the dormant network, faint: one instanced ribbon per chord
// of every route, a single draw. The ribbons are cut from the very route
// arrays the replay's ThreadField walks (chords.ts), so the Sentinel's claws
// close exactly on the line drawn.
//
// A ribbon is widened on screen, as three's fat lines are: its true width up
// close, never under a pixel from afar, so a dormant thread neither vanishes
// nor shimmers. It is opaque and writes depth — a claw that closes round one
// goes behind it where it should — and its edges are anti-aliased by alpha to
// coverage on the multisampled canvas, which needs no sorting. The same
// coverage dissolves it where it passes close to the camera.
//
// Its brightness is the brain's own lines' (links at 0.22 of the vault's
// colour, structure at 0.08), so the dormant network reads as the graph the
// other views draw, only asleep. A thread a grip closes on flashes and goes
// out again — a little all along it, brightly round the claw, since the
// threads a claw reaches for are often long ones crossing the hub, and a
// dozen of those lit whole at once would drown the trail. The eye's pool
// brightens what it falls on.

import * as THREE from 'three';

import type { RouteChords } from './chords';
import { FILAMENT_FS, FILAMENT_VS } from './shaders';

/** The filaments' material: opaque, depth-writing, edges by alpha to coverage. */
export function filamentMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'brainstack-dormant-filament',
    uniforms,
    vertexShader: FILAMENT_VS,
    fragmentShader: FILAMENT_FS,
    toneMapped: false,
    // The quad is widened square to the chord on screen, always counter-clockwise: it always faces the camera.
    alphaToCoverage: true,
  });
}

/** A quad along a chord: x from its start (0) to its end (1), y across it. */
function ribbon(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class Filaments {
  readonly mesh: THREE.Mesh;

  /** `tints`: each thread's colour, linear rgb, its brightness as the brain draws it already in. */
  constructor(chords: RouteChords, tints: Float32Array, material: THREE.ShaderMaterial) {
    const g = ribbon();
    const n = chords.chords;
    const tint = new Float32Array(Math.max(1, n) * 3);
    for (let c = 0; c < n; c++) {
      const t = chords.thread[c]!;
      tint[c * 3] = tints[t * 3]!;
      tint[c * 3 + 1] = tints[t * 3 + 1]!;
      tint[c * 3 + 2] = tints[t * 3 + 2]!;
    }
    // An empty network still needs one instance's worth of buffer; it draws none.
    const sized = (a: Float32Array, size: number) => (a.length > 0 ? a : new Float32Array(size));
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(sized(chords.a, 3), 3));
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(sized(chords.b, 3), 3));
    g.setAttribute('aThread', new THREE.InstancedBufferAttribute(sized(chords.thread, 1), 1));
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(sized(chords.s, 2), 2));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    g.instanceCount = n;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = n > 0;
    this.mesh.name = 'dormant filaments';
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
