// Search snippets arrive with the matches wrapped in `<mark>…</mark>`
// (Postgres `ts_headline`, see packages/core/src/pg/search.ts). Everything
// else in them is note text, unescaped — `ts_headline` does not escape the
// document — so a snippet is never HTML to render. It is split here into text
// runs, and the caller draws the marked ones with React, which escapes the rest.

export interface SnippetPart {
  text: string;
  marked: boolean;
}

const MARK_RE = /<mark>([\s\S]*?)<\/mark>/g;

export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let last = 0;
  for (const match of snippet.matchAll(MARK_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push({ text: snippet.slice(last, idx), marked: false });
    if (match[1]) parts.push({ text: match[1], marked: true });
    last = idx + match[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), marked: false });
  return parts;
}
