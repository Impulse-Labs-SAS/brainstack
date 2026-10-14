// The design tokens held to WCAG AA, read from globals.css itself: a token changed there
// without its pairs still reading fails here, not in someone's eyes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AA_NON_TEXT, AA_TEXT, contrast, over, parseColor, type RGB } from './contrast';
import {
  LABEL_COLORS,
  OTHER_VAULT_COLOR,
  OWN_VAULT_COLOR,
  SHARED_VAULT_COLORS,
} from './graph-palette';

describe('contrast', () => {
  it('measures as WCAG does', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBe(1);
    // #767676 is the lightest grey that holds 4.5:1 on white.
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(contrast([119, 119, 119], [255, 255, 255])).toBeLessThan(4.5);
  });

  it('reads the colours CSS writes, and lays a translucent one over another', () => {
    expect(parseColor('#7c5cff')).toEqual({ rgb: [124, 92, 255], alpha: 1 });
    expect(parseColor('#fff')).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(parseColor('rgba(17, 17, 17, 0.86)')).toEqual({ rgb: [17, 17, 17], alpha: 0.86 });
    expect(parseColor('124 92 255')).toEqual({ rgb: [124, 92, 255], alpha: 1 });
    expect(parseColor('linear-gradient(red, blue)')).toBeNull();
    expect(over({ rgb: [255, 255, 255], alpha: 0.5 }, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
  });
});

/** Every custom property of the :root block in globals.css, as written. */
function rootTokens(): Map<string, string> {
  const css = readFileSync(
    fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
    'utf8',
  );
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
  const tokens = new Map<string, string>();
  for (const m of root.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens.set(m[1]!, m[2]!.trim());
  }
  return tokens;
}

describe('the design tokens', () => {
  const tokens = rootTokens();
  const solid = (name: string): RGB => {
    const c = parseColor(tokens.get(name) ?? '');
    if (!c || c.alpha !== 1) throw new Error(`--${name} is not an opaque colour`);
    return c.rgb;
  };
  const base = solid('bg-base');
  /** What text sits on: the backgrounds, and the glass panels as they look over the graph's dark. */
  const grounds: [string, RGB][] = [
    ['bg-base', base],
    ['bg-surface', solid('bg-surface')],
    ['bg-elevated', solid('bg-elevated')],
    ['bg-hover', solid('bg-hover')],
    ['glass over bg-base', over(parseColor(tokens.get('glass-bg')!)!, base)],
  ];

  it('gives every text ink 4.5:1 on every background', () => {
    for (const ink of ['fg-primary', 'fg-body', 'fg-secondary', 'fg-tertiary']) {
      for (const [name, ground] of grounds) {
        expect(contrast(solid(ink), ground), `--${ink} on ${name}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps --fg-muted for marks: 3:1 for icons, and short of what text needs on a raised surface', () => {
    for (const [name, ground] of grounds) {
      expect(contrast(solid('fg-muted'), ground), `--fg-muted on ${name}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
    expect(contrast(solid('fg-muted'), solid('bg-hover'))).toBeLessThan(AA_TEXT);
  });

  it('reads white on the solid accent, hovered or not, and the accent as text on the dark', () => {
    const white = solid('accent-fg');
    expect(contrast(white, solid('accent-solid'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(white, solid('accent-solid-hover'))).toBeGreaterThanOrEqual(AA_TEXT);
    for (const [name, ground] of grounds) {
      expect(
        contrast(solid('accent-text'), ground),
        `--accent-text on ${name}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      // The accent itself marks a ring, a dot, a selected tab: 3:1 is what those need.
      expect(contrast(solid('accent'), ground), `--accent on ${name}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it('agrees with itself: the accent channels say what the accent hex says', () => {
    expect(parseColor(tokens.get('accent-rgb')!)!.rgb).toEqual(solid('accent'));
    expect(parseColor(tokens.get('accent-hover-rgb')!)!.rgb).toEqual(solid('accent-hover'));
  });
});

describe('the graph canvas inks', () => {
  // The overlay draws on the graph's dark (#0a0a0a, --bg-base) with a dark halo round every label.
  const dark = parseColor(rootTokens().get('bg-base')!)!.rgb;

  it('labels notes at 4.5:1 or more', () => {
    for (const [name, hex] of Object.entries(LABEL_COLORS)) {
      expect(contrast(parseColor(hex)!.rgb, dark), name).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('names places in each vault’s light ink at 4.5:1, and marks vaults in their hue at 3:1', () => {
    for (const color of [OWN_VAULT_COLOR, ...SHARED_VAULT_COLORS, OTHER_VAULT_COLOR]) {
      expect(contrast(parseColor(color.core)!.rgb, dark), color.core).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrast(parseColor(color.hue)!.rgb, dark), color.hue).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });
});
