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
// section rather than as a page that starts mid-sentence.
//
// The steps live apart, each testable on its own: `document/text.ts` tidies
// the text and refuses one with too little in it (a scan), `document/outline.ts`
// reads its headings as a tree, `document/partition.ts` decides where it is cut,
// and `document/naming.ts` what each note is called. This file puts them
// together and picks paths that are free.
//
// The paths are picked here too: a document never lands on a note that
// already exists. When the name is taken, the next free `Title (2)`, `(3)`…
// is used, asked of the store through `DocumentLookup`.
//
// Pure: no store, no permission. The server answers the lookup, checks the
// caller may write in the folder, and writes what this returns.

import { NOTE_MAX_CHARS, noteSize } from './size.js';
import { DocumentImportError } from './document/errors.js';
import {
  MAX_TITLE_CHARS,
  cleanName,
  documentTitle,
  partFileName,
  partName,
  partTitle,
  titleMatcher,
} from './document/naming.js';
import { parseOutline, sectionHeadings } from './document/outline.js';
import { partition } from './document/partition.js';
import { assertHasText, normalizeText } from './document/text.js';

export { DocumentImportError } from './document/errors.js';
export { documentTitle } from './document/naming.js';

/** Notes one document may become, index included. Past it, import the part you need. */
export const MAX_IMPORT_NOTES = 60;

/** Where a document imported at the root of a vault goes. */
export const DEFAULT_IMPORT_FOLDER = 'Documentos';

/** `Title (2)` … `Title (MAX_SUFFIX)`, tried in order when the name is taken. */
const MAX_SUFFIX = 20;

export interface DocumentImportInput {
  /** The document's text, as Markdown. */
  markdown: string;
  /** The file's name, as the person picked it. Gives the title and the `source` of every note. */
  fileName: string;
  /** The folder it was imported into; '' is the vault's root. */
  folder: string;
  /** Overrides the title taken from the file name. */
  title?: string;
  /** Size of the original file, when known: a lot of file with little text in it is a scan. */
  fileBytes?: number;
}

/** What the planner asks of the store. */
export interface DocumentLookup {
  /** Which of these paths already hold a note, in the vault the document goes to. One call per name tried. */
  existing(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ImportedNote {
  path: string;
  content: string;
  frontmatter: { source: string; title: string };
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

export async function planDocumentImport(
  input: DocumentImportInput,
  lookup: DocumentLookup,
  maxChars = NOTE_MAX_CHARS,
): Promise<DocumentImportPlan> {
  const text = normalizeText(input.markdown);
  assertHasText(text, input.fileBytes);
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
  if (noteSize(text).chars <= maxChars) {
    const path = `${base}/${title}.md`;
    return {
      title,
      folder: base,
      entry: path,
      notes: [{ path, content: `${text}\n`, frontmatter: { source, title } }],
    };
  }

  const folder = `${base}/${title}`;
  const indexName = `_${title}`;
  const indexPath = `${folder}/${indexName}.md`;
  const footer = `## Refs\n\n- [[${folder}/${indexName}]]`;
  // What a part's body may hold, the blank line and the footer kept out of it.
  const budget = maxChars - noteSize(footer).chars - 2;
  const outline = parseOutline(text);
  const isTitle = titleMatcher(title, outline.flatMap(sectionHeadings));
  const parts = partition(outline, budget, isTitle);
  if (parts.length + 1 > MAX_IMPORT_NOTES) {
    throw new DocumentImportError(
      `the document would become ${parts.length + 1} notes, more than the ${MAX_IMPORT_NOTES} one import may create; ` +
        'import only the part you need',
      'TOO_LONG',
    );
  }

  const notes = parts.map((part, i) => {
    const name = partName(part, isTitle);
    const file = partFileName(i, parts.length, name);
    return {
      file,
      path: `${folder}/${file}.md`,
      content: `${part.text}\n\n${footer}\n`,
      frontmatter: { source, title: partTitle(title, name) },
    };
  });
  // The index sits in the parts' folder, where a bare link resolves first:
  // `[[01 - Introducción]]` finds this document's part, not another's.
  const index =
    `# ${title}\n\n` +
    `Imported from \`${source.replace(/`/g, "'")}\`, split into ${notes.length} notes in reading order.\n\n` +
    `## Notas\n\n${notes.map((n) => `- [[${n.file}]]`).join('\n')}\n`;
  return {
    title,
    folder,
    entry: indexPath,
    notes: [
      ...notes.map(({ path, content, frontmatter }) => ({ path, content, frontmatter })),
      { path: indexPath, content: index, frontmatter: { source, title } },
    ],
  };
}

function trimSlashes(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '');
}
