// Reads the app's CSS custom properties into plain color strings, for any
// canvas/SVG visualization that can't use Tailwind classes directly.
// Shared by the full-page force graph (components/graph/graph-view.tsx) and
// the mini ego-graph embedded in the Ecosystem section — both need the exact
// same palette, so this lives in one place rather than two.

export interface Palette {
  bg: string;
  accent: string;
  accentSoft: string;
  node: string;
  foreign: string;
  link: string;
  label: string;
  labelStrong: string;
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
  };
}
