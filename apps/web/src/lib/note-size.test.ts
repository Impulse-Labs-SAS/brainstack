import { describe, expect, it } from 'vitest';

import { noteSize, shortCount, sizeLevel } from './note-size';

describe('note size', () => {
  it('measures the body the way the server does', () => {
    expect(noteSize('a\r\nb\r\n\r\n')).toEqual({ chars: 3, lines: 2 });
    expect(noteSize('')).toEqual({ chars: 0, lines: 0 });
  });

  it('grades how full a note is', () => {
    expect(sizeLevel(4_000, 6_000)).toBe('ok');
    expect(sizeLevel(4_800, 6_000)).toBe('near');
    expect(sizeLevel(6_000, 6_000)).toBe('near');
    expect(sizeLevel(6_001, 6_000)).toBe('over');
  });

  it('shortens counts for the bar', () => {
    expect(shortCount(950)).toBe('950');
    expect(shortCount(4_820)).toBe('4.8k');
    expect(shortCount(6_000)).toBe('6k');
    expect(shortCount(12_400)).toBe('12k');
  });
});
