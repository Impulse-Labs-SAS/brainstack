/**
 * `decodeURI`, but a malformed escape (`[[%C0]]`) comes back as written
 * instead of throwing. Thrown while rendering a note's preview, it took the
 * whole view down — and anyone who can write in a shared folder could put one
 * in a note.
 */
export function safeDecodeURI(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
