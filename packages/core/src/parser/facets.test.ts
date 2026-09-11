import { describe, expect, it } from 'vitest';

import { extractFacets, FACET_SKIP_KEYS } from './facets.js';

describe('extractFacets', () => {
  it('skips tags — it has its own pipeline', () => {
    expect(FACET_SKIP_KEYS.has('tags')).toBe(true);
    expect(extractFacets({ tags: ['proyecto/zuno'] })).toEqual([]);
  });

  it('gives one facet per element of an array of strings', () => {
    expect(extractFacets({ technologies: ['nextjs', 'drizzle'] })).toEqual([
      { key: 'technologies', value: 'nextjs', data: null, position: 0 },
      { key: 'technologies', value: 'drizzle', data: null, position: 1 },
    ]);
  });

  it('gives one facet per element of an array of objects, preferring value > name > title > url', () => {
    expect(
      extractFacets({
        resources: [
          { value: 'has-value' },
          { name: 'has-name' },
          { title: 'has-title' },
          { url: 'has-url' },
          { other: 'no display field' },
        ],
      }),
    ).toEqual([
      { key: 'resources', value: 'has-value', data: { value: 'has-value' }, position: 0 },
      { key: 'resources', value: 'has-name', data: { name: 'has-name' }, position: 1 },
      { key: 'resources', value: 'has-title', data: { title: 'has-title' }, position: 2 },
      { key: 'resources', value: 'has-url', data: { url: 'has-url' }, position: 3 },
      {
        key: 'resources',
        value: JSON.stringify({ other: 'no display field' }),
        data: { other: 'no display field' },
        position: 4,
      },
    ]);
  });

  it('gives a single facet for a scalar field', () => {
    expect(extractFacets({ status: 'decidido' })).toEqual([
      { key: 'status', value: 'decidido', data: null, position: 0 },
    ]);
    expect(extractFacets({ priority: 3 })).toEqual([
      { key: 'priority', value: '3', data: null, position: 0 },
    ]);
    expect(extractFacets({ archived: false })).toEqual([
      { key: 'archived', value: 'false', data: null, position: 0 },
    ]);
  });

  it('skips null, undefined and blank-string entries', () => {
    expect(extractFacets({ ignored: null })).toEqual([]);
    expect(extractFacets({ ignored: undefined })).toEqual([]);
    expect(extractFacets({ list: ['', '  ', 'real'] })).toEqual([
      { key: 'list', value: 'real', data: null, position: 0 },
    ]);
  });

  it('extracts from several fields at once, each keyed separately', () => {
    const result = extractFacets({
      tags: ['ignored'],
      status: 'decidido',
      technologies: ['nextjs'],
    });
    expect(result.map((f) => f.key).sort()).toEqual(['status', 'technologies']);
  });
});
