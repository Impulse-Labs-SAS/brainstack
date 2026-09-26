import { describe, expect, it } from 'vitest';

import { isIndexNote, isStructureEdge } from './graph-structure';

describe('isIndexNote', () => {
  it('recognises a MOC by its leading underscore', () => {
    expect(isIndexNote('Pablo/ideas/_ideas.md')).toBe(true);
    expect(isIndexNote('_Raiz.md')).toBe(true);
  });

  it('does not match an underscore elsewhere in the path', () => {
    expect(isIndexNote('Pablo/_borradores/nota.md')).toBe(false);
    expect(isIndexNote('Pablo/mi_nota.md')).toBe(false);
  });
});

describe('isStructureEdge', () => {
  it('is structural when either end is an index', () => {
    expect(isStructureEdge('Pablo/_Pablo.md', 'Pablo/test.md')).toBe(true);
    expect(isStructureEdge('Pablo/test.md', 'Pablo/_Pablo.md')).toBe(true);
    expect(isStructureEdge('Pablo/a.md', 'Uncuyo/b.md')).toBe(false);
  });
});
