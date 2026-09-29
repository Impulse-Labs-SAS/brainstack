import { describe, expect, it } from 'vitest';

import { splitSnippet } from './search-snippet';

describe('splitSnippet', () => {
  it('splits marked matches from the text around them', () => {
    expect(splitSnippet('a <mark>b</mark> c <mark>d</mark>')).toEqual([
      { text: 'a ', marked: false },
      { text: 'b', marked: true },
      { text: ' c ', marked: false },
      { text: 'd', marked: true },
    ]);
  });

  it('returns plain text untouched', () => {
    expect(splitSnippet('no matches')).toEqual([{ text: 'no matches', marked: false }]);
    expect(splitSnippet('')).toEqual([]);
  });

  it('keeps HTML in the note as text, never as markup', () => {
    const parts = splitSnippet('<img src=x onerror=alert(1)> <mark>hit</mark>');
    expect(parts[0]).toEqual({ text: '<img src=x onerror=alert(1)> ', marked: false });
    expect(parts[1]).toEqual({ text: 'hit', marked: true });
  });
});
