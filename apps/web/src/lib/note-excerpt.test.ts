import { describe, expect, it } from 'vitest';

import { excerpt } from './note-excerpt';

describe('excerpt', () => {
  it('drops a leading title, which is shown already, even after frontmatter’s blank line', () => {
    expect(excerpt('# Atlas design\nThe brief for the design.')).toBe('The brief for the design.');
    expect(excerpt('\n# Atlas design\nThe brief for the design.')).toBe(
      'The brief for the design.',
    );
  });

  it('keeps a heading further down, as text', () => {
    expect(excerpt('Intro line.\n## Scope\nWhat is in.')).toBe('Intro line. Scope What is in.');
  });

  it('reads wikilinks as their text and strips the markdown around them', () => {
    expect(excerpt('See [[Orbit/plan|the plan]] and [[Ledger]], **now**.\n- one\n> two')).toBe(
      'See the plan and Ledger, now. one two',
    );
  });

  it('cuts at the length asked for', () => {
    expect(excerpt('a'.repeat(400))).toHaveLength(260);
    expect(excerpt('a'.repeat(400), 40)).toHaveLength(40);
  });
});
