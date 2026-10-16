// A three.js OrthographicCamera pointed exactly as `isoProject` projects, so
// the WebGL plates and blocks and the 2D overlay drawn over them agree to the
// pixel. The maths stays in math/camera.ts and three follows it, never the
// other way round: the overlay, the pointer and the tests read the pure one.

import type * as THREE from 'three';

import type { Viewport } from '@/lib/graph-camera';

import { viewDir, viewUp, type IsoCam } from '../math/camera';

/** How far back the camera sits. Orthographic: it changes what is clipped, not what shows where. */
const REACH = 500;
const NEAR = 0.1;

/**
 * Point a three OrthographicCamera exactly as isoProject projects: same screen for every
 * world point. Anything within `reach` of the target's plane, either side, is drawn. The
 * camera is taken to have no parent, or one that does not move it.
 */
export function applyIsoCamera(
  camera: THREE.OrthographicCamera,
  cam: IsoCam,
  vp: Viewport,
  reach = REACH,
): void {
  const halfW = vp.width / 2 / cam.ppu;
  const halfH = vp.height / 2 / cam.ppu;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.near = NEAR;
  camera.far = 2 * reach;
  // ppu is the zoom: three's own would scale the frustum behind isoProject's back.
  camera.zoom = 1;
  const [dx, dy, dz] = viewDir(cam);
  camera.position.set(cam.tx + dx * reach, cam.ty + dy * reach, cam.tz + dz * reach);
  camera.up.set(...viewUp(cam));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
