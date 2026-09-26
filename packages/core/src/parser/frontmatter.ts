// Frontmatter extraction via gray-matter.
// Malformed YAML is recoverable: we return an empty frontmatter object and the
// raw body unchanged. We never throw on parse errors here — the caller decides
// what to do with the unresolved state.
//
// YAML reads an unquoted `created: 2026-09-14` as a timestamp, so gray-matter
// hands back a `Date`. Left as one, it reached the facets table as
// `JSON.stringify(date)` — a quoted ISO string — and the JSONB column as a
// full `2026-09-14T00:00:00.000Z`, so the same day showed up as three
// different values depending on how the note had been written. Dates are
// turned back into the text their author meant before anything else sees them.

import matter from 'gray-matter';

import type { Frontmatter } from '../types.js';

export interface FrontmatterResult {
  frontmatter: Frontmatter;
  body: string;
  /** True if a frontmatter block was present (regardless of well-formedness). */
  hadFrontmatter: boolean;
  /** True if the frontmatter block was present but failed to parse. */
  malformed: boolean;
}

const FRONTMATTER_FENCE = /^---\r?\n/;

export function extractFrontmatter(raw: string): FrontmatterResult {
  const hadFrontmatter = FRONTMATTER_FENCE.test(raw);
  if (!hadFrontmatter) {
    return { frontmatter: {}, body: raw, hadFrontmatter: false, malformed: false };
  }

  try {
    const parsed = matter(raw);
    // A copy, never the object itself: gray-matter caches parses by input
    // string, and mutating its result would leak into the next caller's.
    const data = normalizeDates(parsed.data ?? {}) as Frontmatter;
    return {
      frontmatter: data,
      body: parsed.content,
      hadFrontmatter: true,
      malformed: false,
    };
  } catch {
    return {
      frontmatter: {},
      body: raw,
      hadFrontmatter: true,
      malformed: true,
    };
  }
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
