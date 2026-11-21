import { describe, expect, it } from 'vitest';

import { ocrTextToMarkdown } from './ocr';

describe('ocrTextToMarkdown', () => {
  it('joins the printed lines of a paragraph and keeps paragraphs apart', () => {
    expect(
      ocrTextToMarkdown('El sistema registra cada\r\nmovimiento del día.\n\n  \nOtro párrafo\n'),
    ).toBe('El sistema registra cada movimiento del día.\n\nOtro párrafo');
  });

  it('makes a word hyphenated at the end of a line whole', () => {
    expect(ocrTextToMarkdown('concilia-\nción mensual')).toBe('conciliación mensual');
  });

  it('gives nothing for a page with no text', () => {
    expect(ocrTextToMarkdown(' \n\n \n')).toBe('');
  });
});
