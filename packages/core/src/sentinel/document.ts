// Importing a document — a PDF, a Word file, plain text — as notes.
//
// A file the assistant cannot read is weight in the vault and nothing else: it
// is not searched, not crawled, not cited. So a document comes in as its text,
// already turned into Markdown by whoever read the file (the web app does it in
// the browser, so the file itself never travels), and this decides what notes
// that text becomes. The original file is not kept.
//
// One note when the text fits the length a crawl hands over whole
// (`NOTE_MAX_CHARS`). Past it, the document gets a folder of its own: an index
// note named like the folder (`_<Title>.md`, the vault's convention for a
// folder's index) that links every part, and the parts, cut at the document's
// own headings and packed up to that length, each linking back to the index.
// The headings are where the author already split it, so a part reads as a
// section rather than as a page that starts mid-sentence. A section longer than
// a note is cut at paragraphs, then at lines, then — a wall of text with no
// breaks at all — at the length itself.
//
// The paths are picked here too: a document never lands on a note that
// already exists. When the name is taken, the next free `Title (2)`, `(3)`…
// is used, asked of the store through `DocumentLookup`.
//
// Pure: no store, no permission. The server answers the lookup, checks the
// caller may write in the folder, and writes what this returns.

import { NOTE_MAX_CHARS, noteSize } from './size.js';

/** Notes one document may become, index included. Past it, import the part you need. */
export const MAX_IMPORT_NOTES = 60;

/** Where a document imported at the root of a vault goes. */
export const DEFAULT_IMPORT_FOLDER = 'Documentos';

/** Characters of a document title kept in a note name. */
const MAX_TITLE_CHARS = 80;
/** Characters of a heading kept in a part's name. */
const MAX_HEADING_CHARS = 60;
/** `Title (2)` … `Title (MAX_SUFFIX)`, tried in order when the name is taken. */
const MAX_SUFFIX = 20;

export class DocumentImportError extends Error {
  override readonly name = 'DocumentImportError';
  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'ALREADY_EXISTS' | 'TOO_LONG',
  ) {
    super(message);
  }
}

export interface DocumentImportInput {
  /** The document's text, as Markdown. */
  markdown: string;
  /** The file's name, as the person picked it. Gives the title and the `source` of every note. */
  fileName: string;
  /** The folder it was imported into; '' is the vault's root. */
  folder: string;
  /** Overrides the title taken from the file name. */
  title?: string;
}

/** What the planner asks of the store. */
export interface DocumentLookup {
  /** Which of these paths already hold a note, in the vault the document goes to. One call per name tried. */
  existing(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ImportedNote {
  path: string;
  content: string;
  frontmatter: { source: string };
}

export interface DocumentImportPlan {
  /** The title the notes are named after, `(2)`… included when the first was taken. */
  title: string;
  /** Where the document's notes live: its own folder when it is split, else the folder it was imported into. */
  folder: string;
  /** The note to open first: the index of a split document, or its only note. */
  entry: string;
  /** In writing order: the parts first, the index last. */
  notes: ImportedNote[];
}

/** The title a file name gives: its basename, without extension or anything a path or a link cannot hold. */
export function documentTitle(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return cleanName(base.replace(/\.[A-Za-z0-9]{1,8}$/, ''), MAX_TITLE_CHARS);
}

export async function planDocumentImport(
  input: DocumentImportInput,
  lookup: DocumentLookup,
  maxChars = NOTE_MAX_CHARS,
): Promise<DocumentImportPlan> {
  const text = normalizeText(input.markdown);
  if (noteSize(text).chars === 0) {
    throw new DocumentImportError(
      'the document has no text to import (a scanned PDF needs OCR, which BrainStack does not do)',
      'INVALID_INPUT',
    );
  }
  const title =
    input.title !== undefined
      ? cleanName(input.title, MAX_TITLE_CHARS)
      : documentTitle(input.fileName);
  if (title === '') {
    throw new DocumentImportError(
      `no note name can be made from ${JSON.stringify(input.fileName)}`,
      'INVALID_INPUT',
    );
  }
  const base = trimSlashes(input.folder) || DEFAULT_IMPORT_FOLDER;
  const source = input.fileName.split(/[\\/]/).pop() ?? input.fileName;

  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? title : `${title} (${n})`;
    const plan = layout(text, name, base, source, maxChars);
    const taken = await lookup.existing(plan.notes.map((note) => note.path));
    if (!plan.notes.some((note) => taken.has(note.path))) return plan;
  }
  throw new DocumentImportError(
    `${base}/${title} and ${MAX_SUFFIX - 1} numbered copies already exist; rename the file and import it again`,
    'ALREADY_EXISTS',
  );
}

function layout(
  text: string,
  title: string,
  base: string,
  source: string,
  maxChars: number,
): DocumentImportPlan {
  const frontmatter = { source };
  if (noteSize(text).chars <= maxChars) {
    const path = `${base}/${title}.md`;
    return {
      title,
      folder: base,
      entry: path,
      notes: [{ path, content: `${text}\n`, frontmatter }],
    };
  }

  const folder = `${base}/${title}`;
  const indexName = `_${title}`;
  const indexPath = `${folder}/${indexName}.md`;
  const footer = `## Refs\n\n- [[${folder}/${indexName}]]`;
  // What a part's body may hold, the blank line and the footer kept out of it.
  const budget = maxChars - noteSize(footer).chars - 2;
  const parts = pack(sections(text), budget);
  if (parts.length + 1 > MAX_IMPORT_NOTES) {
    throw new DocumentImportError(
      `the document would become ${parts.length + 1} notes, more than the ${MAX_IMPORT_NOTES} one import may create; ` +
        'import only the part you need',
      'TOO_LONG',
    );
  }

  const width = String(parts.length).length < 2 ? 2 : String(parts.length).length;
  const notes = parts.map((part, i) => {
    const number = String(i + 1).padStart(width, '0');
    const heading = part.heading ? cleanName(part.heading, MAX_HEADING_CHARS) : '';
    const name = heading ? `${title} ${number} - ${heading}` : `${title} ${number}`;
    return {
      name,
      path: `${folder}/${name}.md`,
      content: `${part.text}\n\n${footer}\n`,
      frontmatter,
    };
  });
  const index =
    `# ${title}\n\n` +
    `Imported from \`${source.replace(/`/g, "'")}\`, split into ${notes.length} notes in reading order.\n\n` +
    `## Notas\n\n${notes.map((n) => `- [[${n.name}]]`).join('\n')}\n`;
  return {
    title,
    folder,
    entry: indexPath,
    notes: [
      ...notes.map(({ path, content }) => ({ path, content, frontmatter })),
      { path: indexPath, content: index, frontmatter },
    ],
  };
}

