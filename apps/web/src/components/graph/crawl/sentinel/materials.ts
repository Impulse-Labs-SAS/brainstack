// The Sentinel's materials: two physically based ones that draw it, and two
// emissive-only twins that draw its glow for the bloom.
//
// - The hull is a MeshPhysicalMaterial, for the clearcoat on its plates and
//   lens. Its clearcoat stays above zero at every tier: clearcoat compiles in
//   only when it is above zero, and a tier must never compile. Each fragment
//   scales it by its part's weight instead.
// - The vertebrae, talons and iris blades share one MeshStandardMaterial: they
//   cover most of the creature's pixels, and a clearcoat lobe there would buy
//   nothing at their size.
//
// Each part's colour, roughness, metalness and clearcoat come from uniform
// arrays indexed by the vertex's `aPart`, so the lab tunes them live. Wear
// comes from one baked texture read once per fragment for cavity, roughness,
// metalness and the wear mask, plus its normal map; worn metal shows on the
// edges the geometry marks (`aEdge`). The occlusion baked into the vertices
// (`aAO`) darkens direct light too, not only the environment, or seams under
// the rim light and the eye would stay bright.
//
// The instanced parts read `aSeg` per instance — glow, wear seed, position
// along the tentacle, tentacle — and glow where the geometry has `aEmit`: the
// light groove of each vertebra and the tip of each talon. The glow is the
// accent, running toward the core's green-white when it is strong.
//
// The look's tone mapper is a uniform too: the view always draws with three's
// AgX tone mapping on (which brings in every tone curve), and the material
// picks the curve per fragment — switching it in the lab compiles nothing.
//
// Uniforms are shared objects, assigned to every program three compiles: a
// material compiles again for a different renderer state, and the copy it
// keeps must be the same object the view writes to.

import * as THREE from 'three';

import { EYE } from './anatomy';
import { PART, PART_NAMES, type SentinelLook, type ToneMapper } from './look';
import { linear, SENTINEL_LINEAR } from './palette';
import { WEAR_ROUGHNESS_MEAN, type WearMaps } from './wear';

const PARTS = PART_NAMES.length;

export const TONE_MAPPERS: Readonly<Record<ToneMapper, number>> = { agx: 0, neutral: 1, aces: 2 };

export interface SentinelUniforms {
  /** Per part, linear RGB. */
  uPartColor: THREE.IUniform<Float32Array>;
  /** Per part: roughness, metalness, clearcoat. */
  uPartPBR: THREE.IUniform<Float32Array>;
  uWear: THREE.IUniform<number>;
  uWearColor: THREE.IUniform<THREE.Color>;
  uAccent: THREE.IUniform<THREE.Color>;
  uCore: THREE.IUniform<THREE.Color>;
  uGlowGain: THREE.IUniform<number>;
  /** How bright the lens glows this frame: the eye's intensity times the look's gain. */
  uEye: THREE.IUniform<number>;
  /** The hull's centre, creature space: tentacles darken in its shadow. */
  uHullCenter: THREE.IUniform<THREE.Vector3>;
  uToneMapper: THREE.IUniform<number>;
}

export interface SentinelMaterials {
  hull: THREE.MeshPhysicalMaterial;
  parts: THREE.MeshStandardMaterial;
  /** The hull for the glow pass: black, but for the lens. */
  hullGlow: THREE.ShaderMaterial;
  /** The instanced parts for the glow pass: black, but for the grooves and talon tips. */
  partsGlow: THREE.ShaderMaterial;
  uniforms: SentinelUniforms;
  /** Copies the look into uniforms and material settings; colours are parsed only when they change. */
  setLook(look: SentinelLook): void;
  dispose(): void;
}

// -- GLSL --------------------------------------------------------------------------

const f = (x: number) => x.toFixed(5);

/** The lens's glow: brightest at its centre, from the hull's own position. */
const LENS_GLSL = /* glsl */ `
  float sentinelLens( float part, vec3 p ) {
    float r = length( p.xy - vec2( ${f(EYE.position[0])}, ${f(EYE.position[1])} ) ) / 0.05;
    return abs( part - ${PART.lens}.0 ) < 0.5 ? max( 0.0, 1.0 - 0.6 * r * r ) : 0.0;
  }`;

