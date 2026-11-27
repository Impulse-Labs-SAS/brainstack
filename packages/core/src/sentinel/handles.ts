// People named in a note with `@username`, and the usernames they are named by.
//
// Not to be confused with the title mentions in `links/mentions.ts`, where a
// note's text names another *note* without linking it. These name a *person*:
// writing `@ana` in a note is how its writer tells Ana to look at it, and Ana's
// assistant passes that on the next time she uses it.
//
// What counts as a mention, what a username may look like and which mentions a
// save added are questions about the text alone, so they live here; who the
// username belongs to and whether they may read the note is the server's.

import { buildCodeMask } from '../parser/code-mask.js';

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 30;

/**
 * What a username may be: lowercase letters, digits, `_`, `.` and `-`,
 * starting and ending with a letter or digit. Narrow on purpose — it has to be
 * typed after an `@` in plain text and found there again unambiguously.
 */
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/;

/** Why a username was refused, in words meant for the person choosing it. */
export const USERNAME_RULES =
  `${USERNAME_MIN} to ${USERNAME_MAX} characters: lowercase letters, digits, "_", "." or "-", ` +
  'starting and ending with a letter or digit';

/**
 * The username `input` stands for, or null when it cannot be one.
 * A leading `@` and surrounding spaces are dropped and letters lowercased, so
 * "@Ana" and "ana" are the same name.
 */
export function normalizeUsername(input: string): string | null {
  const name = input.trim().replace(/^@/, '').toLowerCase();
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return null;
  return USERNAME_RE.test(name) ? name : null;
}

/**
 * A username to offer someone who has none, made from their email's local
 * part (or any other text): accents folded, everything else that may not
 * appear in one dropped. Null when nothing usable is left.
 */
export function suggestUsername(from: string): string | null {
  const local = (from.split('@')[0] ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, USERNAME_MAX)
    .replace(/[^a-z0-9]+$/, '');
  return normalizeUsername(local);
}

/**
 * `@name` where the `@` starts a word: not inside an email address
 * (`ana@x.com`), a URL path (`/@ana`) or a longer token. The name is matched
 * greedily and trailing punctuation trimmed afterwards, so "@ana." at the end
 * of a sentence is Ana.
 */
const MENTION_RE = /(^|[^\p{L}\p{N}_.@/\\-])@([a-z0-9][a-z0-9_.-]*)/giu;

/** Characters of the line kept around a mention, to say what it was about. */
export const MENTION_SNIPPET_CHARS = 200;

export interface HandleMention {
  /** The username, normalized. */
  username: string;
  /** The line it was written on, trimmed and cut to `MENTION_SNIPPET_CHARS`. */
  snippet: string;
}

/**
 * Every `@username` in a note's body, first occurrence of each, in order.
 * Code spans and fences are skipped: `@decorator` in a snippet names nobody.
 */
export function findHandleMentions(body: string): HandleMention[] {
  const mask = buildCodeMask(body);
  const seen = new Map<string, HandleMention>();
  for (const match of body.matchAll(MENTION_RE)) {
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (mask[at]) continue;
    const username = normalizeUsername((match[2] ?? '').replace(/[_.-]+$/, ''));
    if (!username || seen.has(username)) continue;
    seen.set(username, { username, snippet: lineAround(body, at) });
  }
  return [...seen.values()];
}

/**
 * The people a save newly names: mentioned in `after` and not in `before`.
 *
 * By name, not by count — editing a paragraph that already said `@ana`, or
 * mentioning her a second time, does not tell her again. `before` is null for
 * a note that did not exist.
 */
export function addedHandleMentions(before: string | null, after: string): HandleMention[] {
  const had = new Set(before === null ? [] : findHandleMentions(before).map((m) => m.username));
  return findHandleMentions(after).filter((m) => !had.has(m.username));
}

function lineAround(body: string, at: number): string {
  const start = body.lastIndexOf('\n', at - 1) + 1;
  const end = body.indexOf('\n', at);
  const line = body.slice(start, end === -1 ? undefined : end);
  if (line.trim().length <= MENTION_SNIPPET_CHARS) return line.trim();
  // A long line is cut around the mention, so the part that names the person
  // is the part kept.
  const from = Math.max(0, at - start - MENTION_SNIPPET_CHARS / 2);
  const cut = line.slice(from, from + MENTION_SNIPPET_CHARS - 2).trim();
  return `${from > 0 ? '…' : ''}${cut}${from + MENTION_SNIPPET_CHARS - 2 < line.length ? '…' : ''}`;
}
