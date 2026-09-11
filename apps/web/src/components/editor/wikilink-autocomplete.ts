// CM6 extension: typing `[[` opens a note picker; accepting a suggestion
// inserts `[[Path]]`. Matching itself lives in
// lib/wikilink-autocomplete-match.ts (pure, tested without a CM instance) —
// this file only owns trigger detection and the insert.

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { matchWikilinkCandidates, type WikilinkCandidate } from '@/lib/wikilink-autocomplete-match';

/** Matches an unclosed `[[query` right before the cursor. */
const TRIGGER_RE = /\[\[([^[\]\n]*)$/;

function wikilinkSource(candidates: () => readonly WikilinkCandidate[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(TRIGGER_RE);
    if (!match) return null;
    // Require an explicit request once the query is empty (just typed `[[`),
    // otherwise every keystroke elsewhere in the document would be scanned
    // against this regex for no reason.
    const query = TRIGGER_RE.exec(match.text)?.[1] ?? '';
    if (query === '' && !context.explicit) return null;

    const hits = matchWikilinkCandidates(candidates(), query);
    if (hits.length === 0) return null;

    const from = match.to - query.length;
    return {
      from,
      options: hits.map((hit) => ({
        label: hit.title,
        detail: hit.path,
        apply: `${hit.insertTarget}]]`,
      })),
      // A closing `]]` may already follow the cursor (the editor's own
      // bracket-match, or the user typed both) — don't duplicate it.
      filter: false,
    };
  };
}

/**
 * `candidates` is a function rather than a plain array so the extension can
 * be built once and still see a freshly-fetched note list on every
 * completion — the tree changes as notes are created while the editor stays
 * mounted.
 */
export function wikilinkAutocomplete(candidates: () => readonly WikilinkCandidate[]): Extension {
  return autocompletion({ override: [wikilinkSource(candidates)] });
}
