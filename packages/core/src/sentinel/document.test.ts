import { describe, expect, it } from 'vitest';

import {
  DocumentImportError,
  MAX_IMPORT_NOTES,
  documentTitle,
  planDocumentImport,
  type DocumentLookup,
} from './document.js';
import { NOTE_MAX_CHARS, noteSize } from './size.js';

const none: DocumentLookup = { existing: async () => new Set() };
const taken = (...paths: string[]): DocumentLookup => ({
  existing: async (asked) => new Set(asked.filter((p) => paths.includes(p))),
});

/** A paragraph of about `chars` characters, with spaces so it reads as words. */
const para = (chars: number, word = 'ledger') =>
  Array.from({ length: Math.ceil(chars / (word.length + 1)) }, () => word)
    .join(' ')
    .slice(0, chars);

describe('documentTitle', () => {
  it('keeps the basename without its extension', () => {
    expect(documentTitle('C:\\docs\\Orbit proposal.pdf')).toBe('Orbit proposal');
    expect(documentTitle('../../etc/Atlas.docx')).toBe('Atlas');
  });

  it('drops what a path or a wikilink cannot hold', () => {
    expect(documentTitle('Q3 [draft] #2 | v1: final?.pdf')).toBe('Q3 draft 2 v1 final');
    expect(documentTitle('...hidden.txt')).toBe('hidden');
  });
});

describe('planDocumentImport', () => {
  it('makes a short document one note, in the folder it was imported into', async () => {
    const plan = await planDocumentImport(
      {
        markdown: '# Orbit\r\n\r\n\r\n\r\nShort text.  ',
        fileName: 'Orbit.pdf',
        folder: 'clients/',
      },
      none,
    );
    expect(plan.notes).toEqual([
      {
        path: 'clients/Orbit.md',
        content: '# Orbit\n\nShort text.\n',
        frontmatter: { source: 'Orbit.pdf' },
      },
    ]);
    expect(plan.entry).toBe('clients/Orbit.md');
  });

  it('puts a document imported at the root in Documentos', async () => {
    const plan = await planDocumentImport(
      { markdown: 'text', fileName: 'a.txt', folder: '' },
      none,
    );
    expect(plan.entry).toBe('Documentos/a.md');
  });

  it('splits a long document at its headings into a folder with an index', async () => {
    const markdown = [
      '# Erebor manual',
      '',
      para(200),
      '',
      '## Setup',
      '',
      para(4_000),
      '',
      '## Usage',
      '',
      para(4_000),
      '',
      '```',
      '## not a heading',
      '```',
    ].join('\n');
    const plan = await planDocumentImport(
      { markdown, fileName: 'Erebor.docx', folder: 'docs' },
      none,
    );

    expect(plan.folder).toBe('docs/Erebor');
    expect(plan.entry).toBe('docs/Erebor/_Erebor.md');
    expect(plan.notes.map((n) => n.path)).toEqual([
      'docs/Erebor/Erebor 01 - Erebor manual.md',
      'docs/Erebor/Erebor 02 - Usage.md',
      'docs/Erebor/_Erebor.md',
    ]);
    // Short sections are packed together, and the fenced line stays in its part.
    expect(plan.notes[0]!.content).toContain('## Setup');
    expect(plan.notes[1]!.content).toContain('## not a heading');
    for (const note of plan.notes.slice(0, -1)) {
      expect(noteSize(note.content).chars).toBeLessThanOrEqual(NOTE_MAX_CHARS);
      expect(note.content).toContain('## Refs\n\n- [[docs/Erebor/_Erebor]]');
    }
    const index = plan.notes.at(-1)!.content;
    expect(index).toContain('- [[Erebor 01 - Erebor manual]]\n- [[Erebor 02 - Usage]]');
    expect(index).toContain('Imported from `Erebor.docx`');
  });

  it('cuts a section longer than a note at paragraphs, and a wall of text at the length', async () => {
    const paragraphs = Array.from({ length: 6 }, () => para(2_500)).join('\n\n');
    const wall = 'x'.repeat(13_000);
    const plan = await planDocumentImport(
      {
        markdown: `## Long\n\n${paragraphs}\n\n## Wall\n\n${wall}`,
        fileName: 'Atlas.txt',
        folder: '',
      },
      none,
    );
    const parts = plan.notes.slice(0, -1);
    for (const note of parts) {
      expect(noteSize(note.content).chars).toBeLessThanOrEqual(NOTE_MAX_CHARS);
    }
    // Nothing is lost: every character of the wall is in some part.
    const xs = parts.map((n) => n.content.match(/x/g)?.length ?? 0).reduce((a, b) => a + b, 0);
    expect(xs).toBe(13_000);
    expect(parts.some((n) => n.path.includes(' - Wall'))).toBe(true);
  });

  it('picks the next free name when the first is taken', async () => {
    const plan = await planDocumentImport(
      { markdown: 'text', fileName: 'Orbit.pdf', folder: 'x' },
      taken('x/Orbit.md', 'x/Orbit (2).md'),
    );
    expect(plan.entry).toBe('x/Orbit (3).md');
    expect(plan.title).toBe('Orbit (3)');
  });

  it('refuses a document with no text', async () => {
    await expect(
      planDocumentImport({ markdown: ' \n\n ', fileName: 'scan.pdf', folder: '' }, none),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a document that would become too many notes', async () => {
    const markdown = Array.from(
      { length: MAX_IMPORT_NOTES + 5 },
      (_, i) => `## S${i}\n\n${para(5_500)}`,
    ).join('\n\n');
    const err = await planDocumentImport({ markdown, fileName: 'big.pdf', folder: '' }, none).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err.code).toBe('TOO_LONG');
  });
});
