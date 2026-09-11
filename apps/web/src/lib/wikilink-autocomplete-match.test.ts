import { describe, expect, it } from 'vitest';

import { matchWikilinkCandidates, type WikilinkCandidate } from './wikilink-autocomplete-match';

const candidates: WikilinkCandidate[] = [
  { path: 'Proyectos/zuno.md', title: 'Zuno' },
  { path: 'Proyectos/zunoide.md', title: 'Zunoide' },
  { path: 'Inbox/otra-cosa.md', title: 'Otra Cosa' },
];

describe('matchWikilinkCandidates', () => {
  it('returns every candidate, alphabetical, for an empty query', () => {
    const result = matchWikilinkCandidates(candidates, '');
    expect(result.map((r) => r.title)).toEqual(['Otra Cosa', 'Zuno', 'Zunoide']);
  });

  it('ranks an exact title match above a mere prefix match', () => {
    const result = matchWikilinkCandidates(candidates, 'zuno');
    expect(result.map((r) => r.title)).toEqual(['Zuno', 'Zunoide']);
  });

  it('matches a substring when no prefix matches', () => {
    const result = matchWikilinkCandidates(candidates, 'cosa');
    expect(result.map((r) => r.title)).toEqual(['Otra Cosa']);
  });

  it('is case-insensitive', () => {
    expect(matchWikilinkCandidates(candidates, 'ZUNO').map((r) => r.title)).toEqual([
      'Zuno',
      'Zunoide',
    ]);
  });

  it('excludes a candidate that matches nothing', () => {
    expect(matchWikilinkCandidates(candidates, 'xyzzy')).toEqual([]);
  });

  it('strips .md from insertTarget', () => {
    const [hit] = matchWikilinkCandidates(candidates, 'zuno');
    expect(hit!.insertTarget).toBe('Proyectos/zuno');
  });

  it('respects the limit', () => {
    expect(matchWikilinkCandidates(candidates, '', 2)).toHaveLength(2);
  });
});
