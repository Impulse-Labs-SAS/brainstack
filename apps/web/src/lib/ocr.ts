// Reading a scanned PDF with OCR, in the browser.
//
// A scanned PDF is pictures of pages, with no text for pdf.js to read. Here
// each page is drawn to a canvas and read by tesseract.js, in Spanish and
// English. All of it runs on the person's machine: the file never leaves it,
// and the server — which on a free serverless plan stops a request after ten
// seconds — does nothing more than for any other import.
//
// Loaded only when a scan is detected and the person asks for OCR: the worker,
// its WebAssembly core and the language data are about 9 MB, served by
// BrainStack itself from /ocr (scripts/copy-ocr-assets.mjs), never from a CDN.

import { joinLine, loadPdfjs } from './import-document';

/** Pages read at most: OCR takes seconds a page, more on a phone. */
export const MAX_OCR_PAGES = 30;

/** How large a page is drawn before it is read: small print needs about 300 dpi. */
const RENDER_SCALE = 2.5;

export interface OcrProgress {
  page: number;
  pages: number;
}

export interface OcrResult {
  markdown: string;
  /** Pages read, at most `MAX_OCR_PAGES`. */
  pagesRead: number;
  /** Pages the PDF has. */
  pages: number;
}

export async function ocrPdf(
  file: File,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  const [pdfjs, { createWorker, OEM }] = await Promise.all([loadPdfjs(), import('tesseract.js')]);
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false })
    .promise;
  const worker = await createWorker(['spa', 'eng'], OEM.LSTM_ONLY, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr',
    langPath: '/ocr',
    // A blob: worker is script from no origin, which the app's CSP refuses.
    workerBlobURL: false,
    gzip: true,
  });
  try {
    const pagesRead = Math.min(doc.numPages, MAX_OCR_PAGES);
    const pages: string[] = [];
    for (let i = 1; i <= pagesRead; i++) {
      onProgress?.({ page: i, pages: pagesRead });
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      const { data } = await worker.recognize(canvas);
      pages.push(ocrTextToMarkdown(data.text));
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
    return { markdown: pages.filter((p) => p !== '').join('\n\n'), pagesRead, pages: doc.numPages };
  } finally {
    await worker.terminate();
    await doc.destroy();
  }
}

/**
 * Tesseract's text as Markdown paragraphs: it breaks every printed line and
 * marks paragraphs with a blank line, so the lines of a paragraph are joined
 * again — a word hyphenated at the end of a line made whole.
 */
export function ocrTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .reduce(joinLine, ''),
    )
    .filter((p) => p !== '')
    .join('\n\n');
}
