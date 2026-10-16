// How long a note may grow when an assistant writes it.
//
// An assistant reads notes into a context window that every note it reads
// shares. A note past the length Sentinel hands over whole comes back cut: the
// assistant either works from part of it or spends another call, and another
// slice of its context, opening the rest. So the limit is that length — a note
// within it always reaches an assistant whole — and an assistant that would
// write past it is told to split the note instead.
//
// A ratchet, not a wall: a note already past the limit (written by a person, or
// before the limit existed) can still be edited as long as the edit does not
// make it longer. That keeps every small fix possible, and makes splitting —
// moving sections out into notes of their own — the only way such a note grows.
//
// Measured on the body, line breaks folded to LF: the frontmatter is metadata,
// and a CRLF note is not longer than the same note saved elsewhere.

/**
 * Characters a note's body may hold when an assistant writes it — about a
 * thousand words. A crawl hands a note this long over whole (score.ts sets its
 * seed excerpt to it).
 */
export const NOTE_MAX_CHARS = 6_000;

export interface NoteSize {
  chars: number;
  lines: number;
}

export function noteSize(body: string): NoteSize {
  const text = body.replace(/\r\n/g, '\n').trim();
  return { chars: text.length, lines: text === '' ? 0 : text.split('\n').length };
}

/**
 * Whether an assistant may leave a note at `after`, coming from `before`
 * (absent for a note it creates): within the limit, or no longer than it was.
 */
export function fitsNoteLimit(after: NoteSize, before?: NoteSize, max = NOTE_MAX_CHARS): boolean {
  return after.chars <= max || (before !== undefined && after.chars <= before.chars);
}
