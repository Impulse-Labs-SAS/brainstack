import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { PART_NAMES, defaultLook } from './look';
import { TONE_MAPPERS, createMaterials } from './materials';
import { linear } from './palette';
import { bakeWear } from './wear';

const SIZE = 16;

/** What three hands `onBeforeCompile`: the material's shaders with their includes still unresolved. */
function shaderOf(lib: THREE.ShaderLibShader): THREE.WebGLProgramParametersWithUniforms {
  return {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
}

describe('createMaterials', () => {
  // A renamed chunk would throw at the first compile, mid-crawl; here it fails a test instead.
  it('patches the chunks of three’s physical and standard shaders that it names', () => {
    const m = createMaterials(bakeWear(SIZE, 1), SIZE);
    const renderer = {} as THREE.WebGLRenderer;
    for (const [material, lib] of [
      [m.hull, THREE.ShaderLib.physical],
      [m.parts, THREE.ShaderLib.standard],
    ] as const) {
      const shader = shaderOf(lib);
      expect(() => material.onBeforeCompile(shader, renderer)).not.toThrow();
      // Replaced outright…
      for (const chunk of [
        'roughnessmap_fragment',
        'metalnessmap_fragment',
        'aomap_fragment',
        'tonemapping_fragment',
      ]) {
        expect(shader.fragmentShader).not.toContain(`#include <${chunk}>`);
      }
      // …or extended where three's own still runs.
      for (const code of ['sentinelWorn', 'sentinelAO', 'material.clearcoat *= vPBR.z']) {
        expect(shader.fragmentShader).toContain(code);
      }
      expect(shader.vertexShader).toContain('vPartColor = uPartColor[ sentinelPart ];');
      // The same uniform objects the view writes to, in every program.
      expect(shader.uniforms.uToneMapper).toBe(m.uniforms.uToneMapper);
      expect(shader.uniforms.uPartColor).toBe(m.uniforms.uPartColor);
    }
    m.dispose();
  });

  it('reads each part’s colour into its uniform in linear light, and its finish beside it', () => {
    const m = createMaterials(bakeWear(SIZE, 1), SIZE);
    const look = defaultLook();
    look.parts.claw.color = '#ff8000';
    look.parts.claw.roughness = 0.7;
    look.toneMapping = 'aces';
    m.setLook(look);
    const color = m.uniforms.uPartColor.value;
    const pbr = m.uniforms.uPartPBR.value;
    PART_NAMES.forEach((name, i) => {
      const want = linear(look.parts[name].color);
      for (let k = 0; k < 3; k++) expect(color[i * 3 + k]).toBeCloseTo(want[k]!, 6);
      expect(pbr[i * 3]).toBeCloseTo(look.parts[name].roughness, 6);
      expect(pbr[i * 3 + 1]).toBeCloseTo(look.parts[name].metalness, 6);
      expect(pbr[i * 3 + 2]).toBeCloseTo(look.parts[name].clearcoat, 6);
    });
    expect(m.uniforms.uToneMapper.value).toBe(TONE_MAPPERS.aces);
    m.dispose();
  });
});