/** A groove's or talon's glow, from its fresh thread light. */
const GLOW_GLSL = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uCore;
  uniform float uGlowGain;
  vec3 sentinelGlow( float emit, float glow ) {
    float e = clamp( emit, 0.0, 1.0 ) * max( glow, 0.0 );
    return mix( uAccent, uCore, smoothstep( 0.5, 1.5, e ) ) * e * uGlowGain;
  }`;

const PART_VERTEX_PARS = /* glsl */ `
  attribute float aPart;
  attribute float aAO;
  attribute float aEdge;
  uniform vec3 uPartColor[ ${PARTS} ];
  uniform vec3 uPartPBR[ ${PARTS} ];
  uniform float uWear;
  varying vec3 vPartColor;
  varying vec3 vPBR;
  varying float vAO;
  varying float vEdge;
  varying float vWear;
  varying vec3 vEmission;`;

/** Moves the wear texture's coordinates, so neighbouring parts and segments wear differently. */
const SHIFT_WEAR_UV = /* glsl */ `
  #ifdef USE_AOMAP
    vAoMapUv += sentinelShift;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv += sentinelShift;
  #endif`;

const PART_FRAGMENT_PARS = /* glsl */ `
  uniform vec3 uWearColor;
  uniform float uToneMapper;
  varying vec3 vPartColor;
  varying vec3 vPBR;
  varying float vAO;
  varying float vEdge;
  varying float vWear;
  varying vec3 vEmission;`;

/** One fetch of the wear texture serves occlusion, roughness, metalness and the wear mask. */
const COLOR_FRAGMENT = /* glsl */ `
  #include <color_fragment>
  #ifdef USE_AOMAP
    vec4 sentinelWear = texture2D( aoMap, vAoMapUv );
  #else
    vec4 sentinelWear = vec4( 1.0, ${f(WEAR_ROUGHNESS_MEAN)}, 1.0, 0.5 );
  #endif
  // Edges wear through to bare metal where the mask says the finish is thin.
  float sentinelWorn = smoothstep( 0.45, 0.85, vEdge * ( 0.45 + 0.55 * sentinelWear.a ) ) * vWear;
  diffuseColor.rgb = mix( diffuseColor.rgb * vPartColor, uWearColor, sentinelWorn );`;

const ROUGHNESS_FRAGMENT = /* glsl */ `
  float roughnessFactor = vPBR.x * mix( 1.0, sentinelWear.g / ${f(WEAR_ROUGHNESS_MEAN)}, vWear );
  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.8, sentinelWorn );`;

const METALNESS_FRAGMENT = /* glsl */ `
  float metalnessFactor = mix( vPBR.y * mix( 1.0, sentinelWear.b, vWear ), 1.0, sentinelWorn );`;

/** Baked occlusion and the wear's cavity, on the direct light as well as the indirect. */
const DIRECT_AO_FRAGMENT = /* glsl */ `
  #include <lights_fragment_end>
  float sentinelAO = vAO * mix( 1.0, sentinelWear.r, vWear );
  reflectedLight.directDiffuse *= sentinelAO;
  reflectedLight.directSpecular *= mix( 1.0, sentinelAO, 0.6 );
  #ifdef USE_CLEARCOAT
    clearcoatSpecularDirect *= mix( 1.0, sentinelAO, 0.6 );
  #endif`;

/** aomap_fragment, with the baked occlusion in place of the map's intensity. */
const AO_FRAGMENT = /* glsl */ `
  float ambientOcclusion = sentinelAO;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif`;

/** Every tone curve is in the prefix once tone mapping is on; the look picks one. */
const TONE_MAPPING_FRAGMENT = /* glsl */ `
  #if defined( TONE_MAPPING )
    if ( uToneMapper < 0.5 ) gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
    else if ( uToneMapper < 1.5 ) gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
    else gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
  #endif`;

function replace(source: string, chunk: string, by: string): string {
  const include = `#include <${chunk}>`;
  if (!source.includes(include)) throw new Error(`Sentinel shader: ${chunk} is missing`);
  return source.replace(include, by);
}

