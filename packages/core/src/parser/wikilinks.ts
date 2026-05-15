// Wikilink, embed, and markdown-link extraction.
// We operate directly on the markdown body string rather than the mdast tree
// because Obsidian-flavored wikilinks aren't part of CommonMark. The code mask
// from `code-mask.ts` ensures we skip anything inside backticks or fences.

import type { ParsedLink } from '../types.js';

import { isMasked } from './code-mask.js';

const WIKILINK_RE = /(!)?\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK_RE = /(!)?\[([^\]\n]*)\]\(([^)\s][^)\n]*)\)/g;
const EXTERNAL_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Splits a wikilink body into `target | section | alias`. */
function splitWikilinkBody(body: string): {
  target: string;
  section: string | null;
  alias: string | null;
} {
  // Trim outer whitespace but preserve internal formatting.
  let working = body.trim();

  // Split off alias first (`X|alias`).
  let alias: string | null = null;
  const pipeIdx = working.indexOf('|');
  if (pipeIdx !== -1) {
    alias = working.slice(pipeIdx + 1).trim();
    working = working.slice(0, pipeIdx).trim();
  }

  // Then section (`X#Section`).
  let section: string | null = null;
  const hashIdx = working.indexOf('#');
  if (hashIdx !== -1) {
    section = working.slice(hashIdx + 1).trim();
    working = working.slice(0, hashIdx).trim();
  }

  return { target: working, section: section || null, alias: alias || null };
}

function classifyAsEmbed(target: string): 'note' | 'attachment' {
  // No file extension → note. Anything with an extension that isn't `.md` → attachment.
  const dot = target.lastIndexOf('.');
  if (dot === -1) return 'note';
  const ext = target.slice(dot + 1).toLowerCase();
  return ext === 'md' || ext === '' ? 'note' : 'attachment';
}

/** Extract all wikilinks, embeds, and markdown links from a markdown body. */
export function extractLinks(body: string, codeMask: Uint8Array): ParsedLink[] {
  const links: ParsedLink[] = [];

  // Wikilinks and wiki-embeds.
  for (const match of body.matchAll(WIKILINK_RE)) {
    const position = match.index ?? 0;
    if (isMasked(codeMask, position)) continue;

    const isEmbed = match[1] === '!';
    const inner = match[2] ?? '';
    const { target, section, alias } = splitWikilinkBody(inner);
    if (target === '') continue;

    links.push({
      rawTarget: target,
      section,
      alias,
      kind: isEmbed ? 'embed' : 'wikilink',
      isEmbed,
      position,
    });

    // Re-classify embeds with extensions as embeds-of-attachment-or-note: the
    // resolver will figure it out later; here we just keep the classification
    // for completeness.
    void classifyAsEmbed;
  }

  // Markdown-style links: `[text](path)` and `![alt](path)`.
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const position = match.index ?? 0;
    if (isMasked(codeMask, position)) continue;

    const isEmbed = match[1] === '!';
    const alias = (match[2] ?? '').trim();
    const target = (match[3] ?? '').trim();
    if (target === '') continue;
    if (EXTERNAL_URL_RE.test(target)) continue; // skip http(s), mailto:, etc.

    // Drop the title attribute if present (`(path "title")`).
    const cleanTarget = target.split(/\s+/)[0] ?? '';
    if (cleanTarget === '') continue;

    links.push({
      rawTarget: cleanTarget,
      section: null,
      alias: alias || null,
      kind: 'markdown',
      isEmbed,
      position,
    });
  }

  links.sort((a, b) => a.position - b.position);
  return links;
}
