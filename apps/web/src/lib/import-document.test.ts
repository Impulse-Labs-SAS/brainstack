import { describe, expect, it } from 'vitest';

import {
  MAX_DOCUMENT_BYTES,
  cleanDocxMarkdown,
  documentKind,
  documentProblem,
  pdfToMarkdown,
  type PdfRun,
} from './import-document';

/** One line of a page: its runs, the last one ending the line. */
const line = (text: string, y: number, size = 10): PdfRun => ({ text, y, size, eol: true });

describe('documentKind and documentProblem', () => {
  it('reads PDF, Word and plain text, by extension', () => {
    expect(documentKind('a.PDF')).toBe('pdf');
    expect(documentKind('a.docx')).toBe('docx');
    expect(documentKind('a.csv')).toBe('text');
    expect(documentKind('a.xlsx')).toBeNull();
  });

  it('says why a file cannot be imported', () => {
    expect(documentProblem({ name: 'old.doc', size: 1 })).toMatch(/\.docx/);
    expect(documentProblem({ name: 'a.png', size: 1 })).toMatch(/not a PDF/);
    expect(documentProblem({ name: 'a.pdf', size: MAX_DOCUMENT_BYTES + 1 })).toMatch(/20 MB/);
    expect(documentProblem({ name: 'a.pdf', size: 1 })).toBeNull();
  });
});

describe('pdfToMarkdown', () => {
  it('reads headings from the font size and paragraphs from the gaps', () => {
    const page: PdfRun[] = [
      line('Orbit proposal', 800, 20),
      line('This is the first para-', 760),
      line('graph, over two lines.', 748),
      line('A second paragraph.', 720),
      line('Scope', 690, 13),
      { text: 'Two runs ', y: 670, size: 10, eol: false },
      { text: 'on one line.', y: 670, size: 10, eol: true },
    ];
    expect(pdfToMarkdown([page])).toBe(
      [
        '# Orbit proposal',
        'This is the first paragraph, over two lines.',
        'A second paragraph.',
        '## Scope',
        'Two runs on one line.',
      ].join('\n\n'),
    );
  });

  it('ends a paragraph at the end of a page, and gives nothing for a page with no text', () => {
    expect(pdfToMarkdown([[line('one', 100)], [], [line('two', 700)]])).toBe('one\n\ntwo');
    expect(pdfToMarkdown([[], []])).toBe('');
  });
});

describe('cleanDocxMarkdown', () => {
  it('drops images and anchors and undoes needless escapes', () => {
    expect(
      cleanDocxMarkdown(
        '# <a id="x"></a>Title\n\n\n\n![](data:image/png;base64,AAA)Ends here\\. Really \\(yes\\)',
      ),
    ).toBe('# Title\n\nEnds here. Really (yes)');
  });
});
