// The text a document arrives as: tidied, and checked that there is any.
//
// A scanned PDF has no text layer. Read in a browser, or by an assistant that
// does not look at the page images, it comes back empty or nearly so — a page
// number per page, a stray header. Imported as it is, that is a folder of empty
// notes that look like a document. So the text is weighed first, and a
// document with too little is refused as one that needs OCR.

import { DocumentImportError } from './errors.js';

/** Letters and digits below which a text is not a document's text. */
export const MIN_TEXT_CHARS = 50;

/**
 * Letters and digits per kilobyte of the original file below which it reads as
 * a scan: a page of text is a few thousand of them in a few kilobytes of PDF,
 * while a scanned page is hundreds of kilobytes of image with a page number.
 */
export const MIN_CHARS_PER_KB = 0.2;

/** Line endings folded to LF, control characters dropped, trailing blanks and runs of blank lines removed. */
export function normalizeText(markdown: string): string {
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

/** Letters and digits in a text, in any script. */
export function countWordChars(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/**
 * Throws `EMPTY_TEXT` when the text has too little in it to be the document:
 * fewer than `MIN_TEXT_CHARS` letters and digits, or — when the size of the file
 * it came from is known — fewer than `MIN_CHARS_PER_KB` per kilobyte of it.
 */
export function assertHasText(text: string, fileBytes?: number): void {
  const chars = countWordChars(text);
  const sparse =
    fileBytes !== undefined && fileBytes > 0 && chars / (fileBytes / 1024) < MIN_CHARS_PER_KB;
  if (chars >= MIN_TEXT_CHARS && !sparse) return;
  throw new DocumentImportError(
    `the document has almost no text (${chars} letters and digits${fileBytes ? ` in ${Math.round(fileBytes / 1024)} KB` : ''}): ` +
      'it looks like a scan, which needs OCR. If you can read the page images, transcribe them and send that text; ' +
      'otherwise tell the user the document needs OCR before it can be saved',
    'EMPTY_TEXT',
  );
}
