import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { FOV_DEG } from '@/lib/graph-camera';

import { createPose } from './pose';
import { creatureBounds, creatureDepthRange, sharesPrograms } from './view';

const ASPECT = 16 / 9;

function camera(
  at: THREE.Vector3,
  target: THREE.Vector3,
  near: number,
  far: number,
): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(FOV_DEG, ASPECT, near, far);
  c.position.copy(at);
  c.lookAt(target);
  c.updateMatrixWorld();
  return c;
}

/** Where a point lands in a camera's depth buffer, before the viewport: its NDC depth. */
function ndcDepth(c: THREE.PerspectiveCamera, point: THREE.Vector3): number {
  return point.clone().project(c).z;
}

describe('creatureDepthRange', () => {
  // The space writes depth with its camera; the Sentinel tests against it with its own.
  it('puts every point at the depth the space wrote for it', () => {
    const anchor = new THREE.Vector3(12, -3, 40);
    const eye = new THREE.Vector3(5, 20, 90);
    const target = new THREE.Vector3(12, 0, 30);
    const range = { near: 0.5, far: 900 };
    const points = [
      new THREE.Vector3(12, -3, 40),
      new THREE.Vector3(6, 18, 85),
      new THREE.Vector3(-200, 50, -400),
      new THREE.Vector3(30, -10, 10),
    ];
    const world = camera(eye, target, range.near, range.far);
    for (const unit of [0.05, 1, 37]) {
      const shared = creatureDepthRange(range, unit);
      expect(shared).not.toBeNull();
      const toCreature = (p: THREE.Vector3) => p.clone().sub(anchor).divideScalar(unit);
      const creature = camera(toCreature(eye), toCreature(target), shared!.near, shared!.far);
      for (const p of points) {
        const z = ndcDepth(world, p);
        expect(Math.abs(z)).toBeLessThan(1);
        expect(ndcDepth(creature, toCreature(p))).toBeCloseTo(z, 9);
      }
    }
  });

  it('shares nothing when there is no range the space could have drawn with', () => {
    expect(creatureDepthRange(null, 1)).toBeNull();
    expect(creatureDepthRange(undefined, 1)).toBeNull();
    expect(creatureDepthRange({ near: 0, far: 10 }, 1)).toBeNull();
    expect(creatureDepthRange({ near: 5, far: 5 }, 1)).toBeNull();
    expect(creatureDepthRange({ near: 1, far: Infinity }, 1)).toBeNull();
    expect(creatureDepthRange({ near: Number.NaN, far: 10 }, 1)).toBeNull();
    expect(creatureDepthRange({ near: 1, far: 10 }, 0)).toBeNull();
    expect(creatureDepthRange({ near: 1, far: 10 }, -2)).toBeNull();
  });

  it('divides the planes by the unit', () => {
    expect(creatureDepthRange({ near: 2, far: 600 }, 4)).toEqual({ near: 0.5, far: 150 });
  });
});

describe('creatureBounds', () => {
  it('moves the pose’s sphere back out of creature space, never smaller than the hull', () => {
    const pose = createPose();
    pose.anchor = [10, -4, 2];
    pose.unit = 3;
    pose.bounds.set([1, 0, -2, 2.5]);
    expect(creatureBounds(pose)).toEqual({ centre: [13, -4, -4], radius: 7.5 });
    // A sphere that claims less than the hull reaches: the hull's, as the view culls it.
    pose.bounds.set([0, 0, 0, 0.1]);
    expect(creatureBounds(pose)!.radius).toBeCloseTo(0.55 * 3, 9);
  });

  it('is null for a pose with no place', () => {
    const pose = createPose();
    pose.unit = 0;
    expect(creatureBounds(pose)).toBeNull();
    pose.unit = 1;
    pose.anchor = [Number.NaN, 0, 0];
    expect(creatureBounds(pose)).toBeNull();
  });
});

/** What PMREMGenerator hands back, as far as three's program key reads it. */
function pmrem(size: number): THREE.Texture {
  const t = new THREE.Texture();
  t.image = { width: 3 * Math.max(size, 16 * 7), height: 4 * size, depth: 1 };
  t.mapping = THREE.CubeUVReflectionMapping;
  return t;
}

describe('sharesPrograms', () => {
  it('lets two PMREMs of one size share every program', () => {
    expect(sharesPrograms(pmrem(256), pmrem(256))).toBe(true);
  });

  it('tells a PMREM of another size apart', () => {
    expect(sharesPrograms(pmrem(256), pmrem(128))).toBe(false);
  });

  it('tells a map three would still have to convert apart', () => {
    const equirect = new THREE.Texture();
    equirect.image = { width: 1024, height: 1024 };
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    expect(sharesPrograms(equirect, pmrem(256))).toBe(false);
    expect(sharesPrograms(pmrem(256), equirect)).toBe(false);
  });
});
