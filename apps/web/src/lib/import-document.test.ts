import { describe, expect, it } from 'vitest';

import {
  MAX_DOCUMENT_BYTES,
  htmlToMarkdown,
  documentKind,
  documentProblem,
  looksScanned,
  pdfToMarkdown,
  type HtmlNode,
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

  it('carries a paragraph over a page break unless it ended a sentence', () => {
    expect(pdfToMarkdown([[line('one.', 100)], [], [line('two', 700)]])).toBe('one.\n\ntwo');
    expect(pdfToMarkdown([[line('cut in the', 100)], [line('middle.', 700)]])).toBe(
      'cut in the middle.',
    );
    expect(pdfToMarkdown([[], []])).toBe('');
  });
});

/** A tiny DOM, enough for the conversion: elements and text. */
const el = (
  name: string,
  kids: Array<HtmlNode | string> = [],
  attrs: Record<string, string> = {},
): HtmlNode => ({
  nodeType: 1,
  nodeName: name.toUpperCase(),
  textContent: null,
  childNodes: kids.map((k) =>
    typeof k === 'string' ? { nodeType: 3, nodeName: '#text', textContent: k, childNodes: [] } : k,
  ),
  getAttribute: (n) => attrs[n] ?? null,
});

describe('htmlToMarkdown', () => {
  it('turns headings, paragraphs, lists, tables and emphasis into Markdown', () => {
    const body = el('body', [
      el('h1', [el('a', [], { id: '_x' }), 'Atlas']),
      el('p', [
        'Plain ',
        el('strong', ['bold']),
        ' and ',
        el('em', ['italic']),
        '. ',
        el('img', [], { src: '' }),
      ]),
      el('ul', [el('li', ['One', el('ul', [el('li', ['Nested'])])]), el('li', ['Two'])]),
      el('ol', [el('li', ['First']), el('li', ['Second'])]),
      el('table', [
        el('tr', [el('td', [el('p', ['Phase'])]), el('td', [el('p', ['Weeks'])])]),
        el('tr', [el('td', [el('p', ['A|B'])]), el('td', [el('p', ['4'])])]),
      ]),
      el('p', [
        el('a', ['site'], { href: 'https://example.com' }),
        ' ',
        el('a', ['local'], { href: 'javascript:x' }),
      ]),
    ]);
    expect(htmlToMarkdown(body)).toBe(
      [
        '# Atlas',
        'Plain **bold** and _italic_.',
        '- One\n  - Nested\n- Two',
        '1. First\n2. Second',
        '| Phase | Weeks |\n| --- | --- |\n| A\\|B | 4 |',
        '[site](https://example.com) local',
      ].join('\n\n'),
    );
  });
});

describe('looksScanned', () => {
  const text = 'El sistema registra cada movimiento y lo concilia con el libro mayor.';
  it('flags a file with almost no letters or numbers', () => {
    expect(looksScanned({ markdown: '1\n\n2\n\n---' })).toBe(true);
    expect(looksScanned({ markdown: text })).toBe(false);
  });

  it('flags a PDF whose pages hold almost no text, like a scan with a typed cover', () => {
    expect(looksScanned({ markdown: text, pages: 10 })).toBe(true);
    expect(looksScanned({ markdown: text, pages: 1 })).toBe(false);
  });
});
