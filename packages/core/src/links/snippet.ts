// The sentence a link sits in, so a backlink can say *how* a note is cited,
// not only that it is. Pure string logic over a stored body and the offset
// the parser recorded for the link (`links.position`).

/** List bullets, heading hashes, quote markers and task boxes opening a line. */
const LINE_MARKER = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)+/;

/**
 * The line holding the link that starts at `position`, without its leading
 * markdown markers and trimmed to about `max` characters around the link.
 *
 * The link's own `[[...]]` stays in the text: a client renders it, and that
 * is what lets it highlight the link that points back at the note.
 */
export function linkSnippet(body: string, position: number, max = 180): string {
  if (position < 0 || position >= body.length) return '';
  const lineStart = body.lastIndexOf('\n', position - 1) + 1;
  const nl = body.indexOf('\n', position);
  const lineEnd = nl === -1 ? body.length : nl;

  const closing = body.indexOf(']]', position);
  const linkEnd = closing === -1 || closing > lineEnd ? position : closing + 2;

  const raw = body.slice(lineStart, lineEnd);
  const marker = raw.match(LINE_MARKER)?.[0].length ?? 0;
  let from = lineStart + marker;
  let to = lineEnd;

  if (to - from > max) {
    // Keep the link whole and spend what is left evenly on both sides.
    const spare = Math.max(0, max - (linkEnd - position));
    from = Math.max(from, position - Math.floor(spare / 2));
    to = Math.min(to, Math.max(linkEnd, from + max));
  }

  const text = body.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > lineStart + marker ? '…' : ''}${text}${to < lineEnd ? '…' : ''}`;
}
