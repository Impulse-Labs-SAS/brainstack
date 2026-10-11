import { describe, expect, it } from 'vitest';

import { safeDecodeURI } from './safe-decode';

describe('safeDecodeURI', () => {
  it('decodes what decodes', () => {
    expect(safeDecodeURI('Atlas%20plan')).toBe('Atlas plan');
    expect(safeDecodeURI('caf%C3%A9')).toBe('café');
  });

  it('gives a malformed escape back as written instead of throwing', () => {
    expect(safeDecodeURI('%C0')).toBe('%C0');
    expect(safeDecodeURI('%E0%A4')).toBe('%E0%A4');
  });
});