interface Chunk {
  /** The heading the chunk sits under, when the document has one above it. */
  heading?: string;
  text: string;
}

/**
 * The document cut at its headings (levels 1 to 3), outside code fences, and
 * every piece longer than a note cut again until it fits.
 */
function sections(text: string): Chunk[] {
  const out: Chunk[] = [];
  let current: string[] = [];
  let heading: string | undefined;
  let fence: string | null = null;
  const flush = () => {
    const body = current.join('\n').trim();
    if (body) out.push({ ...(heading !== undefined ? { heading } : {}), text: body });
    current = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) fence = fence === null ? marker : fence === marker ? null : fence;
    const h = fence === null && !marker ? /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush();
      heading = h[1]!;
    }
    current.push(line);
  }
  flush();
  return out;
}

/**
 * Chunks packed in order into parts of at most `budget` characters. A chunk
 * that alone is longer is cut first, at paragraphs, lines, or the length.
 */
function pack(chunks: Chunk[], budget: number): Chunk[] {
  const pieces = chunks.flatMap((c) => cut(c, budget));
  const parts: Chunk[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last && noteSize(`${last.text}\n\n${piece.text}`).chars <= budget) {
      last.text = `${last.text}\n\n${piece.text}`;
    } else {
      parts.push({ ...piece });
    }
  }
  return parts;
}

function cut(chunk: Chunk, budget: number): Chunk[] {
  if (noteSize(chunk.text).chars <= budget) return [chunk];
  const at = (text: string): Chunk => ({
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    text,
  });
  for (const separator of ['\n\n', '\n']) {
    const units = chunk.text.split(separator).filter((u) => u.trim() !== '');
    if (units.length < 2) continue;
    const joined: string[] = [];
    for (const unit of units) {
      const last = joined.at(-1);
      if (last !== undefined && noteSize(`${last}${separator}${unit}`).chars <= budget) {
        joined[joined.length - 1] = `${last}${separator}${unit}`;
      } else {
        joined.push(unit);
      }
    }
    return joined.flatMap((t) => cut(at(t.trim()), budget));
  }
  // No break left to cut at: cut at the length, in code points, so a
  // character outside the BMP is never split in half.
  const points = [...chunk.text];
  const out: Chunk[] = [];
  for (let i = 0; i < points.length; i += budget)
    out.push(
      at(
        points
          .slice(i, i + budget)
          .join('')
          .trim(),
      ),
    );
  return out.filter((c) => c.text !== '');
}

function normalizeText(markdown: string): string {
  return (
    markdown
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- control characters are what is removed
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * A name a note path and a wikilink can both hold: no folder separators, none
 * of the characters a wikilink reads as syntax (`[ ] | # ^`), none that
 * Windows refuses in a file name — a vault is exported to disk — and no
 * leading dot.
 */
function cleanName(raw: string, max: number): string {
  const clean = raw
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/[\]|#^:*?"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  const points = [...clean];
  return (points.length > max ? points.slice(0, max).join('') : clean).replace(/[.\s]+$/, '');
}

function trimSlashes(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '');
}
