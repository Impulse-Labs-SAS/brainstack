import { describe, expect, it } from 'vitest';

import { crawlContext } from './crawl.js';
import { applyEdits, listSections, NoteEditError, outline, type NoteEdit } from './edit.js';
import { fitsNoteLimit, NOTE_MAX_CHARS, noteSize } from './size.js';

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

  it('finds a section by the start of its heading, in any case and without accents', () => {
    const note = '# Orbit\n## Estado actual — próximo paso\nhoy\n## Riesgos\nr\n';
    expect(body(note, { op: 'append', section: 'Estado actual', text: 'mañana' })).toBe(
      '# Orbit\n## Estado actual — próximo paso\nhoy\nmañana\n## Riesgos\nr\n',
    );
    expect(body(note, { op: 'prepend', section: '## ESTADO actual', text: 'x' })).toContain(
      '## Estado actual — próximo paso\nx\nhoy\n',
    );
    expect(
      body('## Próximos pasos\na\n', { op: 'append', section: 'proximos pasos', text: 'b' }),
    ).toBe('## Próximos pasos\na\nb\n');
  });

  it('prefers the heading that reads exactly so over one that starts with it', () => {
    expect(
      body('## Notas\na\n## Notas viejas\nb\n', { op: 'append', section: 'notas', text: 'c' }),
    ).toBe('## Notas\na\nc\n## Notas viejas\nb\n');
  });

  it('refuses a start that ends mid-word or that several headings share', () => {
    expect(() => body('## Estado\na\n', { op: 'append', section: 'Esta', text: 'x' })).toThrow(
      /no section "Esta"; its sections are "Estado"/,
    );
    expect(() =>
      body('## Plan Q1\na\n## Plan Q2\nb\n', { op: 'append', section: 'Plan', text: 'x' }),
    ).toThrow(/no section "Plan", and 2 start with it: "Plan Q1", "Plan Q2"; name the one/);
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
        headingLines: async (paths) => paths.map((path) => ({ path, lines: long })),
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

describe('edge cases', () => {
  it('finds sections and passages in a CRLF note, and keeps its line breaks', () => {
    const crlf = '# T\r\n\r\n## Notes\r\n- a\r\n\r\n## Refs\r\n';
    expect(outline(crlf)).toEqual(['# T', '## Notes', '## Refs']);
    expect(body(crlf, { op: 'append', section: 'Notes', text: '- b' })).toBe(
      '# T\r\n\r\n## Notes\r\n- a\r\n- b\r\n\r\n## Refs\r\n',
    );
    expect(body(crlf, { op: 'replace', find: '- a\n\n## Refs', replace: '## Refs' })).toBe(
      '# T\r\n\r\n## Notes\r\n## Refs\r\n',
    );
  });

  it('keeps a prepended paragraph apart when its text ends in an empty line', () => {
    expect(body('old para\n', { op: 'prepend', text: 'Intro\n\n' })).toBe('Intro\n\nold para\n');
    expect(body('## S\ntext\n', { op: 'prepend', section: 'S', text: 'First\n\n' })).toBe(
      '## S\nFirst\n\ntext\n',
    );
  });

  it('appends to a section at the very end of a note with no final line break', () => {
    expect(body('# T\n## Last\nx', { op: 'append', section: 'Last', text: 'y' })).toBe(
      '# T\n## Last\nx\ny\n',
    );
  });

  it('appends to a parent section after its subsections', () => {
    expect(body('## A\na\n### A1\nb\n## B\n', { op: 'append', section: 'A', text: 'c' })).toBe(
      '## A\na\n### A1\nb\nc\n## B\n',
    );
  });

  it('refuses an append with nothing to add', () => {
    expect(() => body('a\n', { op: 'append', text: '\n\n' })).toThrow(/no text to add/);
  });

  it('stores a key called __proto__ as a key', () => {
    const out = applyEdits({ frontmatter: {}, body: '' }, [
      {
        op: 'set_frontmatter',
        values: JSON.parse('{"__proto__": "x"}') as Record<string, unknown>,
      },
    ]);
    expect(Object.keys(out.frontmatter)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out.frontmatter)).toBe(Object.prototype);
  });
});

describe('the note size limit', () => {
  it('measures the body on LF, trimmed', () => {
    expect(noteSize('a\r\nb\r\n\r\n')).toEqual({ chars: 3, lines: 2 });
    expect(noteSize('  \n')).toEqual({ chars: 0, lines: 0 });
  });

  it('lets a note grow up to the limit, and one past it only shrink', () => {
    const size = (chars: number) => ({ chars, lines: 1 });
    expect(fitsNoteLimit(size(NOTE_MAX_CHARS))).toBe(true);
    expect(fitsNoteLimit(size(NOTE_MAX_CHARS + 1))).toBe(false);
    expect(fitsNoteLimit(size(9_000), size(10_000))).toBe(true);
    expect(fitsNoteLimit(size(10_000), size(10_000))).toBe(true);
    expect(fitsNoteLimit(size(10_001), size(10_000))).toBe(false);
  });
});

describe('the note size, counted as Postgres counts it', () => {
  it('counts an emoji once and trims only spaces, tabs and line breaks', () => {
    expect(noteSize('😀😀')).toEqual({ chars: 2, lines: 1 });
    expect(noteSize(' x ')).toEqual({ chars: 3, lines: 1 });
  });
});
