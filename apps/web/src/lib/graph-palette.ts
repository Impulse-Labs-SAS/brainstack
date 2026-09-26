// Reads the app's CSS custom properties into plain color strings, for any
// canvas/SVG visualization that can't use Tailwind classes directly.
// Used by the full-page force graph (components/graph/graph-view.tsx); kept
// separate from it so a second visualization would not have to re-derive the
// palette from the design tokens.

export interface Palette {
  bg: string;
  accent: string;
  accentSoft: string;
  node: string;
  foreign: string;
  link: string;
  label: string;
  labelStrong: string;
  /** One colour per folder slot, in slot order (see lib/graph-structure.ts). */
  groups: readonly string[];
}

export const FALLBACK_PALETTE: Palette = {
  bg: '#0a0a0a',
  accent: '#7c5cff',
  accentSoft: '#9579ff',
  node: '#a0a0a0',
  foreign: '#3b82f6',
  link: '#6b6b6b',
  label: '#a0a0a0',
  labelStrong: '#ededed',
  groups: ['#3987e5', '#d95926', '#199e70'],
};

export function readPalette(): Palette {
  if (typeof window === 'undefined') return FALLBACK_PALETTE;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg-base', FALLBACK_PALETTE.bg),
    accent: v('--accent', FALLBACK_PALETTE.accent),
    accentSoft: v('--accent-hover', FALLBACK_PALETTE.accentSoft),
    node: v('--fg-secondary', FALLBACK_PALETTE.node),
    foreign: v('--info', FALLBACK_PALETTE.foreign),
    link: v('--fg-muted', FALLBACK_PALETTE.link),
    label: v('--fg-secondary', FALLBACK_PALETTE.label),
    labelStrong: v('--fg-primary', FALLBACK_PALETTE.labelStrong),
    groups: FALLBACK_PALETTE.groups.map((fallback, i) => v(`--graph-group-${i + 1}`, fallback)),
  };
}
