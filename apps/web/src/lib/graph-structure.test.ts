import { describe, expect, it } from 'vitest';

import { isIndexNote, isStructureEdge } from './graph-structure';

describe('isIndexNote', () => {
  it('recognises a MOC by its leading underscore', () => {
    expect(isIndexNote('Frodo/ideas/_ideas.md')).toBe(true);
    expect(isIndexNote('_Raiz.md')).toBe(true);
  });

  it('does not match an underscore elsewhere in the path', () => {
    expect(isIndexNote('Frodo/_borradores/nota.md')).toBe(false);
    expect(isIndexNote('Frodo/mi_nota.md')).toBe(false);
  });
});

describe('isStructureEdge', () => {
  it('is structural when either end is an index', () => {
    expect(isStructureEdge('Frodo/_Frodo.md', 'Frodo/test.md')).toBe(true);
    expect(isStructureEdge('Frodo/test.md', 'Frodo/_Frodo.md')).toBe(true);
    expect(isStructureEdge('Frodo/a.md', 'Uncuyo/b.md')).toBe(false);
  });
});
