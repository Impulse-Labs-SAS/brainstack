// Reading a PDF, a Word file or plain text in the browser, as Markdown.
//
// The file never leaves the browser: only its text goes to the server, where
// Sentinel decides what notes it becomes (`notes.importDocument`). That keeps a
// 20 MB PDF from ever meeting a request size or a function timeout, and
// keeps the vault free of files no assistant can read.
//
// The readers are loaded only when a document is picked, so nobody who never
// imports one downloads them. A scanned PDF has no text to read; it comes back
// empty and the server says so.

/** Largest file read, in bytes. Past it the browser slows down, on a phone first. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const DOCUMENT_EXT = /\.(pdf|docx|txt|csv)$/i;

export type DocumentKind = 'pdf' | 'docx' | 'text';

/** What kind of document a file is, by its name; null for anything this does not read. */
export function documentKind(fileName: string): DocumentKind | null {
  const ext = DOCUMENT_EXT.exec(fileName)?.[1]?.toLowerCase();
  if (!ext) return null;
  return ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'docx' : 'text';
}

/** Why a file cannot be imported before it is read, or null. */
export function documentProblem(file: { name: string; size: number }): string | null {
  if (/\.doc$/i.test(file.name)) return 'old .doc files cannot be read; save it as .docx';
  if (!documentKind(file.name)) return 'not a PDF, Word (.docx), .txt or .csv file';
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB; import only the part you need`;
  }
  return null;
}

/** The file's text as Markdown. */
export async function readDocument(file: File): Promise<string> {
  const kind = documentKind(file.name);
  if (kind === 'pdf') return readPdf(await file.arrayBuffer());
  if (kind === 'docx') return readDocx(await file.arrayBuffer());
  return file.text();
}

// -- PDF ----------------------------------------------------------------------

/** A run of text on a PDF page, reduced to what the conversion uses. */
export interface PdfRun {
  text: string;
  /** Font size, in page units. */
  size: number;
  /** Baseline height on the page; larger is higher up. */
  y: number;
  /** True when the run ends its line. */
  eol: boolean;
}

async function readPdf(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const pages: PdfRun[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const runs: PdfRun[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const [a, b, , , , f] = item.transform as number[];
        runs.push({
          text: item.str,
          size: Math.hypot(a ?? 0, b ?? 0) || item.height,
          y: f ?? 0,
          eol: item.hasEOL,
        });
      }
      pages.push(runs);
      page.cleanup();
    }
    return pdfToMarkdown(pages);
  } finally {
    await doc.destroy();
  }
}

interface Line {
  text: string;
  size: number;
  y: number;
}

/**
 * PDF text runs as Markdown. A PDF has no paragraphs or headings, only text
 * placed on a page, so they are read back from the layout: a line set in a
 * clearly larger font than the body is a heading, and a gap wider than the
 * usual line spacing ends a paragraph, as does the end of a page when the
 * paragraph ended a sentence there. Lines within a paragraph are joined,
 * a hyphen that broke a word at the end of a line rejoined.
 */
export function pdfToMarkdown(pages: PdfRun[][]): string {
  const pageLines = pages.map(toLines);
  const body = bodySize(pageLines.flat());
  const blocks: string[] = [];
  let paragraph = '';
  const end = () => {
    if (paragraph.trim()) blocks.push(paragraph.trim());
    paragraph = '';
  };
  for (const lines of pageLines) {
    let previous: Line | null = null;
    for (const line of lines) {
      const level = headingLevel(line, body);
      if (level) {
        end();
        blocks.push(`${'#'.repeat(level)} ${line.text.trim()}`);
        previous = null;
        continue;
      }
      const gap = previous ? previous.y - line.y : 0;
      if (previous && (gap > line.size * 1.8 || gap < 0)) end();
      paragraph = joinLine(paragraph, line.text);
      previous = line;
    }
    // A paragraph that did not end a sentence carries on over the page break.
    if (/[.!?:;)"»”]$/.test(paragraph.trim())) end();
  }
  end();
  return blocks.join('\n\n');
}

function toLines(runs: PdfRun[]): Line[] {
  const lines: Line[] = [];
  let text = '';
  let size = 0;
  let y: number | null = null;
  const end = () => {
    if (text.trim()) lines.push({ text: text.replace(/\s+/g, ' ').trim(), size, y: y ?? 0 });
    text = '';
    size = 0;
    y = null;
  };
  for (const run of runs) {
    // A run on another baseline starts another line even without an end-of-line mark.
    if (y !== null && Math.abs(run.y - y) > Math.max(run.size, size) * 0.5) end();
    if (run.text) {
      text += run.text;
      size = Math.max(size, run.size);
      y ??= run.y;
    }
    if (run.eol) end();
  }
  end();
  return lines;
}

/** The font size most of the text is set in, weighted by length. */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const size = Math.round(l.size * 2) / 2;
    weight.set(size, (weight.get(size) ?? 0) + l.text.length);
  }
  let best = 0;
  let most = -1;
  for (const [size, w] of weight) if (w > most) [best, most] = [size, w];
  return best;
}

function headingLevel(line: Line, body: number): 1 | 2 | 3 | null {
  if (body <= 0 || line.text.length > 120 || !/\p{L}/u.test(line.text)) return null;
  const ratio = line.size / body;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.3) return 2;
  if (ratio >= 1.15) return 3;
  return null;
}

function joinLine(paragraph: string, line: string): string {
  if (!paragraph) return line;
  if (/\p{L}-$/u.test(paragraph) && /^\p{Ll}/u.test(line)) return paragraph.slice(0, -1) + line;
  return `${paragraph} ${line}`;
}

// -- Word ---------------------------------------------------------------------

async function readDocx(data: ArrayBuffer): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      // A document's title is set in Word's Title style, not as a heading.
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
      // Images are left out: a note carries text, and an embedded image would
      // come back as a data URL many times longer than the document's words.
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    },
  );
  const body = new DOMParser().parseFromString(value, 'text/html').body;
  return htmlToMarkdown(body as unknown as HtmlNode);
}

/** The part of a DOM node the conversion reads, so it can be tested without a browser. */
export interface HtmlNode {
  /** 3 for text, 1 for an element. */
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?(name: string): string | null;
}

/**
 * The HTML Mammoth makes of a Word file, as Markdown: headings, paragraphs,
 * lists (nested ones indented), tables, bold, italics and web links. What a
 * note cannot carry — images, page layout — is left out.
 */
export function htmlToMarkdown(root: HtmlNode): string {
  return blocks(root, 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const children = (node: HtmlNode) => Array.from(node.childNodes);
const tag = (node: HtmlNode) => node.nodeName.toLowerCase();

function blocks(node: HtmlNode, depth: number): string[] {
  const out: string[] = [];
  for (const child of children(node)) {
    if (child.nodeType === 3) {
      const text = collapse(child.textContent ?? '');
      if (text.trim()) out.push(text.trim());
      continue;
    }
    if (child.nodeType !== 1) continue;
    const name = tag(child);
    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      const text = inline(child).trim();
      if (text) out.push(`${'#'.repeat(Number(heading[1]))} ${text.replace(/\n/g, ' ')}`);
    } else if (name === 'p') {
      const text = inline(child).trim();
      if (text) out.push(text);
    } else if (name === 'ul' || name === 'ol') {
      out.push(list(child, depth));
    } else if (name === 'table') {
      out.push(table(child));
    } else {
      out.push(...blocks(child, depth));
    }
  }
  return out.filter((b) => b !== '');
}

function list(node: HtmlNode, depth: number): string {
  const ordered = tag(node) === 'ol';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let n = 0;
  for (const li of children(node)) {
    if (li.nodeType !== 1 || tag(li) !== 'li') continue;
    n++;
    const nested: string[] = [];
    let text = '';
    for (const part of children(li)) {
      if (part.nodeType === 1 && (tag(part) === 'ul' || tag(part) === 'ol')) {
        nested.push(list(part, depth + 1));
      } else {
        text += part.nodeType === 3 ? collapse(part.textContent ?? '') : inline(part);
      }
    }
    lines.push(`${indent}${ordered ? `${n}.` : '-'} ${text.trim().replace(/\n/g, ' ')}`, ...nested);
  }
  return lines.join('\n');
}

function table(node: HtmlNode): string {
  const rows: string[][] = [];
  const walk = (n: HtmlNode) => {
    for (const child of children(n)) {
      if (child.nodeType !== 1) continue;
      if (tag(child) === 'tr') {
        rows.push(
          children(child)
            .filter((c) => c.nodeType === 1 && (tag(c) === 'td' || tag(c) === 'th'))
            .map((c) => blocks(c, 0).join(' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
        );
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const row = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [
    row(rows[0]!),
    row(Array.from({ length: width }, () => '---')),
    ...rows.slice(1).map(row),
  ].join('\n');
}

function inline(node: HtmlNode): string {
  let out = '';
  for (const child of children(node)) {
    if (child.nodeType === 3) {
      out += collapse(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== 1) continue;
    const name = tag(child);
    const inner = inline(child);
    if (name === 'br') out += '\n';
    else if (name === 'img') continue;
    else if ((name === 'strong' || name === 'b') && inner.trim()) out += `**${inner.trim()}**`;
    else if ((name === 'em' || name === 'i') && inner.trim()) out += `_${inner.trim()}_`;
    else if (name === 'a') {
      const href = child.getAttribute?.('href') ?? '';
      out += /^https?:\/\//i.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
    } else out += inner;
  }
  return out;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}
