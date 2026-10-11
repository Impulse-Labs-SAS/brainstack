// Frontmatter: the one place a note's YAML block is split off, parsed and
// written back.
//
// No gray-matter. It ships an engine that runs a block opened with `---js`
// through `eval()`, and its `stringify(body, data)` re-parses the *body* as a
// fresh document before writing it out — so a note whose body began with
// `---js` executed on the server whenever it was saved or moved, and one whose
// body began with an ordinary `---` rule had its first paragraph swallowed
// into the frontmatter. Splitting the block by hand and handing it to js-yaml's
// default schema (no code, no custom tags) closes both: there is only YAML,
// and the body is never parsed as anything but text. Nothing else in the repo
// may import gray-matter; the lint config enforces it.
//
// Malformed YAML is recoverable: we return an empty frontmatter object and the
// raw body unchanged. We never throw on parse errors here — the caller decides
// what to do with the unresolved state.
//
// YAML reads an unquoted `created: 2026-09-14` as a timestamp, so the parser
// hands back a `Date`. Left as one, it reached the facets table as
// `JSON.stringify(date)` — a quoted ISO string — and the JSONB column as a
// full `2026-09-14T00:00:00.000Z`, so the same day showed up as three
// different values depending on how the note had been written. Dates are
// turned back into the text their author meant before anything else sees them.

import yaml from 'js-yaml';

import type { Frontmatter } from '../types.js';

export interface FrontmatterResult {
  frontmatter: Frontmatter;
  body: string;
  /** True if a frontmatter block was present (regardless of well-formedness). */
  hadFrontmatter: boolean;
  /** True if the frontmatter block was present but failed to parse. */
  malformed: boolean;
}

/** The opening fence: `---` alone on the first line. `---js` is not one. */
const OPEN_FENCE = /^---[ \t]*\r?\n/;
/**
 * The closing fence: `---` alone on a line, at the very start of what follows
 * the opening one (an empty block) or after a line break.
 */
const CLOSE_FENCE = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;

export function extractFrontmatter(raw: string): FrontmatterResult {
  const open = OPEN_FENCE.exec(raw);
  if (!open) {
    return { frontmatter: {}, body: raw, hadFrontmatter: false, malformed: false };
  }

  const rest = raw.slice(open[0].length);
  const close = CLOSE_FENCE.exec(rest);
  if (!close) {
    // An opening rule with nothing closing it is a horizontal rule, not a
    // frontmatter block; reading the whole note as YAML is what lost text.
    return { frontmatter: {}, body: raw, hadFrontmatter: true, malformed: true };
  }

  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);

  let data: unknown;
  try {
    data = yaml.load(block, { schema: yaml.DEFAULT_SCHEMA, json: true });
  } catch {
    return { frontmatter: {}, body: raw, hadFrontmatter: true, malformed: true };
  }

  // A block of comments or nothing at all is an empty frontmatter, not an
  // error. Anything that is not a mapping (a bare string, a list) cannot be
  // frontmatter, and keeping the text as body loses nothing.
  if (data === undefined || data === null) {
    return { frontmatter: {}, body, hadFrontmatter: true, malformed: false };
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { frontmatter: {}, body: raw, hadFrontmatter: true, malformed: true };
  }

  return {
    frontmatter: normalizeDates(data) as Frontmatter,
    body,
    hadFrontmatter: true,
    malformed: false,
  };
}

/**
 * Write a note back as markdown: the frontmatter as a YAML block, then the
 * body exactly as given. The body is never parsed, so whatever it starts with
 * — a `---` rule, a `---js` line, a fenced YAML example — comes back intact.
 *
 * An empty frontmatter writes no block at all. Values YAML cannot represent
 * (`undefined`, functions) are dropped rather than failing the write.
 */
export function serializeNote(frontmatter: Frontmatter | null | undefined, body: string): string {
  const data = frontmatter ?? {};
  if (Object.keys(data).length === 0) return body;
  const block = yaml
    .dump(data, { schema: yaml.DEFAULT_SCHEMA, skipInvalid: true, noRefs: true, lineWidth: -1 })
    .trim();
  if (block === '{}' || block === '') return body;
  return `---\n${block}\n---\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/**
 * A date written without a time (`2026-09-14`) parses to midnight UTC; give it
 * back as the day. Anything with a real time keeps the full ISO timestamp.
 */
export function dateToText(date: Date): string {
  if (Number.isNaN(date.getTime())) return String(date);
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

function normalizeDates(value: unknown): unknown {
  if (value instanceof Date) return dateToText(value);
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeDates(entry)]),
    );
  }
  return value;
}
