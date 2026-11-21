import { describe, expect, it } from 'vitest';

import { DocumentImportError } from './errors.js';
import { assertHasText, countWordChars, normalizeText } from './text.js';

const err = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e as DocumentImportError;
  }
  return null;
};

describe('assertHasText', () => {
  it('refuses whitespace and a few stray characters as EMPTY_TEXT', () => {
    expect(err(() => assertHasText('   \n\n  '))?.code).toBe('EMPTY_TEXT');
    expect(err(() => assertHasText('1\n\n2\n\n3\n\n- 4 -'))?.code).toBe('EMPTY_TEXT');
    expect(err(() => assertHasText('1 2 3'))?.message).toMatch(/OCR/);
  });

  it('refuses a big file with only page numbers in it', () => {
    const pageNumbers = Array.from({ length: 40 }, (_, i) => `Página ${i + 1}`).join('\n\n');
    expect(err(() => assertHasText(pageNumbers))).toBeNull();
    expect(err(() => assertHasText(pageNumbers, 8 * 1024 * 1024))?.code).toBe('EMPTY_TEXT');
  });

  it('accepts real text, in any script', () => {
    expect(
      err(() =>
        assertHasText('El sistema registra cada movimiento del depósito y lo concilia.', 20_000),
      ),
    ).toBeNull();
    expect(countWordChars('Ñandú 東京 42!')).toBe(9);
  });
});

describe('normalizeText', () => {
  it('folds line endings and blank runs, and drops control characters', () => {
    expect(normalizeText('a\r\n\r\n\r\n\u0007b  \n')).toBe('a\n\nb');
  });
});
