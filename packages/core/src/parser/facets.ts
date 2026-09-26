// Generic frontmatter facet extraction. A facet is any `(key, value)` pair
// lifted from a frontmatter field other than `tags`, which already has its
// own pipeline (parser/tags.ts). There is no allowlist of recognised keys —
// `technologies: [nextjs, drizzle]`, `resources: [{url, label}]`,
// `status: decidido`, `aliases: [Zuno]` all fall out of the same rule, which
// is what lets faceted browsing and "notes related by shared technology"
// work on whatever fields a vault actually uses, with nothing to register
// first.
//
// Only `tags` is skipped, not a longer denylist: the whole point of "generic,
// not hardcoded" would be undermined by hand-picking which other fields
// count, and this table is accepted to grow at the same "fine at
// personal-brain scale" the rest of the derived tables already run at.

import type { Frontmatter, ParsedFacet } from '../types.js';

import { dateToText } from './frontmatter.js';

export const FACET_SKIP_KEYS = new Set(['tags']);

/** Fields checked in order for a display string when an entry is an object. */
const DISPLAY_FIELDS = ['value', 'name', 'title', 'url'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayValueFor(obj: Record<string, unknown>): string {
  for (const field of DISPLAY_FIELDS) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/** One entry (an array element, or the field itself when it isn't an array). */
function facetFromEntry(entry: unknown): { value: string; data: Record<string, unknown> | null } | null {
  // extractFrontmatter already turns dates into text; this covers a caller
  // handing in frontmatter straight from gray-matter. Checked before
  // isPlainObject, which a Date would otherwise pass as an object with no
  // display field — and get indexed as its JSON, quotes included.
  if (entry instanceof Date) {
    return { value: dateToText(entry), data: null };
  }
  if (isPlainObject(entry)) {
    return { value: displayValueFor(entry), data: entry };
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed === '' ? null : { value: trimmed, data: null };
  }
  if (typeof entry === 'number' || typeof entry === 'boolean') {
    return { value: String(entry), data: null };
  }
  // null, undefined, functions, nested arrays: nothing meaningful to index.
  return null;
}

/** Extract facets from every frontmatter field except `tags`. */
export function extractFacets(frontmatter: Frontmatter): ParsedFacet[] {
  const out: ParsedFacet[] = [];

  for (const [key, raw] of Object.entries(frontmatter)) {
    if (FACET_SKIP_KEYS.has(key)) continue;
    if (raw === null || raw === undefined) continue;

    const entries = Array.isArray(raw) ? raw : [raw];
    let position = 0;
    for (const entry of entries) {
      const facet = facetFromEntry(entry);
      if (!facet) continue;
      out.push({ key, value: facet.value, data: facet.data, position: position++ });
    }
  }

  return out;
}
