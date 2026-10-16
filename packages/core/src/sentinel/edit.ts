// Sentinel's pen: change a note by saying what changes, not by sending it back
// whole.
//
// Rewriting a note to add one line meant reading all of it and generating all
// of it again — for an assistant, thousands of tokens of output to change ten,
// which is most of what made a simple edit slow. An edit names an anchor (a
// passage, a section heading) and what to put there; the rest of the note is
// never touched, so it cannot be mangled in transit either.
//
// Every anchor must be unambiguous. A passage that is not there, or is there
// twice, refuses the whole edit with a message saying which and why — guessing
// where an assistant meant to write is how text lands in the wrong place
// silently. Headings inside fenced code are not sections: a `# comment` in a
// shell block is not where anyone meant to append.
//
// A note saved from Windows keeps its CRLF line breaks. Edits are matched and
// applied on LF — what an assistant sends — and the result is written back with
// the note's own line breaks, so neither a heading nor a passage is missed for
// a stray `\r`, and no note ends up with two kinds of line break.
//
// Pure string logic, no store: what goes in is a note's frontmatter and body,
// what comes out is the new pair.

import { buildCodeMask } from '../parser/code-mask.js';
import type { Frontmatter } from '../types.js';

/** Edits accepted in one call, at most. */
export const MAX_EDITS = 50;

export type NoteEdit =
  /** Replace the one occurrence of `find` in the body. An empty `replace` deletes it. */
  | { op: 'replace'; find: string; replace: string }
  /** Add `text` after the last line of the body, or of `section`. */
  | { op: 'append'; text: string; section?: string }
  /** Add `text` before the first line of the body, or right under `section`'s heading. */
  | { op: 'prepend'; text: string; section?: string }
  /** Merge keys into the frontmatter; a `null` value removes the key. */
  | { op: 'set_frontmatter'; values: Record<string, unknown> };

/** An edit that cannot be applied as written. Its message is meant for whoever sent it. */
export class NoteEditError extends Error {
  override readonly name = 'NoteEditError';
}

export interface Section {
  /** The heading text, without its `#` marks. */
  heading: string;
  level: number;
  /** Line index of the heading. */
  line: number;
  /** Line index where the section ends (exclusive): the next heading of the same or a higher level. */
  end: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** The ATX headings of a body, in order, skipping any inside fenced code. Lines count on LF. */
export function listSections(source: string): Section[] {
  const body = toLf(source);
  const mask = buildCodeMask(body);
  const lines = body.split('\n');
  const found: Array<Omit<Section, 'end'>> = [];
  let offset = 0;
  lines.forEach((text, line) => {
    const m = mask[offset] ? null : HEADING.exec(text);
    if (m) found.push({ heading: (m[2] ?? '').trim(), level: m[1]!.length, line });
    offset += text.length + 1;
  });
  return found.map((s, i) => {
    const next = found.slice(i + 1).find((o) => o.level <= s.level);
    return { ...s, end: next ? next.line : lines.length };
  });
}

/** The headings of a body, as `## Title`: what an assistant names a section by. */
export function outline(body: string): string[] {
  return listSections(body).map((s) => `${'#'.repeat(s.level)} ${s.heading}`);
}

/**
 * Apply edits in order, each to the result of the one before. Throws
 * `NoteEditError` on the first that cannot apply, and nothing is changed: the
 * caller writes only what this returns.
 */
export function applyEdits(
  note: { frontmatter: Frontmatter; body: string },
  edits: readonly NoteEdit[],
): { frontmatter: Frontmatter; body: string } {
  if (edits.length > MAX_EDITS) {
    throw new NoteEditError(`at most ${MAX_EDITS} edits per call; got ${edits.length}`);
  }
  const crlf = note.body.includes('\r\n');
  let { frontmatter } = note;
  let body = toLf(note.body);
  edits.forEach((edit, i) => {
    const where = edits.length > 1 ? ` (edit ${i + 1})` : '';
    try {
      if (edit.op === 'set_frontmatter') frontmatter = mergeFrontmatter(frontmatter, edit.values);
      else if (edit.op === 'replace') {
        body = replaceOnce(body, toLf(edit.find), toLf(edit.replace));
      } else body = insert(body, toLf(edit.text), edit.op, edit.section);
    } catch (err) {
      if (err instanceof NoteEditError) throw new NoteEditError(`${err.message}${where}`);
      throw err;
    }
  });
  return { frontmatter, body: crlf ? body.replace(/\n/g, '\r\n') : body };
}

const toLf = (text: string) => text.replace(/\r\n/g, '\n');

function replaceOnce(body: string, find: string, replacement: string): string {
  if (find === '') throw new NoteEditError('`find` is empty');
  const first = body.indexOf(find);
  if (first === -1) {
    throw new NoteEditError(
      'the text to replace is not in the note body; it must match exactly, spaces and line breaks ' +
        'included (to change the frontmatter, use set_frontmatter)',
    );
  }
  let count = 1;
  for (let at = body.indexOf(find, first + 1); at !== -1; at = body.indexOf(find, at + 1)) count++;
  if (count > 1) {
    throw new NoteEditError(
      `the text to replace appears ${count} times; include more of the surrounding text so it names one place`,
    );
  }
  return body.slice(0, first) + replacement + body.slice(first + find.length);
}

function insert(
  body: string,
  text: string,
  op: 'append' | 'prepend',
  sectionName: string | undefined,
): string {
  if (text.trim() === '') throw new NoteEditError(`\`${op}\` has no text to add`);
  const lines = body.split('\n');
  // Trailing line breaks are dropped, except that text ending in an empty line
  // keeps one: that is how a prepend stays a paragraph of its own instead of
  // running into the line it lands on.
  const added = text.replace(/\n+$/, (breaks) => (breaks.length > 1 ? '\n' : '')).split('\n');
  const range = sectionName === undefined ? undefined : findSection(body, sectionName);

  let at: number;
  if (op === 'prepend') {
    at = range ? range.line + 1 : 0;
  } else {
    // After the last line with text in it, so the blank line that separates a
    // section from the next heading stays where it was.
    const start = range ? range.line + 1 : 0;
    const end = range ? range.end : lines.length;
    at = start;
    for (let i = end - 1; i >= start; i--) {
      if (lines[i]!.trim() !== '') {
        at = i + 1;
        break;
      }
    }
  }
  lines.splice(at, 0, ...added);
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

function findSection(body: string, name: string): Section {
  const wanted = headingKey(name.replace(/^ {0,3}#{1,6}[ \t]+/, ''));
  const sections = listSections(body);
  const matches = sections.filter((s) => headingKey(s.heading) === wanted);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new NoteEditError(
      `the note has ${matches.length} sections called "${name}"; use a replace edit on the text around the one you mean`,
    );
  }
  const known = sections.map((s) => `"${s.heading}"`).join(', ');
  throw new NoteEditError(
    `the note has no section "${name}"` +
      (known ? `; its sections are ${known}` : '; it has no headings'),
  );
}

const headingKey = (heading: string) => heading.trim().toLocaleLowerCase();

function mergeFrontmatter(current: Frontmatter, values: Record<string, unknown>): Frontmatter {
  // Built from entries rather than assigned key by key: `next['__proto__'] = v`
  // would set the object's prototype instead of a key called `__proto__`.
  const merged = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(values)) {
    if (value === null) merged.delete(key);
    else merged.set(key, value);
  }
  return Object.fromEntries(merged) as Frontmatter;
}
