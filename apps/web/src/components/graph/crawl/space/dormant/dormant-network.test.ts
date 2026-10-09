import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { sampleVault } from '../../sample-vault';
import type { Vec3 } from '../../vec';
import type { SpaceFrame } from '../space';

import { DORMANT_NETWORK, DormantNetwork } from './dormant-network';

const vault = sampleVault(7);
const notes = vault.model.nodes.filter((n) => n.kind === 'note');

/** What the network keeps to itself, as a test reads it. */
interface Insides {
  scene: THREE.Scene;
  materials: Record<string, THREE.ShaderMaterial>;
}
const insides = (space: DormantNetwork) => space as unknown as Insides;

/** The instance count of the mesh named `name`, or 0 when it is hidden. */
function drawn(space: DormantNetwork, name: string): number {
  const mesh = insides(space).scene.children.find((o) => o.name === name) as
    | THREE.InstancedMesh
    | undefined;
  return mesh?.visible ? mesh.count : 0;
}

describe('the dormant network', () => {
  it('lays the vault out in a cluster and hands the walk a field with world up', () => {
    const space = new DormantNetwork();
    expect(space.name).toBe(DORMANT_NETWORK);
    expect(space.environment).toBeNull();
    const build = space.build(vault.model);
    expect(build.unit).toBe(10);
    expect(build.pace).toBeCloseTo(90, 9);
    expect(build.positions.size).toBe(notes.length);
    // The contract's fields, and nothing of its own besides.
    expect(Object.keys(build).sort()).toEqual([
      'bounds',
      'camera',
      'field',
      'pace',
      'positions',
      'unit',
    ]);
    // Up is the world's, wherever it is asked: the Sentinel walks it as it walks the brain.
    const up: Vec3 = [0, 0, 0];
    for (const p of [[0, 0, 0], [123, -45, 6], ...build.positions.values()] as Vec3[]) {
      build.field.up(p, up);
      expect(up).toEqual([0, 1, 0]);
    }
    // The bounds hold every note, the cage round them and a little more.
    const { cx, cy, cz, w, h, d } = build.bounds;
    for (const p of build.positions.values()) {
      expect(Math.abs(p[0] - cx)).toBeLessThanOrEqual(w / 2);
      expect(Math.abs(p[1] - cy)).toBeLessThanOrEqual(h / 2);
      expect(Math.abs(p[2] - cz)).toBeLessThanOrEqual(d / 2);
    }
    const stats = space.stats!;
    expect(stats.notes).toBe(notes.length);
    expect(stats.pieces).toBe(0);
    expect(stats.unplaced).toBe(0);
    expect(stats.sites).toBeGreaterThanOrEqual(notes.length);
    space.dispose();
  });

  it('cuts a decision crystal for each decision the data names, and keeps an index an index', () => {
    const space = new DormantNetwork();
    space.build(vault.model);
    const indexes = notes.filter((n) => n.isIndex);
    expect(indexes.length).toBeGreaterThan(0);
    expect(drawn(space, 'dormant decision crystals')).toBe(0);
    expect(drawn(space, 'dormant index crystals')).toBe(indexes.length);
    expect(drawn(space, 'dormant note crystals')).toBe(notes.length - indexes.length);

    const plain = notes.filter((n) => !n.isIndex).slice(0, 3);
    space.setDecisions(new Set([...plain.map((n) => n.id), indexes[0]!.id]));
    expect(drawn(space, 'dormant decision crystals')).toBe(3);
    expect(drawn(space, 'dormant index crystals')).toBe(indexes.length);
    expect(drawn(space, 'dormant note crystals')).toBe(notes.length - indexes.length - 3);

    // Decisions hold across a build, and can be set before one.
    space.build(vault.model);
    expect(drawn(space, 'dormant decision crystals')).toBe(3);
    const early = new DormantNetwork();
    early.setDecisions(new Set([plain[0]!.id]));
    early.build(vault.model);
    expect(drawn(early, 'dormant decision crystals')).toBe(1);
    space.dispose();
    early.dispose();
  });

  it('draws a cage over the form it laid out, as one draw that never writes depth', () => {
    const space = new DormantNetwork();
    space.build(vault.model);
    const cages = insides(space).scene.children.filter((o) => o.name === 'dormant cage');
    expect(cages).toHaveLength(1);
    const cage = cages[0] as THREE.LineSegments;
    expect(cage).toBeInstanceOf(THREE.LineSegments);
    const segments = space.stats!.cage;
    expect(segments).toBeGreaterThan(0);
    expect(cage.geometry.getAttribute('position').count).toBe(2 * segments);
    const material = cage.material as THREE.ShaderMaterial;
    expect(material.depthWrite).toBe(false);
    expect(material.blending).toBe(THREE.AdditiveBlending);
    space.dispose();
  });

  it('builds again over the same materials, freeing what the last build made', () => {
    const space = new DormantNetwork();
    space.build(vault.model);
    const { scene, materials } = insides(space);
    const before = scene.children.length;
    const geometries = new Set(
      scene.children.map((o) => (o as THREE.Mesh).geometry).filter((g) => g !== undefined),
    );
    let freed = 0;
    for (const g of geometries) g.addEventListener('dispose', () => freed++);
    const kept = Object.values(materials);
    let materialsFreed = 0;
    for (const m of kept) m.addEventListener('dispose', () => materialsFreed++);

    space.build(vault.model);
    expect(freed).toBe(geometries.size);
    expect(scene.children.length).toBe(before);
    expect(materialsFreed).toBe(0);
    expect(Object.values(insides(space).materials)).toEqual(kept);

    space.dispose();
    expect(materialsFreed).toBe(kept.length);
    expect(scene.children).toHaveLength(0);
    expect(space.depth).toBeNull();
    expect(() => space.build(vault.model)).toThrow();
  });

  it('dissolves what passes close to the camera, never what it looks at', () => {
    const space = new DormantNetwork();
    space.build(vault.model);
    const inside = space as unknown as {
      built: unknown;
      uniforms: Record<string, THREE.IUniform>;
      set(r: unknown, b: unknown, frame: SpaceFrame): void;
    };
    // All `set` asks of the renderer.
    const renderer = { getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600) };
    const fadeAt = (dist: number) => {
      const cam = { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0.3, dist };
      const frame = {
        cam,
        vp: { width: 800, height: 600 },
        dpr: 1,
        view: null,
        time: 0,
        still: false,
      };
      inside.set(renderer, inside.built, frame);
      return (inside.uniforms.uNearFade!.value as THREE.Vector2).clone();
    };
    // Following 8 creature units back: the knob's own reach, gone within 1u, whole beyond 2u.
    expect(fadeAt(80).toArray()).toEqual([10, 20]);
    // Wheeled in to 1.5u, as close as the lab goes: the note in view is still whole.
    const close = fadeAt(15);
    expect(close.y).toBeLessThan(15);
    expect(close.y).toBeGreaterThan(close.x);
    expect(close.x).toBeGreaterThan(0);
    space.dispose();
  });

  it('declares no uniform it is not handed, and hands none no shader declares', () => {
    // Three gives an undeclared uniform 0 without a word: a forgotten depth
    // range would put every crystal at the floor, a forgotten near fade would
    // change every fade. A shader compile in the browser catches neither. And
    // a uniform handed that no shader reads is one left over from a shape the
    // network no longer has.
    const space = new DormantNetwork();
    const pattern = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g;
    const materials = Object.values(insides(space).materials);
    expect(materials.length).toBeGreaterThan(0);
    const declared = new Set<string>();
    for (const m of materials) {
      for (const source of [m.vertexShader, m.fragmentShader]) {
        for (const [, name] of source.matchAll(pattern)) {
          expect(Object.keys(m.uniforms), `${m.name} declares ${name}`).toContain(name);
          declared.add(name!);
        }
      }
    }
    // One object, shared by every material.
    const handed = new Set(materials.flatMap((m) => Object.keys(m.uniforms)));
    expect([...handed].sort()).toEqual([...declared].sort());
    space.dispose();
  });
});
