// Helpers for ignoring code spans and fenced code blocks during extraction.
// We compute a boolean mask aligned with the body string: `true` means "inside
// code, skip extraction here". The mask is also used by the tag extractor.

const FENCE = /^(```+|~~~+)/;

export function buildCodeMask(body: string): Uint8Array {
  const mask = new Uint8Array(body.length);
  const lines = body.split('\n');

  let inFence = false;
  let fenceMarker = '';
  let offset = 0;

  for (const rawLine of lines) {
    const line = rawLine;
    const lineLen = line.length + 1; // +1 for the consumed '\n'

    const fenceMatch = FENCE.exec(line.trimStart());
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1] ?? '';
        markRange(mask, offset, offset + lineLen);
      } else if ((fenceMatch[1] ?? '').startsWith(fenceMarker[0] ?? '')) {
        markRange(mask, offset, offset + lineLen);
        inFence = false;
        fenceMarker = '';
      } else {
        markRange(mask, offset, offset + lineLen);
      }
      offset += lineLen;
      continue;
    }

    if (inFence) {
      markRange(mask, offset, offset + lineLen);
    } else {
      maskInlineCode(mask, line, offset);
    }
    offset += lineLen;
  }

  return mask;
}

function markRange(mask: Uint8Array, start: number, end: number): void {
  const stop = Math.min(end, mask.length);
  for (let i = Math.max(0, start); i < stop; i++) mask[i] = 1;
}

function maskInlineCode(mask: Uint8Array, line: string, base: number): void {
  // Find inline code runs delimited by matching backtick sequences.
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    const runStart = i;
    while (i < line.length && line[i] === '`') i++;
    const runLen = i - runStart;
    // Look for a matching closer of the same length.
    let search = i;
    let closer = -1;
    while (search < line.length) {
      if (line[search] === '`') {
        const endStart = search;
        while (search < line.length && line[search] === '`') search++;
        if (search - endStart === runLen) {
          closer = endStart;
          break;
        }
      } else {
        search++;
      }
    }
    if (closer === -1) {
      // Unbalanced — leave rest of line unmasked.
      return;
    }
    markRange(mask, base + runStart, base + search);
    i = search;
  }
}

export function isMasked(mask: Uint8Array, index: number): boolean {
  return mask[index] === 1;
}
