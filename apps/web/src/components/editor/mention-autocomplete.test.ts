import { describe, expect, it } from 'vitest';

import { matchMentionCandidates } from './mention-autocomplete';

const PEOPLE = [
  { username: 'ana', displayName: 'Ana Torres' },
  { username: 'pablo.g', displayName: 'Pablo Gómez' },
  { username: 'bot', displayName: null },
];

describe('matchMentionCandidates', () => {
  it('offers everyone for a bare @', () => {
    expect(matchMentionCandidates(PEOPLE, '')).toHaveLength(3);
  });

  it('matches the start of the username or of any word of the name', () => {
    expect(matchMentionCandidates(PEOPLE, 'pa').map((p) => p.username)).toEqual(['pablo.g']);
    expect(matchMentionCandidates(PEOPLE, 'tor').map((p) => p.username)).toEqual(['ana']);
    expect(matchMentionCandidates(PEOPLE, 'B').map((p) => p.username)).toEqual(['bot']);
  });
});
