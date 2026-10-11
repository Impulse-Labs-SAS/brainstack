import { describe, expect, it } from 'vitest';

import { issueUrl } from './bug-report';

describe('issueUrl', () => {
  it('fills in a new issue on the public tracker, and nothing about any note', () => {
    const url = new URL(
      issueUrl({
        kind: 'bug',
        summary: 'Moving a folder lost its notes',
        details: 'Dragged it onto another folder.',
        area: '/notes',
        userAgent: 'TestBrowser/1.0',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://github.com/Impulse-Labs-SAS/brainstack/issues/new',
    );
    expect(url.searchParams.get('title')).toBe('Bug: Moving a folder lost its notes');
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('Dragged it onto another folder.');
    expect(body).toContain('Area: /notes');
    expect(body).toContain('Browser: TestBrowser/1.0');
  });
});
