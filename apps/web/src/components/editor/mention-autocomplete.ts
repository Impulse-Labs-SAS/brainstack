// CM6 completion source: typing `@` offers the people who can read this note,
// by username or name; accepting one inserts the username after the `@`.
// Whoever is mentioned hears about it from their own assistant (see the
// server's MentionService). Only readers are offered because nobody else
// would be told.

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

export interface MentionCandidate {
  username: string;
  displayName: string | null;
}

/**
 * An `@` that starts a word, and what has been typed after it. The same
 * boundary the server reads mentions with: not inside an email or a URL path.
 */
const TRIGGER_RE = /(?:^|[^\p{L}\p{N}_.@/\\-])@([a-z0-9_.-]*)$/iu;

const MAX_OPTIONS = 20;

export function matchMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter(
      (c) =>
        c.username.startsWith(q) ||
        (c.displayName ?? '')
          .toLowerCase()
          .split(/\s+/)
          .some((word) => word.startsWith(q)),
    )
    .slice(0, MAX_OPTIONS);
}

export function mentionSource(candidates: () => readonly MentionCandidate[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = TRIGGER_RE.exec(before);
    if (!match) return null;
    const query = match[1] ?? '';
    const hits = matchMentionCandidates(candidates(), query);
    if (hits.length === 0) return null;
    return {
      from: context.pos - query.length,
      options: hits.map((c) => ({
        label: `@${c.username}`,
        ...(c.displayName ? { detail: c.displayName } : {}),
        apply: `${c.username} `,
      })),
      filter: false,
    };
  };
}
