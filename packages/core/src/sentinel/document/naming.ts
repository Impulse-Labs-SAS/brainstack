// What the notes of an imported document are called.
//
// A split document lives in a folder named after it, so its parts do not repeat
// the document's name: a part is `NN - <Name>.md`, NN its place in reading
// order. Its frontmatter `title` is `<Document> — <Name>`, which is what search
// and mentions show, so two documents' "01 - Introducción" never read alike.
//
// A part's name, in order of precedence:
// 1. It continues a section that was opened: `<Section> (cont.)`.
// 2. The highest-level heading in it (the first, among several of that level),
//    leaving out the document's title.
// 3. "Introducción": the text under the document's title, or before any heading.
//
// The numbering a heading carries ("2. ", "II. ", "2) ") is left out of the
// name: NN already orders the parts, and a part that groups sections 1 and 2
// would otherwise read "01 - 1. ..." next to "02 - 3. ...". The heading keeps
// it in the note itself. Only a number followed by `.` or `)` and a space is
// numbering, so "2026 en números" and "Iglesia" stay as they are.

import type { Heading } from './outline.js';
import type { Part } from './partition.js';

/** Characters of a document title kept in a note or folder name. */
export const MAX_TITLE_CHARS = 80;
/** Characters of a heading kept in a part's name. */
export const MAX_HEADING_CHARS = 60;

export const INTRODUCTION = 'Introducción';
export const CONTINUED = '(cont.)';

/** Words that do not tell two titles apart. */
const FILLER = new Set([
  'a',
  'al',
  'and',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'of',
  'the',
  'un',
  'una',
  'y',
]);

/**
 * A name a note path and a wikilink can both hold: no folder separators, none
 * of the characters a wikilink reads as syntax (`[ ] | # ^`), none that Windows
 * refuses in a file name — a vault is exported to disk — and no leading dot.
 */
export function cleanName(raw: string, max: number): string {
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

/** The title a file name gives: its basename, without extension or anything a path or a link cannot hold. */
export function documentTitle(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return cleanName(base.replace(/\.[A-Za-z0-9]{1,8}$/, ''), MAX_TITLE_CHARS);
}

/** A heading without the numbering it starts with: "2. Puntos" → "Puntos", "II. Intro" → "Intro". */
export function stripNumbering(heading: string): string {
  const stripped = heading.replace(/^(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)]\s+/, '').trim();
  return stripped === '' ? heading.trim() : stripped;
}

/** A title reduced to what tells it apart: lower case, no accents or punctuation, no filler words. */
export function comparable(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !FILLER.has(w))
    .join(' ');
}

/** Whether two titles say the same thing, ignoring case, accents, punctuation and filler words. */
export function sameTitle(a: string, b: string): boolean {
  const ca = comparable(a);
  return ca !== '' && ca === comparable(b);
}

/**
 * Which headings are the document's own title: one that reads like the file's
 * title, or the document's only level-1 heading when it opens the document —
 * a file called "scan_0042.pdf" still has its real title on its first line.
 */
export function titleMatcher(title: string, headings: readonly Heading[]): (h: Heading) => boolean {
  const first = headings[0];
  const opening =
    first?.level === 1 && headings.filter((h) => h.level === 1).length === 1 ? first : undefined;
  return (h) => h === opening || sameTitle(h.text, stripNumbering(title));
}

/** A part's name, before its number. */
export function partName(part: Part, isTitle: (h: Heading) => boolean): string {
  if (part.continues) return `${headingName(part.continues)} ${CONTINUED}`;
  const candidates = part.headings.filter((h) => !isTitle(h));
  if (candidates.length === 0) return INTRODUCTION;
  const top = Math.min(...candidates.map((h) => h.level));
  return headingName(candidates.find((h) => h.level === top)!);
}

function headingName(heading: Heading): string {
  return cleanName(stripNumbering(heading.text), MAX_HEADING_CHARS) || INTRODUCTION;
}

/** `NN - <Name>`, NN zero-padded to the width the count needs, two at least. */
export function partFileName(index: number, count: number, name: string): string {
  const width = Math.max(2, String(count).length);
  return `${String(index + 1).padStart(width, '0')} - ${name}`;
}

/** The frontmatter title of a part: the document's and the part's, so it reads alone. */
export function partTitle(document: string, name: string): string {
  return `${document} — ${name}`;
}
