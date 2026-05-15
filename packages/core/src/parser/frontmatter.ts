// Frontmatter extraction via gray-matter.
// Malformed YAML is recoverable: we return an empty frontmatter object and the
// raw body unchanged. We never throw on parse errors here — the caller decides
// what to do with the unresolved state.

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
    const data = (parsed.data ?? {}) as Frontmatter;
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
