// Top-level markdown parser.
// Reads a raw file body and returns a `ParsedNote` with everything BrainStack
// needs to index: frontmatter, normalised title, derived links and tags, and
// a content checksum used for idempotent re-indexing.

import { createHash } from 'node:crypto';

import type { Frontmatter, ParsedNote } from '../types.js';

import { buildCodeMask } from './code-mask.js';
import { extractFacets } from './facets.js';
import { extractFrontmatter } from './frontmatter.js';
import { extractTags } from './tags.js';
import { extractLinks } from './wikilinks.js';

export interface ParseNoteOptions {
  /** Optional override for the note path (forward-slash, relative to NOTES_DIR). */
  path?: string;
}

const H1_RE = /^[ \t]*#\s+(.+?)\s*$/m;

function deriveTitle(path: string, frontmatterTitle: unknown, body: string): string {
  if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim() !== '') {
    return frontmatterTitle.trim();
  }
  const h1 = H1_RE.exec(body);
  if (h1 && h1[1]) return h1[1].trim();

  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/**
 * Covers the frontmatter as well as the body. Hashing the body alone made an
 * edit that only touched `tags` or `technologies` look like no change at all:
 * the store kept the old `updated_at`, so the note never rose in any
 * most-recent list and the checksum handed to clients stayed the same.
 */
function checksumOf(frontmatter: Frontmatter, body: string): string {
  return createHash('sha256')
    .update(JSON.stringify(frontmatter), 'utf8')
    .update('\n---\n', 'utf8')
    .update(body, 'utf8')
    .digest('hex');
}

/** Parse a raw markdown file. The `path` field defaults to `""` if not given. */
export function parseNote(raw: string, options: ParseNoteOptions = {}): ParsedNote {
  const path = options.path ?? '';
  const { frontmatter, body } = extractFrontmatter(raw);
  const codeMask = buildCodeMask(body);

  const links = extractLinks(body, codeMask);
  const fmTags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
    : typeof frontmatter.tags === 'string'
      ? [frontmatter.tags]
      : [];
  const bodyTags = extractTags(body, codeMask);

  const tags = uniqueOrdered([...fmTags, ...bodyTags]);
  const facets = extractFacets(frontmatter);
  const title = deriveTitle(path, frontmatter.title, body);
  const checksum = checksumOf(frontmatter, body);

  return {
    path,
    title,
    frontmatter,
    body,
    checksum,
    links,
    tags,
    facets,
  };
}

function uniqueOrdered<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export { extractFrontmatter } from './frontmatter.js';
export { extractLinks } from './wikilinks.js';
export { extractTags } from './tags.js';
export { extractFacets, FACET_SKIP_KEYS } from './facets.js';
export { buildCodeMask } from './code-mask.js';
