import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LINE_ART_COLORS, lineArtRgb } from '@/lib/graph-theme';

import { shaderProblems } from './glsl-check';
import { DOT_PX, FOOT_RAISE, LiftMarks, MIN_LIFT, SEGMENTS_PER_MARK, type LiftMark } from './marks';

const mark = (o: Partial<LiftMark> = {}): LiftMark => ({
  x0: 2,
  y0: 5,
  x1: 2.62,
  y1: 5.62,
  base: 0.6,
  lifted: 1.15,
  color: 'accent',
  ...o,
});

const attr = (m: LiftMarks, name: string) =>
  m.object.geometry.getAttribute(name) as THREE.BufferAttribute;

type Point = [number, number, number];

/** The segments drawn, each as its two ends. */
function segments(m: LiftMarks): [Point, Point][] {
  const p = attr(m, 'position');
  const out: [Point, Point][] = [];
  for (let v = 0; v < m.object.geometry.drawRange.count; v += 2) {
    out.push([
      [p.getX(v), p.getY(v), p.getZ(v)],
      [p.getX(v + 1), p.getY(v + 1), p.getZ(v + 1)],
    ]);
  }
  return out;
}

const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-5);

describe('LiftMarks', () => {
  it('draws four verticals from the corners down to the plate, and the footprint there', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    m.set([mark()], 40);
    expect(m.object.visible).toBe(true);
    const segs = segments(m);
    expect(segs).toHaveLength(SEGMENTS_PER_MARK);
    const foot = 0.6 + FOOT_RAISE;
    const corners = [
      [2, 5],
      [2.62, 5],
      [2.62, 5.62],
      [2, 5.62],
    ];
    const verticals = segs.slice(0, 4);
    const sides = segs.slice(4);
    corners.forEach(([x, y], k) => {
      // Down from the block's bottom corner…
      expect(close(verticals[k]![0], [x!, y!, 1.15]), `vertical ${k} top`).toBe(true);
      expect(close(verticals[k]![1], [x!, y!, foot]), `vertical ${k} foot`).toBe(true);
      // …and round the footprint, corner to corner, just above the plate.
      const [nx, ny] = corners[(k + 1) % 4]!;
      expect(close(sides[k]![0], [x!, y!, foot]), `side ${k} start`).toBe(true);
      expect(close(sides[k]![1], [nx!, ny!, foot]), `side ${k} end`).toBe(true);
    });
    // Each line measured from its own start, for the dots.
    const dist = attr(m, 'aDist');
    expect(dist.getX(0)).toBe(0);
    expect(dist.getX(1)).toBeCloseTo(1.15 - foot, 5);
    expect(dist.getX(8)).toBe(0);
    expect(dist.getX(9)).toBeCloseTo(0.62, 5);
    m.dispose();
  });

  it('leaves out a block that has not left its plate, and hides when nothing is lifted', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    m.set([mark({ lifted: 0.6 + MIN_LIFT / 2 }), mark({ x0: 10, x1: 10.62 })], 40);
    expect(segments(m)).toHaveLength(SEGMENTS_PER_MARK);
    expect(segments(m)[0]![0][0]).toBeCloseTo(10, 6);
    m.set([], 40);
    expect(m.object.geometry.drawRange.count).toBe(0);
    expect(m.object.visible).toBe(false);
    m.dispose();
  });

  it('grows for many marks, colouring each by what lifted it', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    const many = Array.from({ length: 11 }, (_, i) =>
      mark({ x0: i, x1: i + 0.62, color: i % 2 ? 'hover' : 'accent' }),
    );
    m.set(many, 40);
    expect(segments(m)).toHaveLength(11 * SEGMENTS_PER_MARK);
    const hover = attr(m, 'aHover');
    for (let i = 0; i < 11; i++) {
      for (let v = 0; v < SEGMENTS_PER_MARK * 2; v++) {
        expect(hover.getX(i * SEGMENTS_PER_MARK * 2 + v)).toBe(i % 2);
      }
    }
    expect(segments(m)[10 * SEGMENTS_PER_MARK]![0][0]).toBeCloseTo(10, 6);
    m.dispose();
  });

  it('turns its pixel rhythm into world units by the scale', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    m.set([mark()], 25);
    const u = m.object.material.uniforms;
    expect(u.uDash!.value).toBeCloseTo(DOT_PX.on / 25, 9);
    expect(u.uGap!.value).toBeCloseTo(DOT_PX.off / 25, 9);
    m.dispose();
  });

  it('takes the accent and the hover edge from the theme', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    const u = m.object.material.uniforms;
    expect(u.uAccent!.value.toArray()).toEqual(lineArtRgb(LINE_ART_COLORS.accent));
    expect(u.uHover!.value.toArray()).toEqual(lineArtRgb(LINE_ART_COLORS.hoverEdge));
    m.setTheme({ ...LINE_ART_COLORS, accent: '#00ff00' });
    expect(u.uAccent!.value.toArray()).toEqual([0, 1, 0]);
    m.dispose();
  });

  it('is depth-tested after the boxes, and its shaders declare what the code sets', () => {
    const m = new LiftMarks(LINE_ART_COLORS);
    expect(m.object.material.depthTest).toBe(true);
    expect(m.object.renderOrder).toBeGreaterThan(0);
    expect(m.object.frustumCulled).toBe(false);
    expect(shaderProblems(m.object.material, m.object.geometry)).toEqual([]);
    m.dispose();
  });
});
