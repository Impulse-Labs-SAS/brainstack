// What the Sentinel's metal reflects: a dark hangar, made in code and baked
// once into a prefiltered environment map. A bright studio (three's
// RoomEnvironment) turns dark steel into a chrome product shot; dimming it
// dims every reflection alike. Here the room is nearly black and the light
// comes from a few cold strips, so the plates read as dark metal with crisp
// highlights along their edges.
//
// The view turns the map with the camera's yaw, so the strips stay overhead
// and behind the creature as the viewer orbits: the hangar is laid out for a
// camera looking down −z, as the graph's camera does at yaw 0.
//
// Basic materials only: baking compiles nothing heavier than an unlit shader.

import * as THREE from 'three';

import { withRendererState } from './gl-state';
import { SENTINEL_LINEAR } from './palette';

/** A lit panel facing the middle of the hangar, `radiance` times its colour. */
function panel(
  scene: THREE.Scene,
  size: [number, number],
  at: [number, number, number],
  color: readonly [number, number, number],
  radiance: number,
): void {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  // Above 1 on purpose: the map is baked in half floats, and the strips are lights.
  material.color.setRGB(color[0] * radiance, color[1] * radiance, color[2] * radiance);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
  mesh.position.set(...at);
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);
}

export function buildHangar(): THREE.Scene {
  const scene = new THREE.Scene();

  // The walls: near black, a shade lighter overhead than underfoot, faintly cold.
  const radius = 30;
  const walls = new THREE.SphereGeometry(radius, 32, 16);
  const position = walls.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / radius;
    const v = t < 0 ? 0.006 + (0.002 - 0.006) * -t : 0.006 + (0.01 - 0.006) * t;
    colors.set([v * 0.92, v, v * 1.03], i * 3);
  }
  walls.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(
    new THREE.Mesh(
      walls,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }),
    ),
  );

  // Strip lights: the accent washed toward white.
  const [ar, ag, ab] = SENTINEL_LINEAR.accent;
  const strip = [0.3 * ar + 0.7, 0.3 * ag + 0.7, 0.3 * ab + 0.7] as const;
  // Two long ones overhead, a little behind the creature: the highlights along the plates' tops.
  panel(scene, [26, 1.1], [0, 13, -4], strip, 1.5);
  panel(scene, [26, 0.7], [0, 12, -10], strip, 1.25);
  // One upright behind it, off to one side: a line of light along the silhouette.
  panel(scene, [1, 14], [6, 2, -20], strip, 0.9);
  // A cold grey panel low in front: just enough to find the underside.
  panel(scene, [16, 5], [-3, -7, 15], [0.62, 0.68, 0.72], 0.25);

  return scene;
}

/** Prefilters `scene` into an environment map, leaving the renderer as it was. */
export function bakeEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  size = 256,
): THREE.WebGLRenderTarget {
  return withRendererState(renderer, () => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      return pmrem.fromScene(scene, 0, 0.1, 100, { size });
    } finally {
      pmrem.dispose();
    }
  });
}

/** Frees the geometry and materials of a scene this module built. */
export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}
