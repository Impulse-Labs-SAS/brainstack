import { describe, expect, it } from 'vitest';

import {
  buildIndex,
  resolveAttachmentTarget,
  resolveEmbed,
  resolveNoteTarget,
  type TreeNodeLike,
} from './wikilinks-client';

const tree: TreeNodeLike = {
  path: '',
  type: 'folder',
  children: [
    { path: 'Proyectos', type: 'folder', children: [
      { path: 'Proyectos/nota.md', type: 'note' },
      { path: 'Proyectos/imagen.png', type: 'attachment' },
    ] },
    { path: 'Inbox', type: 'folder', children: [{ path: 'Inbox/origen.md', type: 'note' }] },
  ],
};

const idx = buildIndex(tree);

describe('resolveNoteTarget', () => {
  it('resolves a bare target', () => {
    expect(resolveNoteTarget('nota', 'Proyectos/otra.md', idx)).toBe('Proyectos/nota.md');
  });

  it('resolves identically whether or not a #Section is appended', () => {
    // This is the bug fixed alongside this test: `[[Nota#Sección]]` indexed
    // correctly on the server but always rendered as a broken link here,
    // because this function used to match the raw string (including the
    // "#Sección" suffix) against the tree index.
    const withoutSection = resolveNoteTarget('nota', 'Proyectos/otra.md', idx);
    const withSection = resolveNoteTarget('nota#Sección', 'Proyectos/otra.md', idx);
    expect(withSection).toBe(withoutSection);
  });

  it('returns null for an unresolved target', () => {
    expect(resolveNoteTarget('no-existe', 'Proyectos/otra.md', idx)).toBeNull();
  });
});

describe('resolveAttachmentTarget', () => {
  it('resolves by exact path and ignores a trailing #section', () => {
    expect(resolveAttachmentTarget('Proyectos/imagen.png', idx)).toBe('Proyectos/imagen.png');
    expect(resolveAttachmentTarget('Proyectos/imagen.png#foo', idx)).toBe('Proyectos/imagen.png');
  });
});

describe('resolveEmbed', () => {
  it('classifies a sectioned note embed as a note, not by a garbled extension', () => {
    const result = resolveEmbed('nota#Sección', 'Proyectos/otra.md', idx);
    expect(result).toEqual({ kind: 'note', path: 'Proyectos/nota.md' });
  });
});
