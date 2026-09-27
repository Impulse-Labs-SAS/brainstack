import { describe, expect, it } from 'vitest';

import { linkSnippet } from './snippet.js';

describe('linkSnippet', () => {
  it('returns the line holding the link, without its list marker', () => {
    const body = '# Atlas\n\n- Decisiones técnicas en [[Atlas/arquitectura|Arquitectura]].\n- Otra';
    const at = body.indexOf('[[');
    expect(linkSnippet(body, at)).toBe('Decisiones técnicas en [[Atlas/arquitectura|Arquitectura]].');
  });

  it('strips headings, quotes and task boxes', () => {
    expect(linkSnippet('## See [[A]]', 7)).toBe('See [[A]]');
    expect(linkSnippet('> quoted [[A]]', 9)).toBe('quoted [[A]]');
    expect(linkSnippet('- [x] done with [[A]]', 16)).toBe('done with [[A]]');
  });

  it('trims a long line around the link and keeps the link whole', () => {
    const before = 'word '.repeat(60);
    const after = ' more'.repeat(60);
    const body = `${before}[[Target note]]${after}`;
    const snip = linkSnippet(body, before.length, 80);
    expect(snip).toContain('[[Target note]]');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip.length).toBeLessThanOrEqual(84);
  });

  it('returns an empty string for an offset outside the body', () => {
    expect(linkSnippet('short', 99)).toBe('');
  });
});
