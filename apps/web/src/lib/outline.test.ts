import { describe, expect, it } from 'vitest';

import { extractOutline } from './outline';

describe('extractOutline', () => {
  it('lists h1 to h3 with their lines, and skips code fences', () => {
    const md = ['# Title', '', '## Data', '```', '## not a heading', '```', '### [[Atlas/x|Refs]]', '#### deep'].join('\n');
    expect(extractOutline(md)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Data', line: 3 },
      { level: 3, text: 'Refs', line: 7 },
    ]);
  });
});
