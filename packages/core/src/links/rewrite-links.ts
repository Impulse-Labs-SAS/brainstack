// Bulk wikilink/embed rewriter used when paths move or rename.
// Honors the parser's code mask so wikilinks inside fenced or inline code are
// left untouched. Reuses `buildCodeMask` from the parser to stay consistent
// with how the indexer interprets the body.

import { buildCodeMask, isMasked } from '../parser/code-mask.js';

const WIKILINK_RE = /(!)?\[\[([^\]\n]+)\]\]/g;

export interface LinkRewriteMapping {
  /**
   * Old posix path relative to root.
   * - Notes: include the `.md` extension.
   * - Attachments: include the full file extension (`.pdf`, `.png`, …).
   */
  from: string;
  /** New posix path, same conventions as `from`. */
  to: string;
}

export interface RewriteResult {
  /** Posix paths whose body was modified. */
  filesChanged: string[];
}

/**
 * Where the bodies to rewrite come from. Injected rather than reached for
 * directly, because the notes used to live on disk and now live in Postgres —
 * the rewriting itself never cared which.
 */
export interface NoteBodySource {
  /** Every note path in scope. */
  list(): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  write(path: string, body: string): Promise<void>;
}

function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p;
}

function basenameNoExt(p: string): string {
  const last = p.split('/').pop() ?? p;
  return stripMd(last);
}

function isNoteMapping(m: LinkRewriteMapping): boolean {
  return m.from.toLowerCase().endsWith('.md');
}

/**
 * Decide how a single wikilink target should be rewritten under `mapping`.
 * Returns the new target text, or `null` if the mapping doesn't apply.
 *
 * Note moves match when the wikilink references the note by:
 *  - exact full path (`Zuno/Pricing` or `Zuno/Pricing.md`), or
 *  - bare basename (`Pricing`) — only when the basename actually changed,
 *    since Obsidian resolves the bare form by stem; if only the folder moved,
 *    the link still resolves and we leave it alone.
 *
 * Attachment moves require an exact path match (basename-only embeds for
 * attachments are too ambiguous to rewrite safely).
 */
function applyMapping(rawTarget: string, mapping: LinkRewriteMapping): string | null {
  const target = rawTarget.trim();

  if (isNoteMapping(mapping)) {
    const fromNoExt = stripMd(mapping.from);
    const toNoExt = stripMd(mapping.to);

    if (target === mapping.from) return mapping.to;
    if (target === fromNoExt) return toNoExt;

    if (!target.includes('/')) {
      const fromBase = basenameNoExt(mapping.from);
      const toBase = basenameNoExt(mapping.to);
      if (target === fromBase && fromBase !== toBase) return toBase;
    }
    return null;
  }

  if (target === mapping.from) return mapping.to;
  return null;
}

function rewriteBody(
  body: string,
  mappings: readonly LinkRewriteMapping[],
): { body: string; changed: boolean } {
  if (mappings.length === 0) return { body, changed: false };

  const mask = buildCodeMask(body);
  let changed = false;

  const next = body.replace(
    WIKILINK_RE,
    (full: string, bang: string | undefined, inner: string, offset: number) => {
      if (isMasked(mask, offset)) return full;

      let working = inner;
      let alias: string | null = null;
      const pipeIdx = working.indexOf('|');
      if (pipeIdx !== -1) {
        alias = working.slice(pipeIdx + 1);
        working = working.slice(0, pipeIdx);
      }

      let section: string | null = null;
      const hashIdx = working.indexOf('#');
      if (hashIdx !== -1) {
        section = working.slice(hashIdx + 1);
        working = working.slice(0, hashIdx);
      }

      const target = working.trim();
      if (target === '') return full;

      for (const m of mappings) {
        const replacement = applyMapping(target, m);
        if (replacement !== null) {
          changed = true;
          const rebuilt =
            replacement +
            (section !== null ? `#${section}` : '') +
            (alias !== null ? `|${alias}` : '');
          return `${bang ?? ''}[[${rebuilt}]]`;
        }
      }
      return full;
    },
  );

  return { body: next, changed };
}

/**
 * Rewrite wikilinks/embeds across every note the source lists, according to the
 * given mappings. Use it after a move so references do not go stale.
 */
export async function rewriteLinkTargets(
  notes: NoteBodySource,
  mappings: readonly LinkRewriteMapping[],
): Promise<RewriteResult> {
  if (mappings.length === 0) return { filesChanged: [] };

  const paths = await notes.list();
  const filesChanged: string[] = [];

  for (const path of paths) {
    const { body, changed } = rewriteBody(await notes.read(path), mappings);
    if (changed) {
      await notes.write(path, body);
      filesChanged.push(path);
    }
  }

  return { filesChanged };
}

export { rewriteBody as _rewriteBodyForTest };
