import { describe, expect, it } from 'vitest';

import { crawlContext } from './crawl.js';
import { applyEdits, listSections, NoteEditError, outline, type NoteEdit } from './edit.js';

const MOC = [
  '# Orbit',
  '',
  'Intro.',
  '',
  '## Notas',
  '- [[orbit/a|A]]',
  '- [[orbit/b|B]]',
  '',
  '## Subcarpetas',
  '- [[orbit/x/_x|X]]',
  '',
].join('\n');

const body = (b: string, ...edits: NoteEdit[]) =>
  applyEdits({ frontmatter: {}, body: b }, edits).body;

describe('listSections', () => {
  it('ends a section at the next heading of the same or a higher level', () => {
    const sections = listSections('# T\n## A\ntext\n### A1\nmore\n## B\nend\n');
    expect(sections.map((s) => [s.heading, s.line, s.end])).toEqual([
      ['T', 0, 8],
      ['A', 1, 5],
      ['A1', 3, 5],
      ['B', 5, 8],
    ]);
  });

  it('skips headings inside fenced code', () => {
    expect(outline('## Real\n```sh\n# not a heading\n```\n')).toEqual(['## Real']);
  });
});

describe('applyEdits', () => {
  it('appends at the end of a section, before the blank line that closes it', () => {
    expect(body(MOC, { op: 'append', section: 'Notas', text: '- [[orbit/c|C]]' })).toBe(
      MOC.replace('- [[orbit/b|B]]\n', '- [[orbit/b|B]]\n- [[orbit/c|C]]\n'),
    );
  });

  it('accepts the section written as a heading, in any case', () => {
    const out = body(MOC, { op: 'append', section: '## notas', text: '- [[orbit/c|C]]' });
    expect(out).toContain('- [[orbit/b|B]]\n- [[orbit/c|C]]\n\n## Subcarpetas');
  });

  it('prepends right under a section heading', () => {
    expect(body(MOC, { op: 'prepend', section: 'Notas', text: '- [[orbit/z|Z]]' })).toContain(
      '## Notas\n- [[orbit/z|Z]]\n- [[orbit/a|A]]',
    );
  });

  it('appends to the end of the whole note without a section', () => {
    expect(body('one\n\n', { op: 'append', text: 'two' })).toBe('one\ntwo\n\n');
    expect(body('', { op: 'append', text: 'first' })).toBe('first\n');
  });

  it('replaces the one occurrence of a passage', () => {
    expect(body('a cat sat\n', { op: 'replace', find: 'cat', replace: 'dog' })).toBe('a dog sat\n');
    expect(body('keep\ndrop me\n', { op: 'replace', find: 'drop me\n', replace: '' })).toBe(
      'keep\n',
    );
  });

  it('refuses a passage that is missing or ambiguous', () => {
    expect(() => body('a\n', { op: 'replace', find: 'b', replace: 'c' })).toThrow(
      /not in the note/,
    );
    expect(() => body('a a\n', { op: 'replace', find: 'a', replace: 'c' })).toThrow(/2 times/);
  });

  it('refuses a missing section and names the ones there are', () => {
    expect(() => body(MOC, { op: 'append', section: 'Notes', text: 'x' })).toThrow(
      /no section "Notes"; its sections are "Orbit", "Notas", "Subcarpetas"/,
    );
  });

  it('refuses a section name two headings share', () => {
    expect(() => body('## A\n## A\n', { op: 'append', section: 'A', text: 'x' })).toThrow(
      /2 sections called "A"/,
    );
  });

  it('applies edits in order and says which one failed', () => {
    expect(
      body('x\n', { op: 'replace', find: 'x', replace: 'y' }, { op: 'append', text: 'z' }),
    ).toBe('y\nz\n');
    expect(() =>
      body(
        'x\n',
        { op: 'replace', find: 'x', replace: 'y' },
        { op: 'replace', find: 'x', replace: 'w' },
      ),
    ).toThrow(/\(edit 2\)/);
  });

  it('merges frontmatter and removes a key set to null', () => {
    const out = applyEdits({ frontmatter: { status: 'draft', tags: ['a'] }, body: 'b\n' }, [
      { op: 'set_frontmatter', values: { status: 'done', tags: null } },
    ]);
    expect(out).toEqual({ frontmatter: { status: 'done' }, body: 'b\n' });
  });

  it('throws NoteEditError, which the server reports to the caller', () => {
    expect(() => body('a\n', { op: 'replace', find: '', replace: 'x' })).toThrow(NoteEditError);
  });
});

describe('gather_context prepares the edit', () => {
  it('gives every note its checksum, and a cut one the headings past its excerpt', async () => {
    const long = `# Atlas\n\n## Intro\n${'word '.repeat(2000)}\n\n## Late section\nend\n`;
    const result = await crawlContext(
      {
        titles: async () => [
          { path: 'atlas.md', title: 'Atlas', aliases: [] },
          { path: 'ledger.md', title: 'Ledger', aliases: [] },
        ],
        links: async () => [],
        digests: async (paths, chars) =>
          paths.map((path) => ({
            path,
            title: path === 'atlas.md' ? 'Atlas' : 'Ledger',
            body: (path === 'atlas.md' ? long : '# Ledger\nshort\n').slice(0, chars),
            isDecision: false,
            checksum: `sum-${path}`,
          })),
        bodies: async (paths) => paths.map((path) => ({ path, body: long })),
        search: async () => [],
      },
      { text: 'Atlas and Ledger' },
    );
    const atlas = result.notes.find((n) => n.path === 'atlas.md')!;
    const ledger = result.notes.find((n) => n.path === 'ledger.md')!;
    expect(atlas).toMatchObject({ truncated: true, checksum: 'sum-atlas.md' });
    expect(atlas.sections).toEqual(['# Atlas', '## Intro', '## Late section']);
    expect(ledger).toMatchObject({ truncated: false, checksum: 'sum-ledger.md' });
    expect(ledger.sections).toBeUndefined();
  });
});
