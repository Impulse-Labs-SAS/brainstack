// A note's size as the server measures it for the limit an assistant's writes
// keep to (`packages/core/src/sentinel/size.ts`): the body, line breaks folded
// to LF, surrounding whitespace left out. The limit itself comes with the note
// from the server, so the two cannot drift; only this measure is repeated here,
// to keep `@brainstack/core` out of the web bundle.

export interface NoteSize {
  chars: number;
  lines: number;
}

export function noteSize(body: string): NoteSize {
  // Code points, only spaces, tabs and line breaks trimmed: as the server counts.
  const text = body.replace(/\r\n/g, '\n').replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
  return { chars: [...text].length, lines: text === '' ? 0 : text.split('\n').length };
}

/** How full a note is: under 80% `ok`, then `near`, and past the limit `over`. */
export function sizeLevel(chars: number, max: number): 'ok' | 'near' | 'over' {
  if (chars > max) return 'over';
  return chars >= max * 0.8 ? 'near' : 'ok';
}

/** "4.8k" for a person glancing at the bar; exact numbers go in the tooltip. */
export function shortCount(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}

/** The body of a note as the editor holds it, frontmatter block and all. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const after = content.slice(end + 4);
  return after.startsWith('\n') ? after.slice(1) : after;
}
