// The Sentinel's colours: parkerized grey metal and one cold, desaturated
// accent. The metal reads dark because the hangar it reflects is dark, not
// because it is black — metal with an albedo near black looks like plastic.
//
// The accent sits near the lit thread's teal (#5eead4, hue 171°) but at a
// quarter of its saturation, so the creature belongs to the crawl without
// turning into the film's green.
//
// Pure: hex strings for people and pickers, linear triples for shaders.

export const SENTINEL_PALETTE = {
  /** Parkerized steel: the armour plates. */
  plate: '#73797c',
  /** Oxide: the core under the plates, seen through the seams. */
  joint: '#4f5456',
  /** Bolt heads. */
  bolt: '#a9aeb0',
  /** Machined rings: the hoops, the collar, the eye's housing. */
  hoop: '#868c8f',
  /** Bare metal where edges wore through the finish. */
  wear: '#c3c7c9',
  /** Polished hydraulic rods. */
  rod: '#b4babd',
  /** The tentacles' vertebrae. */
  vertebra: '#6b7174',
  /** The talons. */
  claw: '#5d6366',
  /** The lens's dark glass. */
  glass: '#050607',
  /** The lens core when it is dark. */
  lens: '#0c1110',
  /** The one cold accent: hue 166°, saturation 0.25. */
  accent: '#a6dccf',
  /** The hottest emissive, green-white. */
  core: '#e2fbf4',
  /** The rim light. */
  rim: '#b9d8d2',
} as const;

export type PaletteToken = keyof typeof SENTINEL_PALETTE;

export type Linear = readonly [number, number, number];

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** An sRGB hex colour (`#rrggbb`) in linear light, the space shaders mix in. */
export function linear(hex: string): Linear {
  const n = parseInt(hex.replace('#', ''), 16);
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
}

export const SENTINEL_LINEAR = Object.fromEntries(
  Object.entries(SENTINEL_PALETTE).map(([k, hex]) => [k, linear(hex)]),
) as Record<PaletteToken, Linear>;
