// The line-art map's colours: flat near-black fills a step lighter per level, thin edges, and
// the accent only for what is active. The page's stylesheet owns them (`--graph-la-*` in
// globals.css, beside `--accent`); the canvas reads them from there, and keeps a copy for
// where no stylesheet is — a test, a worker, a first frame. The copy is held equal to the
// stylesheet by this module's test, so changing a colour means changing it in one place and
// watching the test say where else.
//
// The app is dark only: there is no light variant of any of these.
//
// Pure: no DOM unless one is there to read.

import { parseColor } from './contrast';

export interface LineArtTheme {
  grid: string;
  vaultTop: string;
  vaultSide: string;
  vaultEdge: string;
  projectTop: string;
  projectSide: string;
  projectEdge: string;
  folderTop: string;
  folderSide: string;
  folderEdge: string;
  /** A sub-folder's top; its sides and edges are a folder's. */
  subTop: string;
  blockTop: string;
  blockLeft: string;
  blockRight: string;
  blockEdge: string;
  /** A block's edge while another note is selected and this one is not linked to it. */
  blockDim: string;
  /** A block at rest seen from far off: a flat tile, its edges too close to tell apart. */
  blockTile: string;
  hoverTop: string;
  hoverEdge: string;
  selTop: string;
  /** The shared vault's dashed rim. */
  route: string;
  accent: string;
}

/** The custom property behind each colour, without its leading `--`. */
export const LINE_ART_TOKENS: Readonly<Record<keyof LineArtTheme, string>> = {
  grid: 'graph-la-grid',
  vaultTop: 'graph-la-vault-top',
  vaultSide: 'graph-la-vault-side',
  vaultEdge: 'graph-la-vault-edge',
  projectTop: 'graph-la-project-top',
  projectSide: 'graph-la-project-side',
  projectEdge: 'graph-la-project-edge',
  folderTop: 'graph-la-folder-top',
  folderSide: 'graph-la-folder-side',
  folderEdge: 'graph-la-folder-edge',
  subTop: 'graph-la-sub-top',
  blockTop: 'graph-la-block-top',
  blockLeft: 'graph-la-block-left',
  blockRight: 'graph-la-block-right',
  blockEdge: 'graph-la-block-edge',
  blockDim: 'graph-la-block-dim',
  blockTile: 'graph-la-block-tile',
  hoverTop: 'graph-la-hover-top',
  hoverEdge: 'graph-la-hover-edge',
  selTop: 'graph-la-sel-top',
  route: 'graph-la-route',
  accent: 'accent',
};

/** The values globals.css sets: what the canvas uses where no stylesheet is (a test, a worker). */
export const LINE_ART_COLORS: Readonly<LineArtTheme> = {
  grid: '#2c2c34',
  vaultTop: '#0e0e11',
  vaultSide: '#08080a',
  vaultEdge: '#363640',
  projectTop: '#121216',
  projectSide: '#0b0b0e',
  projectEdge: '#40404a',
  folderTop: '#16161b',
  folderSide: '#0d0d10',
  folderEdge: '#4b4b56',
  subTop: '#1a1a20',
  blockTop: '#1e1e25',
  blockLeft: '#15151a',
  blockRight: '#101014',
  blockEdge: '#72727e',
  blockDim: '#565662',
  blockTile: '#3c3c46',
  hoverTop: '#27272f',
  hoverEdge: '#e2e2ea',
  selTop: '#221c3a',
  route: '#85858f',
  accent: '#7c5cff',
};

/** What the page's stylesheet sets for a custom property now, or '' where there is no page. */
function fromPage(): (token: string) => string {
  if (typeof document === 'undefined') return () => '';
  const style = getComputedStyle(document.documentElement);
  return (token) => style.getPropertyValue('--' + token);
}

/**
 * The theme as the page's stylesheet sets it now, token by token, LINE_ART_COLORS where a token
 * is missing — or is not a colour the canvas can draw with (`parseColor`'s forms), so a token
 * someone writes in another notation costs that one colour, not the frame.
 */
export function lineArtTheme(read: (token: string) => string = fromPage()): LineArtTheme {
  const theme = { ...LINE_ART_COLORS };
  for (const key of Object.keys(LINE_ART_TOKENS) as (keyof LineArtTheme)[]) {
    const value = read(LINE_ART_TOKENS[key]).trim();
    // Opaque only: the shaders take no alpha, and a translucent token would draw as another colour.
    if (value && parseColor(value)?.alpha === 1) theme[key] = value;
  }
  return theme;
}

/**
 * A theme colour as the canvas writes it: sRGB channels from 0 to 1, black for what is not a
 * colour. The line-art shaders put these on screen as they are, with no colour management,
 * so a block is exactly the hex the stylesheet names.
 */
export function lineArtRgb(css: string): [number, number, number] {
  const c = parseColor(css);
  return c ? [c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255] : [0, 0, 0];
}
