// Everything about how the Sentinel looks that can be tuned while it runs:
// exposure, light, glow, wear and each part's finish. The view reads it every
// frame into uniforms and light intensities — never into a shader define — so
// the lab can drag any of these and nothing compiles.
//
// Pure data. The parts are listed in the order the geometry numbers them
// (`aPart`), which is also the order of the uniform arrays the shaders index.

import { SENTINEL_PALETTE as P } from './palette';

export type PartName =
  | 'plate'
  | 'core'
  | 'bolt'
  | 'hoop'
  | 'glass'
  | 'lens'
  | 'vertebra'
  | 'rod'
  | 'claw';

/** Every part, by the index its vertices carry in `aPart`. */
export const PART_NAMES: readonly PartName[] = [
  'plate',
  'core',
  'bolt',
  'hoop',
  'glass',
  'lens',
  'vertebra',
  'rod',
  'claw',
];

export const PART = Object.fromEntries(PART_NAMES.map((name, i) => [name, i])) as Record<
  PartName,
  number
>;

export interface PartLook {
  /** Albedo (F0 for metal), sRGB hex. */
  color: string;
  roughness: number;
  metalness: number;
  /** Clearcoat weight. Only the hull's material has a clearcoat lobe; the tentacles ignore it. */
  clearcoat: number;
}

export type ToneMapper = 'agx' | 'neutral' | 'aces';

export interface SentinelLook {
  /** Exposure into the tone mapper. */
  exposure: number;
  /** AgX rolls the accent's hottest values toward white; Neutral and ACES are there to compare. */
  toneMapping: ToneMapper;
  /** How strongly the hangar reflects in the metal. */
  envIntensity: number;
  /** Radians added to the camera's yaw to turn the hangar's lights around the creature. */
  envYawOffset: number;
  /** The cold light from behind that draws the silhouette. */
  rimIntensity: number;
  rimColor: string;
  /** The eye's spotlight, per unit of the eye's own intensity. */
  eyeLightIntensity: number;
  /** How bright the lens glows, per unit of the eye's intensity. */
  eyeGain: number;
  /** How bright the light grooves and talons glow, per unit of fresh thread light. */
  glowGain: number;
  bloomStrength: number;
  /** Past about 0.3 the widest blur rings reach the screen's edge. */
  bloomRadius: number;
  /** 0 a new machine, 1 a long-used one: scratches, pitting, worn edges. */
  wear: number;
  parts: Record<PartName, PartLook>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The look the Sentinel ships with. Frozen: copy it with `defaultLook()` to change it. */
export const DEFAULT_LOOK: Readonly<SentinelLook> = deepFreeze<SentinelLook>({
  exposure: 1.1,
  toneMapping: 'agx',
  envIntensity: 1,
  envYawOffset: 0,
  rimIntensity: 2.2,
  rimColor: P.rim,
  eyeLightIntensity: 5,
  eyeGain: 5,
  glowGain: 3,
  // Tuned in the lab: tight and modest; wider or stronger, the eye's glow spreads a milky haze over the hull.
  bloomStrength: 0.44,
  bloomRadius: 0.09,
  wear: 0.6,
  parts: {
    plate: { color: P.plate, roughness: 0.32, metalness: 0.9, clearcoat: 1 },
    core: { color: P.joint, roughness: 0.62, metalness: 0.75, clearcoat: 0 },
    bolt: { color: P.bolt, roughness: 0.28, metalness: 1, clearcoat: 0 },
    hoop: { color: P.hoop, roughness: 0.4, metalness: 0.95, clearcoat: 0.5 },
    glass: { color: P.glass, roughness: 0.04, metalness: 0, clearcoat: 1 },
    lens: { color: P.lens, roughness: 0.2, metalness: 0, clearcoat: 1 },
    vertebra: { color: P.vertebra, roughness: 0.38, metalness: 0.88, clearcoat: 0 },
    rod: { color: P.rod, roughness: 0.12, metalness: 1, clearcoat: 0 },
    claw: { color: P.claw, roughness: 0.3, metalness: 0.95, clearcoat: 0 },
  },
});

/** A fresh, mutable copy of the default look. */
export function defaultLook(): SentinelLook {
  return {
    ...DEFAULT_LOOK,
    parts: Object.fromEntries(
      PART_NAMES.map((name) => [name, { ...DEFAULT_LOOK.parts[name] }]),
    ) as Record<PartName, PartLook>,
  };
}
