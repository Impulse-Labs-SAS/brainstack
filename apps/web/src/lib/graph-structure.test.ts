import { describe, expect, it } from 'vitest';

import { assignFolderGroups, isIndexNote, isStructureEdge, topFolderOf } from './graph-structure';

describe('topFolderOf', () => {
  it('returns the first segment, or empty at the root', () => {
    expect(topFolderOf('Pablo/ideas/concepto.md')).toBe('Pablo');
    expect(topFolderOf('suelta.md')).toBe('');
  });
});

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

describe('assignFolderGroups', () => {
  const node = (path: string, foreign = false) => ({ path, foreign });

  it('gives the largest folders a slot each, largest first', () => {
    const groups = assignFolderGroups([
      node('Uncuyo/a.md'),
      node('Uncuyo/b.md'),
      node('Pablo/a.md'),
      node('Uncuyo/c.md'),
      node('Pablo/b.md'),
      node('Zuno/a.md'),
    ]);
    expect(groups).toEqual([
      { folder: 'Uncuyo', count: 3, slot: 0 },
      { folder: 'Pablo', count: 2, slot: 1 },
      { folder: 'Zuno', count: 1, slot: 2 },
    ]);
  });

  it('folds folders past the slot count into none', () => {
    const groups = assignFolderGroups([node('A/x.md'), node('B/x.md'), node('C/x.md')], 2);
    expect(groups.map((g) => g.slot)).toEqual([0, 1, null]);
  });

  it('breaks ties by name, so the same vault paints the same way', () => {
    const groups = assignFolderGroups([node('Beta/x.md'), node('Alfa/x.md')]);
    expect(groups.map((g) => g.folder)).toEqual(['Alfa', 'Beta']);
  });

  it('never colours the vault root, and leaves the slot for a real folder', () => {
    const groups = assignFolderGroups([node('a.md'), node('b.md'), node('Pablo/x.md')], 1);
    expect(groups).toEqual([
      { folder: '', count: 2, slot: null },
      { folder: 'Pablo', count: 1, slot: 0 },
    ]);
  });

  it("ignores somebody else's notes", () => {
    expect(assignFolderGroups([node('Suya/x.md', true)])).toEqual([]);
  });
});
