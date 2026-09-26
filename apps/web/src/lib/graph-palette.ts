// Colours the graph paints with, as plain values: the WebGL scene and the 2D
// overlay cannot read Tailwind classes or CSS variables per node.

/** A vault's colour: `hue` for glow and edges, `core` for the lit centre of a node. */
export interface VaultColor {
  hue: string;
  core: string;
  rgb: readonly [number, number, number];
}

// Your own vault takes the accent family; shared vaults take these in order.
// A hue per *vault* scales where a hue per project did not: a viewer sees a
// handful of vaults, not fifty. Past five owners the rest share a neutral —
// identity never rests on hue alone, a ring marks every note that is not yours.
export const OWN_VAULT_COLOR: VaultColor = { hue: '#9d85ff', core: '#e6e0ff', rgb: [157, 133, 255] };
export const SHARED_VAULT_COLORS: readonly VaultColor[] = [
  { hue: '#2fd5c4', core: '#cdf7f1', rgb: [47, 213, 196] },
  { hue: '#f5a524', core: '#fde7bd', rgb: [245, 165, 36] },
  { hue: '#fb7185', core: '#ffd9df', rgb: [251, 113, 133] },
  { hue: '#38bdf8', core: '#d6f1ff', rgb: [56, 189, 248] },
  { hue: '#a3e635', core: '#ecfccb', rgb: [163, 230, 53] },
];
export const OTHER_VAULT_COLOR: VaultColor = { hue: '#a1a1aa', core: '#e4e4e7', rgb: [161, 161, 170] };
/** Label ink by importance: focused, a neighbour of the focus, an index, a topic, any note. */
export const LABEL_COLORS = {
  strong: '#ffffff',
  neighbour: '#ece9f7',
  index: '#d9d3f2',
  topic: '#a9a6bb',
  note: '#b6b3c2',
} as const;
export const TOPIC_COLOR: VaultColor = { hue: '#b9b6cc', core: '#ebe9f5', rgb: [185, 182, 204] };
