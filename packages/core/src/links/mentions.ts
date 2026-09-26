// Unlinked mentions: a note's text naming another note — by its title or one
// of its `aliases` — without a wikilink. Finding them is how the graph grows
// real connections instead of drawing implied ones; linking them turns the
// plain text into `[[path|the text as written]]`, so the sentence reads the
// same and becomes an edge.
//
// Matching is on folded text (lower case, no diacritics): "vision" finds
// "Visión". It is whole-word — "zuno" does not match inside "zunoteca" — and
// it never looks inside code, inside an existing link, or inside a bare URL.
// When two terms overlap, the longer wins: "Seek & Destroy" over "Destroy".
//
// Pure string logic, like paths.ts: no store, no disk.

import { buildCodeMask } from '../parser/code-mask.js';

/** A title shorter than this matches too much ordinary prose to be a signal. */
export const MIN_MENTION_LENGTH = 4;

export interface MentionTerm {
  /** Whatever identifies the note the term names; handed back on each match. */
  target: string;
  /** The title or alias, as written. */
  term: string;
}

export interface Mention {
  target: string;
  term: string;
  /** Offsets in the original body; `end` is exclusive. */
  start: number;
  end: number;
  /** The body's own text at that spot, which may differ in case or accents. */
  text: string;
}

export interface MentionCandidate {
  target: string;
  title: string;
  aliases?: readonly unknown[];
}

const WIKILINK_RE = /!?\[\[[^\]\n]+\]\]/g;
const MARKDOWN_LINK_RE = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lower case, diacritics stripped. */
export function foldForMatch(text: string): string {
  return fold(text).folded;
}

/** Folded text plus, for each folded character, the index it came from. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const ch of piece) {
      folded += ch;
      origin.push(i);
    }
  }
  return { folded, origin };
}

/** Code, links and URLs: nowhere a mention may be found or rewritten. */
function blockedMask(body: string): Uint8Array {
  const mask = buildCodeMask(body);
  for (const re of [WIKILINK_RE, MARKDOWN_LINK_RE, URL_RE]) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      mask.fill(1, m.index, m.index + m[0].length);
    }
  }
  return mask;
}

/**
 * The terms worth looking for: every title and alias at least
 * `MIN_MENTION_LENGTH` long that names exactly one note. A title two notes
 * share — "Arquitectura" in three projects — cannot say which one is meant,
 * so it is left out rather than guessed.
 */
export function mentionTerms(candidates: readonly MentionCandidate[]): MentionTerm[] {
  const byFolded = new Map<string, { term: string; targets: Set<string> }>();
  for (const c of candidates) {
    const names = [c.title, ...(c.aliases ?? [])].filter((n): n is string => typeof n === 'string');
    for (const name of names) {
      const term = name.trim();
      const key = foldForMatch(term);
      if (key.length < MIN_MENTION_LENGTH) continue;
      const entry = byFolded.get(key) ?? { term, targets: new Set<string>() };
      entry.targets.add(c.target);
      byFolded.set(key, entry);
    }
  }
  const out: MentionTerm[] = [];
  for (const { term, targets } of byFolded.values()) {
    if (targets.size === 1) out.push({ target: [...targets][0]!, term });
  }
  return out;
}

/** Every unlinked mention of any of `terms` in `body`, in body order. */
export function findMentions(body: string, terms: readonly MentionTerm[]): Mention[] {
  if (terms.length === 0 || body.length === 0) return [];
  const { folded, origin } = fold(body);
  const taken = blockedMask(body);

  const ordered = terms
    .map((t) => ({ ...t, key: foldForMatch(t.term.trim()) }))
    .filter((t) => t.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);

  const found: Mention[] = [];
  for (const t of ordered) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(t.key, from);
      if (at === -1) break;
      from = at + 1;
      const last = at + t.key.length - 1;
      const before = at > 0 ? folded[at - 1]! : '';
      const after = last + 1 < folded.length ? folded[last + 1]! : '';
      if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;

      const start = origin[at]!;
      const end = origin[last]! + 1;
      let blocked = false;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      taken.fill(1, start, end);
      found.push({ target: t.target, term: t.term, start, end, text: body.slice(start, end) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A line of context around a mention, whitespace collapsed. */
export function mentionSnippet(body: string, mention: Pick<Mention, 'start' | 'end'>, radius = 40): string {
  const from = Math.max(0, mention.start - radius);
  const to = Math.min(body.length, mention.end + radius);
  const text = body.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${text}${to < body.length ? '…' : ''}`;
}

/**
 * Turn every unlinked mention of `target` into `[[linkTarget|text]]`, keeping
 * the text exactly as the body wrote it. A match that would break the wikilink
 * syntax (a `]` or `|` in the text) is left alone.
 *
 * `terms` is every term in the vault, not just the target's: "Atlas" inside
 * "Visión — Atlas" belongs to the longer title, and only matching against all
 * of them lets it lose that overlap instead of being linked out of the middle.
 */
export function linkMentions(
  body: string,
  target: string,
  linkTarget: string,
  terms: readonly MentionTerm[],
): { body: string; linked: number } {
  const mentions = findMentions(body, terms).filter(
    (m) => m.target === target && !/[\]|]/.test(m.text),
  );
  let out = body;
  for (const m of [...mentions].reverse()) {
    out = `${out.slice(0, m.start)}[[${linkTarget}|${m.text}]]${out.slice(m.end)}`;
  }
  return { body: out, linked: mentions.length };
}