/** The shared fragment changes, for both lit materials. */
function litFragment(source: string, emission: string): string {
  let s = replace(source, 'common', `#include <common>\n${PART_FRAGMENT_PARS}`);
  s = replace(s, 'color_fragment', COLOR_FRAGMENT);
  s = replace(s, 'roughnessmap_fragment', ROUGHNESS_FRAGMENT);
  s = replace(s, 'metalnessmap_fragment', METALNESS_FRAGMENT);
  s = replace(s, 'emissivemap_fragment', `#include <emissivemap_fragment>\n${emission}`);
  s = replace(
    s,
    'lights_physical_fragment',
    `#include <lights_physical_fragment>
    #ifdef USE_CLEARCOAT
      material.clearcoat *= vPBR.z;
    #endif`,
  );
  s = replace(s, 'lights_fragment_end', DIRECT_AO_FRAGMENT);
  s = replace(s, 'aomap_fragment', AO_FRAGMENT);
  return replace(s, 'tonemapping_fragment', TONE_MAPPING_FRAGMENT);
}

// -- Materials ---------------------------------------------------------------------

function wearTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  // Mipmaps are why this is a texture at all: without them, scratches shimmer on thin tentacles.
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function createUniforms(): SentinelUniforms {
  return {
    uPartColor: { value: new Float32Array(PARTS * 3) },
    uPartPBR: { value: new Float32Array(PARTS * 3) },
    uWear: { value: 0 },
    uWearColor: { value: new THREE.Color().setRGB(...SENTINEL_LINEAR.wear) },
    uAccent: { value: new THREE.Color().setRGB(...SENTINEL_LINEAR.accent) },
    uCore: { value: new THREE.Color().setRGB(...SENTINEL_LINEAR.core) },
    uGlowGain: { value: 1 },
    uEye: { value: 1 },
    uHullCenter: { value: new THREE.Vector3() },
    uToneMapper: { value: 0 },
  };
}

