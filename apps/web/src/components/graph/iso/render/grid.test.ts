import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LINE_ART_COLORS, lineArtRgb } from '@/lib/graph-theme';

import { shaderProblems } from './glsl-check';
import { GRID_MARGIN, GroundGrid, dotPx, gridSpacing } from './grid';

const uniform = (grid: GroundGrid, name: string) => grid.mesh.material.uniforms[name]!.value;

describe('gridSpacing', () => {
  it('starts at 2 units and doubles until the dots stand 9 CSS pixels apart', () => {
    expect(gridSpacing(56)).toBe(2);
    expect(gridSpacing(4.5)).toBe(2); // exactly 9 px: enough
    expect(gridSpacing(4.4)).toBe(4);
    expect(gridSpacing(2.25)).toBe(4);
    expect(gridSpacing(2.2)).toBe(8);
    expect(gridSpacing(1)).toBe(16);
    for (const ppu of [0.05, 0.3, 1.7, 3, 9, 20, 41]) {
      const s = gridSpacing(ppu);
      expect(s * ppu, `ppu ${ppu}`).toBeGreaterThanOrEqual(9);
      // The finest such: half of it would crowd.
      if (s > 2) expect((s / 2) * ppu, `ppu ${ppu}`).toBeLessThan(9);
    }
  });

  it('does not hang on a scale that is no scale', () => {
    expect(Number.isFinite(gridSpacing(0))).toBe(true);
    expect(Number.isFinite(gridSpacing(Number.NaN))).toBe(true);
  });

  it('grows the dots a touch once cells are big', () => {
    expect(dotPx(19.9)).toBe(1.2);
    expect(dotPx(20)).toBe(1.6);
  });
});

describe('GroundGrid', () => {
  it('covers the bounds and a margin of 4 on every side, flat on the ground', () => {
    const grid = new GroundGrid(LINE_ART_COLORS);
    grid.setBounds(-5, 2, 31, 12);
    grid.mesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(grid.mesh);
    expect(box.min.x).toBeCloseTo(-5 - GRID_MARGIN, 6);
    expect(box.max.x).toBeCloseTo(31 + GRID_MARGIN, 6);
    expect(box.min.y).toBeCloseTo(2 - GRID_MARGIN, 6);
    expect(box.max.y).toBeCloseTo(12 + GRID_MARGIN, 6);
    expect(box.min.z).toBe(0);
    expect(box.max.z).toBe(0);
    // Facing up, toward any camera above the ground.
    const normal = new THREE.Vector3()
      .fromBufferAttribute(grid.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute, 0)
      .transformDirection(grid.mesh.matrixWorld);
    expect(normal.z).toBeCloseTo(1, 6);

    // Given the wrong way round, the same ground.
    grid.setBounds(31, 12, -5, 2);
    grid.mesh.updateMatrixWorld();
    const again = new THREE.Box3().setFromObject(grid.mesh);
    expect(again.min.toArray()).toEqual(box.min.toArray());
    expect(again.max.toArray()).toEqual(box.max.toArray());
    grid.dispose();
  });

  it('sets the spacing, the dot size and the pixel ratio from the scale', () => {
    const grid = new GroundGrid(LINE_ART_COLORS);
    grid.setScale(3, 2);
    expect(uniform(grid, 'uSpacing')).toBe(4);
    expect(uniform(grid, 'uDotPx')).toBe(1.2);
    expect(uniform(grid, 'uDpr')).toBe(2);
    grid.setScale(24, 1);
    expect(uniform(grid, 'uSpacing')).toBe(2);
    expect(uniform(grid, 'uDotPx')).toBe(1.6);
    grid.dispose();
  });

  it('takes the theme, hides and shows, and draws under the boxes without hiding them', () => {
    const grid = new GroundGrid(LINE_ART_COLORS);
    expect(uniform(grid, 'uColor').toArray()).toEqual(lineArtRgb(LINE_ART_COLORS.grid));
    grid.setTheme({ ...LINE_ART_COLORS, grid: '#336699' });
    expect(uniform(grid, 'uColor').toArray()).toEqual(lineArtRgb('#336699'));
    grid.setVisible(false);
    expect(grid.mesh.visible).toBe(false);
    grid.setVisible(true);
    expect(grid.mesh.visible).toBe(true);
    const m = grid.mesh.material;
    expect(m.transparent).toBe(true);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(grid.mesh.renderOrder).toBeLessThan(0);
    grid.dispose();
  });

  it('has shaders that declare what the code sets', () => {
    const grid = new GroundGrid(LINE_ART_COLORS);
    expect(shaderProblems(grid.mesh.material, grid.mesh.geometry)).toEqual([]);
    grid.dispose();
  });
});
