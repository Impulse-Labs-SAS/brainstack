import { describe, expect, it } from 'vitest';

import { matchWikilinkCandidates, type WikilinkCandidate } from './wikilink-autocomplete-match';

const candidates: WikilinkCandidate[] = [
  { path: 'Proyectos/erebor.md', title: 'Erebor' },
  { path: 'Proyectos/ereboride.md', title: 'Ereboride' },
  { path: 'Inbox/otra-cosa.md', title: 'Otra Cosa' },
];

describe('matchWikilinkCandidates', () => {
  it('returns every candidate, alphabetical, for an empty query', () => {
    const result = matchWikilinkCandidates(candidates, '');
    expect(result.map((r) => r.title)).toEqual(['Erebor', 'Ereboride', 'Otra Cosa']);
  });

  it('ranks an exact title match above a mere prefix match', () => {
    const result = matchWikilinkCandidates(candidates, 'erebor');
    expect(result.map((r) => r.title)).toEqual(['Erebor', 'Ereboride']);
  });

  it('matches a substring when no prefix matches', () => {
    const result = matchWikilinkCandidates(candidates, 'cosa');
    expect(result.map((r) => r.title)).toEqual(['Otra Cosa']);
  });

  it('is case-insensitive', () => {
    expect(matchWikilinkCandidates(candidates, 'EREBOR').map((r) => r.title)).toEqual([
      'Erebor',
      'Ereboride',
    ]);
  });

  it('excludes a candidate that matches nothing', () => {
    expect(matchWikilinkCandidates(candidates, 'xyzzy')).toEqual([]);
  });

  it('strips .md from insertTarget', () => {
    const [hit] = matchWikilinkCandidates(candidates, 'erebor');
    expect(hit!.insertTarget).toBe('Proyectos/erebor');
  });

  it('respects the limit', () => {
    expect(matchWikilinkCandidates(candidates, '', 2)).toHaveLength(2);
  });
});