export function createMaterials(wear: WearMaps, size: number): SentinelMaterials {
  const uniforms = createUniforms();
  const orm = wearTexture(wear.orm, size);
  const normal = wearTexture(wear.normal, size);
  const shared = (shader: THREE.WebGLProgramParametersWithUniforms) =>
    Object.assign(shader.uniforms, uniforms);

  const hull = new THREE.MeshPhysicalMaterial({
    name: 'Sentinel hull',
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    aoMap: orm,
    normalMap: normal,
  });
  hull.onBeforeCompile = (shader) => {
    shared(shader);
    shader.vertexShader = replace(
      shader.vertexShader,
      'common',
      `#include <common>\n${PART_VERTEX_PARS}\n${LENS_GLSL}
      uniform vec3 uCore;
      uniform float uEye;`,
    );
    shader.vertexShader = replace(
      shader.vertexShader,
      'uv_vertex',
      /* glsl */ `#include <uv_vertex>
      int sentinelPart = int( aPart + 0.5 );
      vPartColor = uPartColor[ sentinelPart ];
      vPBR = uPartPBR[ sentinelPart ];
      vAO = aAO;
      vEdge = aEdge;
      vWear = uWear;
      vEmission = uCore * uEye * sentinelLens( aPart, position );
      vec2 sentinelShift = vec2( 0.37, 0.61 ) * aPart;
      ${SHIFT_WEAR_UV}`,
    );
    shader.fragmentShader = litFragment(
      shader.fragmentShader,
      'totalEmissiveRadiance += vEmission;',
    );
  };
  hull.customProgramCacheKey = () => 'sentinel-hull-1';

  const parts = new THREE.MeshStandardMaterial({
    name: 'Sentinel parts',
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    aoMap: orm,
    normalMap: normal,
  });
  parts.onBeforeCompile = (shader) => {
    shared(shader);
    shader.vertexShader = replace(
      shader.vertexShader,
      'common',
      `#include <common>\n${PART_VERTEX_PARS}\n${GLOW_GLSL}
      attribute float aEmit;
      attribute vec4 aSeg;
      uniform vec3 uHullCenter;`,
    );
    shader.vertexShader = replace(
      shader.vertexShader,
      'uv_vertex',
      /* glsl */ `#include <uv_vertex>
      int sentinelPart = int( aPart + 0.5 );
      vPartColor = uPartColor[ sentinelPart ];
      vPBR = uPartPBR[ sentinelPart ];
      vEdge = aEdge;
      vEmission = sentinelGlow( aEmit, aSeg.x );
      #ifdef USE_INSTANCING
        // Close to the hull, a tentacle is in its shadow.
        float sentinelNear = smoothstep( 0.25, 0.6, distance( instanceMatrix[ 3 ].xyz, uHullCenter ) );
      #else
        float sentinelNear = 1.0;
      #endif
      vAO = aAO * mix( 0.6, 1.0, sentinelNear );
      // No two segments wear alike: each one's seed moves it over the texture and scales its wear.
      vWear = uWear * ( 0.75 + 0.5 * aSeg.y );
      vec2 sentinelShift = vec2( 1.21, 4.33 ) * aSeg.y + vec2( 0.37, 0.61 ) * aPart;
      ${SHIFT_WEAR_UV}`,
    );
    shader.fragmentShader = litFragment(
      shader.fragmentShader,
      'totalEmissiveRadiance += vEmission;',
    );
  };
  parts.customProgramCacheKey = () => 'sentinel-parts-1';

  // The glow pass: depth-tested like the drawing, so the hull and tentacles
  // hide the glow behind them; black wherever nothing glows.
  const hullGlow = new THREE.ShaderMaterial({
    name: 'Sentinel hull glow',
    uniforms: { uCore: uniforms.uCore, uEye: uniforms.uEye },
    vertexShader: /* glsl */ `
      attribute float aPart;
      varying float vLens;
      ${LENS_GLSL}
      void main() {
        vLens = sentinelLens( aPart, position );
        #include <begin_vertex>
        #include <project_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCore;
      uniform float uEye;
      varying float vLens;
      void main() {
        gl_FragColor = vec4( uCore * uEye * vLens, 1.0 );
      }`,
    toneMapped: false,
  });
  hullGlow.customProgramCacheKey = () => 'sentinel-hull-glow-1';

  const partsGlow = new THREE.ShaderMaterial({
    name: 'Sentinel parts glow',
    uniforms: { uAccent: uniforms.uAccent, uCore: uniforms.uCore, uGlowGain: uniforms.uGlowGain },
    vertexShader: /* glsl */ `
      attribute float aEmit;
      attribute vec4 aSeg;
      varying vec3 vEmission;
      ${GLOW_GLSL}
      void main() {
        vEmission = sentinelGlow( aEmit, aSeg.x );
        #include <begin_vertex>
        #include <project_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vEmission;
      void main() {
        gl_FragColor = vec4( vEmission, 1.0 );
      }`,
    toneMapped: false,
  });
  partsGlow.customProgramCacheKey = () => 'sentinel-parts-glow-1';

  // Colours are parsed only when the look changes them, not every frame.
  const parsed: string[] = [];
  const color = uniforms.uPartColor.value;
  const pbr = uniforms.uPartPBR.value;

  return {
    hull,
    parts,
    hullGlow,
    partsGlow,
    uniforms,
    setLook(look) {
      PART_NAMES.forEach((name, i) => {
        const p = look.parts[name];
        if (parsed[i] !== p.color) {
          parsed[i] = p.color;
          const [r, g, b] = linear(p.color);
          color[i * 3] = r;
          color[i * 3 + 1] = g;
          color[i * 3 + 2] = b;
        }
        pbr[i * 3] = p.roughness;
        pbr[i * 3 + 1] = p.metalness;
        pbr[i * 3 + 2] = p.clearcoat;
      });
      uniforms.uWear.value = look.wear;
      uniforms.uGlowGain.value = look.glowGain;
      uniforms.uToneMapper.value = TONE_MAPPERS[look.toneMapping] ?? 0;
      // Scratches and pits lean the normals more as the machine ages.
      const bump = 0.15 + 0.85 * look.wear;
      hull.normalScale.set(bump, bump);
      parts.normalScale.set(bump, bump);
    },
    dispose() {
      for (const m of [hull, parts, hullGlow, partsGlow]) m.dispose();
      orm.dispose();
      normal.dispose();
    },
  };
}
