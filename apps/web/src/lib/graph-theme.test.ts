import { describe, expect, it } from 'vitest';

import { AA_NON_TEXT, contrast, parseColor, type RGB } from './contrast';
import {
  LINE_ART_COLORS,
  LINE_ART_TOKENS,
  lineArtRgb,
  lineArtTheme,
  type LineArtTheme,
} from './graph-theme';
import { rootTokens } from './root-tokens';

const keys = Object.keys(LINE_ART_COLORS) as (keyof LineArtTheme)[];
const rgb = (css: string): RGB => {
  const c = parseColor(css);
  if (!c || c.alpha !== 1) throw new Error(`${css} is not an opaque colour`);
  return c.rgb;
};

describe('the line-art colours', () => {
  it('are what globals.css sets, token by token', () => {
    const tokens = rootTokens();
    expect(Object.keys(LINE_ART_TOKENS).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const token = LINE_ART_TOKENS[key];
      expect(tokens.get(token), `--${token}`).toBe(LINE_ART_COLORS[key]);
    }
  });

  it('reads the page token by token, and keeps its own copy where one is missing or no colour', () => {
    const page: Record<string, string> = {
      'graph-la-block-top': ' #202028 ',
      'graph-la-grid': 'oklch(0.3 0.01 280)',
      accent: '#8866ff',
    };
    const theme = lineArtTheme((token) => page[token] ?? '');
    expect(theme.blockTop).toBe('#202028');
    expect(theme.accent).toBe('#8866ff');
    expect(theme.grid).toBe(LINE_ART_COLORS.grid);
    for (const key of keys.filter((k) => k !== 'blockTop' && k !== 'accent')) {
      expect(theme[key], key).toBe(LINE_ART_COLORS[key]);
    }
    // No page at all, as in a test or a worker: the copy, whole.
    expect(lineArtTheme()).toEqual(LINE_ART_COLORS);
    // A fresh object each time, so a caller may keep one without another changing it.
    expect(lineArtTheme()).not.toBe(LINE_ART_COLORS);
  });

  it('hands the shaders sRGB channels as written', () => {
    expect(lineArtRgb('#7c5cff')).toEqual([124 / 255, 92 / 255, 1]);
    expect(lineArtRgb('rgb(255, 0, 51)')).toEqual([1, 0, 0.2]);
    expect(lineArtRgb('not a colour')).toEqual([0, 0, 0]);
  });
});

describe('the line-art contrast', () => {
  const c = LINE_ART_COLORS;
  const plateTops: [string, string][] = [
    ['vaultTop', c.vaultTop],
    ['projectTop', c.projectTop],
    ['folderTop', c.folderTop],
    ['subTop', c.subTop],
  ];

  it('outlines a block at 3:1 on every plate it can stand on, and on its own top', () => {
    const fills: [string, string][] = [...plateTops, ['blockTop', c.blockTop]];
    for (const [name, fill] of fills) {
      expect(contrast(rgb(c.blockEdge), rgb(fill)), `blockEdge on ${name}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it('marks what is active in the accent at 3:1 on every plate, a block and the selected top', () => {
    const fills: [string, string][] = [
      ...plateTops,
      ['blockTop', c.blockTop],
      ['selTop', c.selTop],
    ];
    for (const [name, fill] of fills) {
      expect(contrast(rgb(c.accent), rgb(fill)), `accent on ${name}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it('outlines the block pointed at at 3:1 on a block’s top', () => {
    expect(contrast(rgb(c.hoverEdge), rgb(c.blockTop))).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(rgb(c.hoverEdge), rgb(c.hoverTop))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});
