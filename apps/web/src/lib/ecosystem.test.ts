import { describe, expect, it } from 'vitest';

import { groupFacetsByKey, linkLabel } from './ecosystem';

describe('groupFacetsByKey', () => {
  it('groups by key in first-seen order, values in row order', () => {
    const rows = [
      { key: 'technologies', value: 'nextjs' },
      { key: 'status', value: 'decidido' },
      { key: 'technologies', value: 'drizzle' },
    ];
    expect(groupFacetsByKey(rows)).toEqual([
      { key: 'technologies', values: ['nextjs', 'drizzle'] },
      { key: 'status', values: ['decidido'] },
    ]);
  });

  it('returns an empty list for no rows', () => {
    expect(groupFacetsByKey([])).toEqual([]);
  });
});

describe('linkLabel', () => {
  it('prefers the alias when present', () => {
    expect(
      linkLabel({ targetPath: 'a.md', alias: 'Show me', sourcePath: 'b.md' }, 'in'),
    ).toBe('Show me');
  });

  it('falls back to sourcePath for an inbound link', () => {
    expect(linkLabel({ targetPath: 'a.md', alias: null, sourcePath: 'b.md' }, 'in')).toBe('b.md');
  });

  it('falls back to targetPath for an outbound link', () => {
    expect(linkLabel({ targetPath: 'a.md', alias: null }, 'out')).toBe('a.md');
  });
});
