// Tag extraction. Tags look like `#tag` or `#tag/sub/leaf`. They must:
// - Start with `#` preceded by start-of-string or whitespace
// - Not appear inside code spans or code blocks (use the mask)
// - Not be a YAML anchor or a markdown heading (`# heading`)

import { isMasked } from './code-mask.js';

const TAG_CHAR = /[A-Za-z0-9_/-]/;

/** Extract unique tags from a body, in order of first appearance. */
export function extractTags(body: string, codeMask: Uint8Array): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '#') continue;
    if (isMasked(codeMask, i)) continue;

    const prev = i === 0 ? '\n' : body[i - 1];
    if (prev !== undefined && prev !== '\n' && prev !== ' ' && prev !== '\t' && prev !== '(') {
      continue;
    }

    let j = i + 1;
    while (j < body.length && TAG_CHAR.test(body[j] ?? '')) j++;
    if (j === i + 1) continue;

    const tag = body.slice(i + 1, j);

    // Skip headings: a `#` followed by space (e.g. `# Heading`). Already handled
    // because space breaks `TAG_CHAR`, so a heading produces an empty tag and
    // we continue. But also reject tags that are purely numeric (rare false
    // positives in things like `#123` issue refs).
    if (/^\d+$/.test(tag)) {
      i = j - 1;
      continue;
    }

    // Reject tags that start or end with a slash.
    if (tag.startsWith('/') || tag.endsWith('/')) {
      i = j - 1;
      continue;
    }

    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
    i = j - 1;
  }

  return out;
}
