// The Sentinel's wear, baked once on the CPU into two small tiling textures:
// grain, machining scratches and pitting. A texture rather than shader noise
// because a texture has mipmaps — noise evaluated per pixel shimmers on the
// thin tentacles at follow distance — and because it costs one fetch, not a
// few hundred instructions on every fragment.
//
// Channels follow three.js's packed occlusion-roughness-metalness layout, so
// one texture serves as aoMap, roughnessMap and metalnessMap:
//   R  cavity, read as ambient occlusion (pits and scratches darken)
//   G  roughness multiplier, averaging WEAR_ROUGHNESS_MEAN
//   B  metalness multiplier (oxide in the pits is less metal)
//   A  wear mask: where edges show bare metal first
// The normal texture is tangent space, +z out, from the same height field.
//
// Pure and deterministic: the same size and seed give the same bytes. Every
// feature wraps around the edges, so the textures tile without a seam.

import { seededRandom } from '@/lib/graph-brain';

/** The roughness channel's mean: the shader divides by it, so worn metal keeps its part's roughness on average. */
export const WEAR_ROUGHNESS_MEAN = 0.8;

export interface WearMaps {
  /** RGBA8, `size` × `size`, rows from v = 0. */
  orm: Uint8Array;
  /** RGBA8 tangent-space normals. */
  normal: Uint8Array;
}

/**
 * Adds `weight` × value noise on a lattice of `period` cells, wrapping at the
 * texture's edges, into `out`. The lattice cell and blend weight of every
 * column and row are worked out once, so the inner loop is a few reads.
 */
function addNoise(
  out: Float32Array,
  size: number,
  period: number,
  weight: number,
  rnd: () => number,
): void {
  const values = new Float32Array(period * period);
  for (let i = 0; i < values.length; i++) values[i] = rnd();
  const lo = new Int32Array(size);
  const hi = new Int32Array(size);
  const f = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const p = ((x + 0.5) / size) * period;
    const i = Math.floor(p);
    const t = p - i;
    lo[x] = i % period;
    hi[x] = (i + 1) % period;
    // Quintic fade: no visible lattice in the gradient the normal map is taken from.
    f[x] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  for (let y = 0; y < size; y++) {
    const r0 = lo[y]! * period;
    const r1 = hi[y]! * period;
    const fy = f[y]!;
    for (let x = 0; x < size; x++) {
      const c0 = lo[x]!;
      const c1 = hi[x]!;
      const fx = f[x]!;
      const a = values[r0 + c0]! + (values[r0 + c1]! - values[r0 + c0]!) * fx;
      const b = values[r1 + c0]! + (values[r1 + c1]! - values[r1 + c0]!) * fx;
      const k = y * size + x;
      out[k] = out[k]! + (a + (b - a) * fy) * weight;
    }
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const byte = (x: number) => Math.round(clamp01(x) * 255);

export function bakeWear(size: number, seed: number): WearMaps {
  const rnd = seededRandom(seed ^ 0x5e57);
  const n = size * size;
  const wrap = (i: number) => ((i % size) + size) % size;

  // Grain, in four octaves, a finer one for the height alone, and a broad
  // mottling for grime and wear.
  const grain = new Float32Array(n);
  const micro = new Float32Array(n);
  const mottle = new Float32Array(n);
  [4, 8, 16, 32].forEach((period, o) =>
    addNoise(grain, size, period, 0.5 ** (o + 1) / 0.9375, rnd),
  );
  addNoise(micro, size, 64, 1, rnd);
  addNoise(mottle, size, 3, 1, rnd);

  // Pits: small round cavities, deepest at the centre.
  const pit = new Float32Array(n);
  const pits = Math.round(n / 900);
  for (let p = 0; p < pits; p++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const r = 0.6 + rnd() * 1.6;
    const depth = 0.5 + rnd() * 0.5;
    const reach = Math.ceil(r);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const px = Math.floor(cx) + dx;
        const py = Math.floor(cy) + dy;
        const ex = px + 0.5 - cx;
        const ey = py + 0.5 - cy;
        const d = Math.sqrt(ex * ex + ey * ey) / r;
        if (d >= 1) continue;
        const k = wrap(py) * size + wrap(px);
        const s = (1 - d * d) * (1 - d * d) * depth;
        if (s > pit[k]!) pit[k] = s;
      }
    }
  }

  // Machining scratches: mostly along one direction, a few across it, as a
  // lathe or a mill leaves them.
  const scratch = new Float32Array(n);
  const scratches = Math.round(n / 300);
  for (let s = 0; s < scratches; s++) {
    const cross = rnd() < 0.18;
    const angle = (cross ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.5;
    const length = 8 + rnd() * rnd() * 60;
    const depth = 0.3 + rnd() * 0.7;
    const cx = rnd() * size;
    const cy = rnd() * size;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let t = -length / 2; t <= length / 2; t += 0.5) {
      // Shallower toward the ends, where the tool lifted.
      const e = (2 * t) / length;
      const along = 1 - e * e * e * e;
      const px = cx + dx * t;
      const py = cy + dy * t;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const qx = ix + ox;
          const qy = iy + oy;
          // Distance across the scratch, which is about a texel wide.
          const across = Math.abs((qx + 0.5 - px) * -dy + (qy + 0.5 - py) * dx);
          if (across >= 0.9) continue;
          const k = wrap(qy) * size + wrap(qx);
          const v = (1 - across / 0.9) * depth * along;
          if (v > scratch[k]!) scratch[k] = v;
        }
      }
    }
  }

  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const g = grain[k]!;
    const m = mottle[k]!;
    const p = pit[k]!;
    const sc = scratch[k]!;
    height[k] = 0.12 * micro[k]! + 0.08 * g - 0.6 * p - 0.3 * sc;
    const o = k * 4;
    orm[o] = byte(1 - 0.62 * p - 0.22 * sc - 0.14 * m * g);
    orm[o + 1] = byte(
      WEAR_ROUGHNESS_MEAN + 0.3 * (g - 0.5) + 0.1 * (m - 0.5) + 0.15 * p - 0.12 * sc,
    );
    orm[o + 2] = byte(1 - 0.35 * p - 0.06 * m);
    orm[o + 3] = byte(0.5 + 2.2 * (g - 0.5) + 0.6 * (m - 0.5) + 0.5 * sc);
  }

  // Normals from the height field by central differences, wrapping at the edges.
  const normal = new Uint8Array(n * 4);
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = height[y * size + wrap(x + 1)]! - height[y * size + wrap(x - 1)]!;
      const hy = height[wrap(y + 1) * size + x]! - height[wrap(y - 1) * size + x]!;
      const nx = -hx * strength;
      const ny = -hy * strength;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * size + x) * 4;
      normal[o] = byte((nx / l) * 0.5 + 0.5);
      normal[o + 1] = byte((ny / l) * 0.5 + 0.5);
      normal[o + 2] = byte((1 / l) * 0.5 + 0.5);
      normal[o + 3] = 255;
    }
  }

  return { orm, normal };
}
