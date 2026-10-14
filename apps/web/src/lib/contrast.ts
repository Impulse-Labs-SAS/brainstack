// WCAG 2 contrast between colours, as CSS writes them: what the tests hold the design tokens
// to. Text needs 4.5:1 against what is behind it; lines, icons and other marks that carry
// meaning need 3:1 (WCAG 1.4.3 and 1.4.11).

export type RGB = readonly [number, number, number];

/** Text, at any size the app uses. */
export const AA_TEXT = 4.5;
/** Marks that are not text: icons, a focus ring, the line of a control. */
export const AA_NON_TEXT = 3;

/** A colour from `#rgb`, `#rrggbb`, `rgb()`/`rgba()` or bare `r g b` channels; null when it is none of them. */
export function parseColor(css: string): { rgb: RGB; alpha: number } | null {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return {
      rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB,
      alpha: 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
  const parts = (fn ? fn[1]! : s)
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if ((parts.length === 3 || parts.length === 4) && parts.every(Number.isFinite)) {
    return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
  }
  return null;
}

/** `top`, at its alpha, laid over the opaque `under`. */
export function over(top: { rgb: RGB; alpha: number }, under: RGB): RGB {
  const a = top.alpha;
  return [0, 1, 2].map((i) => top.rgb[i]! * a + under[i]! * (1 - a)) as unknown as RGB;
}

/** Relative luminance, 0 for black to 1 for white. */
export function luminance(rgb: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** The contrast ratio of two opaque colours, from 1 to 21, whichever is lighter. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
