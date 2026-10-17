import { describe, expect, it } from 'vitest';

import { graphStyle } from './graph-style';

describe('graphStyle', () => {
  it('is classic unless asked otherwise', () => {
    expect(graphStyle('', null)).toBe('classic');
    expect(graphStyle('?notes=400', undefined)).toBe('classic');
  });

  it('takes the query string over what was stored', () => {
    expect(graphStyle('?style=lineart', 'classic')).toBe('lineart');
    expect(graphStyle('?style=classic', 'lineart')).toBe('classic');
    expect(graphStyle('?notes=400&style=lineart', null)).toBe('lineart');
  });

  it('falls back to what was stored when the query names no style it knows', () => {
    expect(graphStyle('', 'lineart')).toBe('lineart');
    expect(graphStyle('?style=neon', 'lineart')).toBe('lineart');
    expect(graphStyle('?style=', 'lineart')).toBe('lineart');
  });

  it('ignores a stored value that is not a style', () => {
    expect(graphStyle('', 'neon')).toBe('classic');
    expect(graphStyle('', 42)).toBe('classic');
    expect(graphStyle('', { style: 'lineart' })).toBe('classic');
  });
});
