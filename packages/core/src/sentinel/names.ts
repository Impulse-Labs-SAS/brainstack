// Which notes a piece of text names — by `[[link]]`, by title or by alias —
// and which references it makes that no single note settles. Shared by the
// crawl (crawl.ts) and the search (search.ts), so both read a text the same
// way.

import {
  findMentions,
  foldForMatch,
  indexMentionTerms,
  type MentionTerm,
} from '../links/mentions.js';
import { buildCodeMask } from '../parser/code-mask.js';
import { extractLinks } from '../parser/wikilinks.js';
import { resolveLink } from '../resolver/wikilinks.js';

import type { UnresolvedReference } from './crawl.js';

const AMBIGUOUS = '\u0000ambiguous:';

export const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/** The words of a phrase, folded. */
export function foldedWords(phrase: string): string[] {
  return phrase.split(WORD_BREAK).map(foldForMatch).filter(Boolean);
}

export interface Names {
  /** The notes the text names, with what it said and how often. */
  named: Map<string, { text: string; count: number }>;
  /** References no single note settles: no match, or several notes could be meant. */
  unresolved: UnresolvedReference[];
  /** Every reference the text made, settled or not, folded: not searched for again. */
  settledTerms: Set<string>;
  /** Notes a reference could mean but nobody chose: asked about, never handed over as if chosen. */
  undecided: Set<string>;
  /** Every word of what the text named, folded. */
  namedWords: Set<string>;
}

/** Resolve what `text` names against `index`, the titles and aliases of every note. */
export function resolveNames(
  text: string,
  index: ReadonlyArray<{ path: string; title: string; aliases: unknown[] }>,
): Names {
  const titleOf = new Map(index.map((n) => [n.path, n.title]));
  const title = (path: string) => titleOf.get(path) ?? path;

  // -- Seeds: what the text links to ----------------------------------------
  // `[[Note]]` is the plainest way a prompt can point at a note, and the one
  // mention matching skips on purpose (it never looks inside a link). So links
  // are resolved the way the vault resolves them, from the root.
  const named = new Map<string, { text: string; count: number }>();
  const unresolved: UnresolvedReference[] = [];
  const settledTerms = new Set<string>();
  const nameSeed = (path: string, said: string) => {
    const entry = named.get(path) ?? { text: said, count: 0 };
    entry.count += 1;
    named.set(path, entry);
    settledTerms.add(foldForMatch(said));
  };

  const noteIndex = new Set(index.map((n) => n.path));
  const linkCtx = { sourcePath: 'prompt.md', noteIndex, attachmentIndex: new Set<string>() };
  const linkSeen = new Set<string>();
  for (const link of extractLinks(text, buildCodeMask(text))) {
    const said = link.alias ?? link.rawTarget;
    const resolved = resolveLink(link, linkCtx);
    if (resolved.targetType === 'note' && !resolved.ambiguous) {
      nameSeed(resolved.targetPath, said);
      continue;
    }
    if (resolved.targetType === 'attachment') continue;
    const key = foldForMatch(link.rawTarget);
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    settledTerms.add(foldForMatch(said));
    unresolved.push(
      resolved.ambiguous
        ? {
            term: said,
            reason: 'ambiguous',
            candidates: resolved.candidates
              .filter((p) => noteIndex.has(p))
              .map((path) => ({ path, title: title(path) })),
          }
        : { term: said, reason: 'no-match' },
    );
  }

  // -- Seeds: what the text names --------------------------------------------
  const { terms: mentionTerms, ambiguous } = indexMentionTerms(
    index.map((n) => ({ target: n.path, title: n.title, aliases: n.aliases })),
  );
  // Ambiguous terms are matched alongside the others, not after them, so that
  // the longer of two overlapping titles still wins whichever kind it is.
  const searchable: MentionTerm[] = [
    ...mentionTerms,
    ...ambiguous.map((a, i) => ({ target: `${AMBIGUOUS}${i}`, term: a.term })),
  ];
  const ambiguousSeen = new Set<number>();
  /** Notes a reference could mean but nobody chose: asked about, never handed over as if chosen. */
  const undecided = new Set<string>();
  for (const u of unresolved) for (const c of u.candidates ?? []) undecided.add(c.path);
  for (const m of findMentions(withoutCodeMarkers(text), searchable)) {
    if (!m.target.startsWith(AMBIGUOUS)) {
      nameSeed(m.target, m.text);
      continue;
    }
    const i = Number(m.target.slice(AMBIGUOUS.length));
    if (ambiguousSeen.has(i)) continue;
    ambiguousSeen.add(i);
    settledTerms.add(foldForMatch(m.text));
    ambiguous[i]!.targets.forEach((path) => undecided.add(path));
    unresolved.push({
      term: m.text,
      reason: 'ambiguous',
      candidates: ambiguous[i]!.targets.map((path) => ({ path, title: title(path) })),
    });
  }
  const namedWords = new Set([...named.values()].flatMap(({ text: said }) => foldedWords(said)));
  return { named, unresolved, settledTerms, undecided, namedWords };
}

/**
 * `phrase` without the words the text resolved to a note, or `phrase` itself
 * when it has none of them. Empty when it is made of nothing else.
 */
export function withoutNamed(phrase: string, namedWords: ReadonlySet<string>): string {
  const words = phrase.split(WORD_BREAK).filter(Boolean);
  const kept = words.filter((w) => !namedWords.has(foldForMatch(w)));
  return kept.length === words.length ? phrase : kept.join(' ');
}

/**
 * The text with backticks and fence lines removed. A prompt that writes
 * `Billing service` in code is still naming the note; mention matching would
 * skip it, because in a note body code is where a name must never be linked.
 */
function withoutCodeMarkers(text: string): string {
  return text.replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, '').replace(/`/g, ' ');
}
